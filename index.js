require('dotenv').config()
const { Telegraf } = require('telegraf')
const cron = require('node-cron')
const STRINGS = require('./strings')

// ---- MongoDB integration ----
const {
  initDb,
  addMessage,
  generateRandom,
  addLearningGroup,
  removeLearningGroup,
  loadLearningGroups
} = require('./markov')

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

    // اگر Telegram گفت Too Many Requests، به retry_after احترام می‌ذاریم
    const retryAfter =
      (err.parameters && err.parameters.retry_after) ||
      (err.on && err.on.parameters && err.on.parameters.retry_after)

    if (retryAfter && Number.isFinite(retryAfter)) {
      const delayMs = (retryAfter + 1) * 1000
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  isSending = false
}

// process up to ~1 message per second (safer rate)
setInterval(processQueue, 1000)

function safeSend(chatId, text, replyTo = null) {
  sendQueue.push({ chatId, text, replyTo })
}

const knownGroups = new Set()
const lastMessageTime = new Map()
const messageCountSinceRandom = new Map()
const lastSent = new Map() // anti-duplicate buffer
const learningGroups = new Set() // groups allowed for learning

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set in environment variables')
}

const OWNER_ID = Number(process.env.OWNER_ID)
const bot = new Telegraf(process.env.BOT_TOKEN)

// Global error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err.message, 'update type:', ctx.updateType)
})

// ---- Learning control commands ----
bot.command(STRINGS.TRAIN_CMD, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

  learningGroups.add(ctx.chat.id)
  try {
    await addLearningGroup(ctx.chat.id)
  } catch (e) {
    console.error('failed to persist learning group:', e.message)
  }
  safeSend(ctx.chat.id, STRINGS.TRAIN_ENABLED)
})

bot.command(STRINGS.UNTRAIN_CMD, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

  learningGroups.delete(ctx.chat.id)
  try {
    await removeLearningGroup(ctx.chat.id)
  } catch (e) {
    console.error('failed to remove learning group:', e.message)
  }
  safeSend(ctx.chat.id, STRINGS.TRAIN_DISABLED)
})

// ---- /markov command ----
bot.command(STRINGS.COMMAND_KEY, async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

  const sentence = await generateNonDuplicate(ctx.chat.id, 25)

  if (!sentence) {
    safeSend(ctx.chat.id, STRINGS.NEED_MORE_DATA)
    return
  }

  safeSend(ctx.chat.id, sentence)
  storeSentence(ctx.chat.id, sentence)
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

    const isLearningGroup = learningGroups.has(chat.id)

    // فقط در گروه‌هایی که برای یادگیری فعال شده‌اند، پیام‌ها را ذخیره و برای رندوم استفاده می‌کنیم
    if (isLearningGroup) {
      if (!text.startsWith('/') && text.trim().length >= 2) {
        await addMessage(chat.id, text)

        // Update last message time for this group
        lastMessageTime.set(chat.id, Date.now())

        const prevCount = messageCountSinceRandom.get(chat.id) || 0
        messageCountSinceRandom.set(chat.id, prevCount + 1)
      }
    }

    const isReplyToBot =
      msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot

    if (isReplyToBot) {
      const sentence = await generateNonDuplicate(chat.id, 25)
      if (!sentence) return

      safeSend(chat.id, sentence, msg.message_id)
      storeSentence(chat.id, sentence)
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

  const sentence = await generateNonDuplicate(randomChatId, 25)
  if (!sentence) return

  try {
    safeSend(randomChatId, sentence)
    storeSentence(randomChatId, sentence)
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
  .then(() => loadLearningGroups())
  .then((ids) => {
    ids.forEach((id) => learningGroups.add(id))
  })
  .then(() => bot.launch())
  .then(() => console.log('🤖 Bot started...'))
  .catch((err) => console.error('Bot failed:', err))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

// ---- Anti-duplicate helpers ----
function isDuplicate(chatId, sentence) {
  const list = lastSent.get(chatId) || []
  return list.includes(sentence)
}

function storeSentence(chatId, sentence) {
  const list = lastSent.get(chatId) || []
  list.push(sentence)
  if (list.length > 10) list.shift() // keep last 10
  lastSent.set(chatId, list)
}

async function generateNonDuplicate(chatId, maxWords) {
  let sentence = ''
  for (let i = 0; i < 3; i++) {
    sentence = await generateRandom(chatId, maxWords)
    if (!sentence) return ''
    if (!isDuplicate(chatId, sentence)) return sentence
  }
  return sentence // fallback even if duplicate
}
