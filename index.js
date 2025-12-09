require('dotenv').config()
const { Telegraf } = require('telegraf')
const fs = require('fs')
const path = require('path')
const { generateRandom } = require('./markov')

// --- Simple send queue to avoid Telegram 429 ---
const sendQueue = []
let isSending = false

async function processQueue() {
  if (isSending || sendQueue.length === 0) return
  isSending = true

  const job = sendQueue.shift() // { chatId, text, replyTo }

  try {
    if (job.replyTo) {
      await bot.telegram.sendMessage(job.chatId, job.text, { reply_to_message_id: job.replyTo })
    } else {
      await bot.telegram.sendMessage(job.chatId, job.text)
    }
  } catch (err) {
    console.error('sendQueue error:', err.message)
  }

  isSending = false
}

setInterval(processQueue, 1000) // process 1 message per second

function safeSend(chatId, text, replyTo = null) {
  sendQueue.push({ chatId, text, replyTo })
}

const knownGroups = new Set()

const bot = new Telegraf(process.env.BOT_TOKEN)

const MESSAGES_FILE = path.join(__dirname, 'data', 'messages.json')

function loadMessages() {
  try {
    const raw = fs.readFileSync(MESSAGES_FILE, 'utf-8')
    const data = JSON.parse(raw)

    // جدید: اگر آبجکت است، یعنی map از chatId به آرایه پیام‌ها
    if (data && !Array.isArray(data) && typeof data === 'object') {
      return data
    }

    // قدیمی: اگر آرایه است، آن را به آبجکت تبدیل می‌کنیم
    const messagesByChat = {}

    if (Array.isArray(data)) {
      for (const item of data) {
        if (!item) continue

        // حالت قدیمیِ per-group: { chatId, text }
        if (typeof item === 'object' && 'chatId' in item && 'text' in item) {
          const key = String(item.chatId)
          if (!messagesByChat[key]) messagesByChat[key] = []
          if (typeof item.text === 'string' && item.text.trim().length > 0) {
            messagesByChat[key].push(item.text)
          }
        }

        // اگر فقط string بود، می‌تونیم یک key خاص براش در نظر بگیریم (اختیاری)
        if (typeof item === 'string') {
          const key = '_legacy'
          if (!messagesByChat[key]) messagesByChat[key] = []
          if (item.trim().length > 0) {
            messagesByChat[key].push(item.trim())
          }
        }
      }
    }

    return messagesByChat
  } catch (e) {
    return {}
  }
}

function saveMessages(messagesByChat) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messagesByChat, null, 2), 'utf-8')
}

function addMessage(chatId, text) {
  const messagesByChat = loadMessages()
  const key = String(chatId)

  if (!messagesByChat[key]) {
    messagesByChat[key] = []
  }

  if (typeof text === 'string' && text.trim().length > 0) {
    messagesByChat[key].push(text)
  }

  saveMessages(messagesByChat)
}

/* 🔹 اول هندلر دستور رو تعریف کن */
bot.command('bitch', async (ctx) => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

  const sentence = generateRandom(ctx.chat.id, 25)

  if (!sentence) {
    safeSend(ctx.chat.id, 'هنوز به یک جنده اختصاصی واسه گروه شما تبدیل نشدم🥲 لطفا در گروه بیشتر کصشر بگین.')
    return
  }

  safeSend(ctx.chat.id, sentence)
})

bot.on('text', async (ctx) => {
  const chat = ctx.chat
  const msg = ctx.message
  const text = msg.text

  if (!text) return

  //  فقط group / supergroup
  if (chat.type === 'group' || chat.type === 'supergroup') {
    // ثبت آی‌دی گروه برای پیام‌های رندوم
    knownGroups.add(chat.id)

    if (text.startsWith('/')) return        // دستورها را نادیده بگیر
    if (text.trim().length < 2) return      // پیام‌های خیلی کوتاه را ول کن

    const from = msg.from.username || msg.from.first_name || 'کاربر'

    // ذخیره پیام مخصوص همین گروه
    addMessage(chat.id, text)

    // اگر به پیام بات ریپلای شده
    const isReplyToBot =
      msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot

    if (isReplyToBot) {
      const sentence = generateRandom(chat.id, 25)
      if (!sentence) return

      // جواب مارکوفی به همون ریپلای
      safeSend(chat.id, sentence, msg.message_id)
    }

    return
  }

  // بقیه‌ی نوع چت‌ها فعلاً نادیده گرفته می‌شوند
})

// هر ۶۰ ثانیه، شاید یه پیام رندوم بفرسته
setInterval(async () => {
  if (knownGroups.size === 0) return

  // با احتمال ۲۰٪ چیزی بگه (برای اینکه اسپم نشه)
  const shouldSpeak = Math.random() < 0.2
  if (!shouldSpeak) return

  const groups = Array.from(knownGroups)
  const randomChatId = groups[Math.floor(Math.random() * groups.length)]

  const sentence = generateRandom(randomChatId, 25)
  if (!sentence) return

  try {
    safeSend(randomChatId, sentence)
  } catch (err) {
    console.error('failed to send random message', err.message)
  }
}, 60 * 1000)

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


bot.launch().then(() => {
  console.log('🤖 Bot started...')
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
