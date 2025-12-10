require('dotenv').config()
const { Telegraf } = require('telegraf')
const cron = require('node-cron')
const STRINGS = require('./strings')

// ---- MongoDB integration ----
const { initDb, addMessage, generateRandom } = require('./markov')

// ---- Queue to avoid 429 ----
const sendQueue = []
let isSending = false

async function processQueue() {
  if (isSending || sendQueue.length === 0) return
  isSending = true

  const job = sendQueue.shift()

  try {
    if (job.replyTo) {
      await bot.telegram.sendMessage(job.chatId, job.text, {
        reply_to_message_id: job.replyTo
      })
    } else {
      await bot.telegram.sendMessage(job.chatId, job.text)
    }
  } catch (err) {
    console.error('sendQueue error:', err.message)
  }

  isSending = false
}

// process up to ~2 messages per second (safe global rate)
setInterval(processQueue, 500)

function safeSend(chatId, text, replyTo = null) {
  sendQueue.push({ chatId, text, replyTo })
}

const knownGroups = new Set()
const lastMessageTime = new Map()
const messageCountSinceRandom = new Map()

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set in environment variables')
}

const bot = new Telegraf(process.env.BOT_TOKEN)

// Global error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err.message, 'update type:', ctx.updateType)
})

// ---- /markov command ----
bot.command('markov', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

  const sentence = await generateRandom(ctx.chat.id, 25)

  if (!sentence) {
    safeSend(ctx.chat.id, STRINGS.NEED_MORE_DATA)
    return
  }

  safeSend(ctx.chat.id, sentence)
})

// ---- On text ----
bot.on('text', async (ctx) => {
  const chat = ctx.chat
  const msg = ctx.message
  const text = msg.text
  if (!text) return

  // نادیده گرفتن تمام پیام‌های ربات‌ها (ولی ادمین ناشناس بات نیست)
  if (msg.from && msg.from.is_bot) {
    return
  }

  if (chat.type === 'group' || chat.type === 'supergroup') {
    knownGroups.add(chat.id)

    if (text.startsWith('/')) return
    if (text.trim().length < 2) return

    await addMessage(chat.id, text)

    // Update last message time for this group
    lastMessageTime.set(chat.id, Date.now())

    const prevCount = messageCountSinceRandom.get(chat.id) || 0
    messageCountSinceRandom.set(chat.id, prevCount + 1)

    const isReplyToBot =
      msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot

    if (isReplyToBot) {
      const sentence = await generateRandom(chat.id, 25)
      if (!sentence) return

      safeSend(chat.id, sentence, msg.message_id)
    }

    return
  }
})

// ---- Random messages ----
setInterval(async () => {
  if (knownGroups.size === 0) return
  const shouldSpeak = Math.random() < 0.2
  if (!shouldSpeak) return

  // Filter out inactive groups (15 minutes = 15 * 60 * 1000) and require >= 10 user messages since last random
  const activeGroups = Array.from(knownGroups).filter((g) => {
    const t = lastMessageTime.get(g)
    if (!t) return false
    if ((Date.now() - t) > 15 * 60 * 1000) return false

    const count = messageCountSinceRandom.get(g) || 0
    return count >= 10
  })

  if (activeGroups.length === 0) return

  const randomChatId = activeGroups[Math.floor(Math.random() * activeGroups.length)]

  // const groups = Array.from(knownGroups)
  // const randomChatId = groups[Math.floor(Math.random() * groups.length)]

  const sentence = await generateRandom(randomChatId, 25)
  if (!sentence) return

  try {
    safeSend(randomChatId, sentence)
    messageCountSinceRandom.set(randomChatId, 0)
  } catch (err) {
    console.error('failed to send random message', err.message)
  }
}, 90 * 1000)

// ---- Daily fixed message at 00:00 Asia/Tehran ----
const DAILY_MESSAGE = STRINGS.DAILY_MESSAGE

cron.schedule(
  '0 0 * * *',
  () => {
    if (knownGroups.size === 0) return

    for (const chatId of knownGroups) {
      safeSend(chatId, DAILY_MESSAGE)
    }
  },
  {
    timezone: 'Asia/Tehran',
  }
)

// ---- HTTP server for Koyeb ----
const http = require('http')
const PORT = process.env.PORT || 3000

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK\n')
  })
  .listen(PORT, () => {
    console.log('HTTP server listening on port', PORT)
  })

// ---- Start bot after DB ----
initDb()
  .then(() => bot.launch())
  .then(() => console.log('🤖 Bot started...'))
  .catch((err) => console.error('Bot failed:', err))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
