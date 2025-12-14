import 'dotenv/config'
import http from 'http'
import cron from 'node-cron'
import { Telegraf } from 'telegraf'

import strings from './src/strings.js'
import {
  BOT_TOKEN,
  OWNER_ID,
  PORT,
  RANDOM_TALK_CHANCE,
  RANDOM_TALK_INTERVAL_MS,
  RANDOM_TALK_ACTIVE_WINDOW_MS,
  RANDOM_TALK_REQUIRED_MESSAGES,
  DAILY_TIMEZONE,
} from './src/config.js'
import {
  generateRandomSentence,
  getCollections,
} from './markov.js'

const defaultDebug = process.env.MARKOV_DEBUG !== '0'
const MAX_BUFFER = 25
const MIN_REPEAT_MS = 10 * 60 * 1000 // 10 minutes

// Prevent storing identical consecutive messages per chat (RAM only)
const lastStoredByChat = new Map()

function createBotState() {
  return {
    knownGroups: new Set(),
    lastMessageTime: new Map(),
    messageCountSinceRandom: new Map(),
    lastSent: new Map(),
    learningGroups: new Set(),
  }
}

function createSendQueue(bot) {
  const sendQueue = []
  let isSending = false

  async function processQueue() {
    if (isSending || sendQueue.length === 0) return
    isSending = true

    const job = sendQueue.shift()

    try {
      if (job.replyTo) {
        await bot.telegram.sendMessage(job.chatId, job.text, {
          reply_to_message_id: job.replyTo,
        })
      } else {
        await bot.telegram.sendMessage(job.chatId, job.text)
      }
    } catch (err) {
      console.error('sendQueue error:', err.message)

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

  setInterval(processQueue, 1000)

  function safeSend(chatId, text, replyTo = null) {
    sendQueue.push({ chatId, text, replyTo })
  }

  return { safeSend }
}

function isDuplicate(lastSent, chatId, sentence) {
  const entries = lastSent.get(chatId) || []
  const now = Date.now()

  return entries.some(
    (e) =>
      e.text === sentence && (!e.timestamp || now - e.timestamp < MIN_REPEAT_MS)
  )
}

function storeSentence(lastSent, chatId, sentence) {
  const entries = lastSent.get(chatId) || []
  entries.push({ text: sentence, timestamp: Date.now() })
  if (entries.length > MAX_BUFFER) entries.shift()
  lastSent.set(chatId, entries)
}

function collapseRepeatedHalves(text) {
  if (typeof text !== 'string') return text
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 6) return text // too short, ignore

  // If the message is exactly two identical halves, keep only the first half.
  // Repeat up to 2 times in case of triple-like patterns that become double after first collapse.
  let current = words
  for (let iter = 0; iter < 2; iter++) {
    if (current.length % 2 !== 0) break
    const half = current.length / 2
    const a = current.slice(0, half).join(' ')
    const b = current.slice(half).join(' ')
    if (a !== b) break
    current = current.slice(0, half)
  }

  return current.join(' ')
}

function normalizePersian(text) {
  return text
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/‌/g, ' ') // ZWNJ to space
    .replace(/ـ+/g, '') // keshide
    .replace(/\s+/g, ' ')
    .trim()
}

function hasTooMuchEmoji(text) {
  const emojiCount = (text.match(/[\p{Emoji}]/gu) || []).length
  return emojiCount > 0 && emojiCount / text.length > 0.5
}

function hasStretchedChars(text) {
  return /(.)\1{3,}/u.test(text) // حرف یا کلمه کشیده
}

async function addMessage(chatId, text) {
  if (typeof text !== 'string') return
  text = normalizePersian(text)

  // If message contains any Latin letters, skip storing (avoid mixing English content)
  if (/[A-Za-z]/.test(text)) return

  // If message contains any kind of link/mention, skip storing entirely
  const hasLink =
    /https?:\/\/\S+/i.test(text) ||
    /www\.\S+/i.test(text) ||
    /\b\S+\.(com|net|org|ir|io|me|app|xyz|info|site|online|shop|top)\b/i.test(text) ||
    /t\.me\/\S+/i.test(text) ||
    /telegram\.me\/\S+/i.test(text) ||
    /@[a-zA-Z0-9_]{3,32}/.test(text)

  if (hasLink) return

  // Too short for learning (short jokes still need some structure)
  if (text.length < 6) return

  // Too long = monologue / rant
  if (text.length > 350) return

  // Emoji spam
  if (hasTooMuchEmoji(text)) return

  // کشیده‌نویسی یا تکرار افراطی
  if (hasStretchedChars(text)) return

  let cleaned = text

  if (!cleaned || cleaned.length < 2) return

  cleaned = collapseRepeatedHalves(cleaned)

  // Skip storing identical consecutive messages for this chat
  const prev = lastStoredByChat.get(chatId)
  if (prev === cleaned) return
  lastStoredByChat.set(chatId, cleaned)

  const { messages } = await getCollections()
  const key = String(chatId)

  await messages.updateOne(
    { chatId: key },
    { $push: { messages: cleaned } },
    { upsert: true }
  )
}

async function addLearningGroup(chatId) {
  const { learningGroups } = await getCollections()
  const key = String(chatId)

  await learningGroups.updateOne(
    { chatId: key },
    { $set: { chatId: key } },
    { upsert: true }
  )
}

async function removeLearningGroup(chatId) {
  const { learningGroups } = await getCollections()
  const key = String(chatId)

  await learningGroups.deleteOne({ chatId: key })
}

async function loadLearningGroups() {
  const { learningGroups } = await getCollections()

  const docs = await learningGroups
    .find({}, { projection: { chatId: 1, _id: 0 } })
    .toArray()

  return docs
    .map((d) => {
      if (!d || !d.chatId) return null
      const n = Number(d.chatId)
      return Number.isNaN(n) ? d.chatId : n
    })
    .filter((v) => v !== null)
}

function registerCommandHandlers(bot, deps) {
  const {
    ownerId,
    strings: botStrings,
    state,
    safeSend,
    generateResponse,
    storeSentenceFn,
    addLearningGroupFn,
    removeLearningGroupFn,
  } = deps

  bot.command(botStrings.TRAIN_CMD, async (ctx) => {
    if (ctx.from.id !== ownerId) return
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

    state.learningGroups.add(ctx.chat.id)
    try {
      await addLearningGroupFn(ctx.chat.id)
    } catch (e) {
      console.error('failed to persist learning group:', e.message)
    }
    safeSend(ctx.chat.id, botStrings.TRAIN_ENABLED)
  })

  bot.command(botStrings.UNTRAIN_CMD, async (ctx) => {
    if (ctx.from.id !== ownerId) return
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

    state.learningGroups.delete(ctx.chat.id)
    try {
      await removeLearningGroupFn(ctx.chat.id)
    } catch (e) {
      console.error('failed to remove learning group:', e.message)
    }
    safeSend(ctx.chat.id, botStrings.TRAIN_DISABLED)
  })

  bot.command(botStrings.TALK_CMD, async (ctx) => {
    if (ctx.from.id !== ownerId) return
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

    const { text } = await generateResponse(ctx.chat.id)

    if (!text) {
      safeSend(ctx.chat.id, botStrings.NEED_MORE_DATA)
      return
    }

    safeSend(ctx.chat.id, text)
    storeSentenceFn(ctx.chat.id, text)
  })
}

function registerTextHandler(bot, deps) {
  const {
    state,
    addMessageFn,
    generateResponse,
    safeSend,
    storeSentenceFn,
  } = deps

  bot.on('text', async (ctx) => {
    const chat = ctx.chat
    const msg = ctx.message
    const text = msg.text
    if (!text) return

    if (msg.from && msg.from.is_bot) {
      return
    }

    if (chat.type === 'group' || chat.type === 'supergroup') {
      state.knownGroups.add(chat.id)

      const isLearningGroup = state.learningGroups.has(chat.id)

      if (isLearningGroup) {
        if (!text.startsWith('/') && text.trim().length >= 2) {
          await addMessageFn(chat.id, text)

          state.lastMessageTime.set(chat.id, Date.now())

          const prevCount = state.messageCountSinceRandom.get(chat.id) || 0
          state.messageCountSinceRandom.set(chat.id, prevCount + 1)
        }
      }

      const isReplyToBot =
        msg.reply_to_message &&
        msg.reply_to_message.from &&
        ctx.botInfo &&
        msg.reply_to_message.from.id === ctx.botInfo.id

      if (!text.startsWith('/')) {
        const shouldReply = isReplyToBot || Math.random() < 0.025

        if (shouldReply) {
          const { text: sentence } = await generateResponse(chat.id)
          if (sentence) {
            safeSend(chat.id, sentence, msg.message_id)
            storeSentenceFn(chat.id, sentence)
          }
        }
      }
    }
  })
}

function startRandomTalker({
  state,
  generateResponse,
  safeSend,
  storeSentenceFn,
  chance,
  intervalMs,
  activeWindowMs,
  minMessages,
}) {
  return setInterval(async () => {
    if (state.knownGroups.size === 0) return
    const shouldSpeak = Math.random() < chance
    if (!shouldSpeak) return

    const activeGroups = Array.from(state.knownGroups).filter((chatId) => {
      const last = state.lastMessageTime.get(chatId)
      if (!last) return false
      if (Date.now() - last > activeWindowMs) return false

      const count = state.messageCountSinceRandom.get(chatId) || 0
      return count >= minMessages
    })

    if (activeGroups.length === 0) return

    const randomChatId =
      activeGroups[Math.floor(Math.random() * activeGroups.length)]

    const { text } = await generateResponse(randomChatId)
    if (!text) return

    try {
      safeSend(randomChatId, text)
      storeSentenceFn(randomChatId, text)
      state.messageCountSinceRandom.set(randomChatId, 0)
    } catch (err) {
      console.error('failed to send random message', err.message)
    }
  }, intervalMs)
}

function scheduleDailyMessage({ state, safeSend, message, timezone }) {
  cron.schedule(
    '0 0 * * *',
    () => {
      if (state.knownGroups.size === 0) return
      for (const chatId of state.knownGroups) {
        safeSend(chatId, message)
      }
    },
    {
      timezone,
    }
  )
}

function startHealthServer(port) {
  return http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK\n')
    })
    .listen(port, () => {
      console.log('HTTP server listening on port', port)
    })
}

function createBot({
  botToken,
  ownerId,
  initialLearningGroups = [],
  randomConfig,
}) {
  const bot = new Telegraf(botToken)
  const state = createBotState()

  initialLearningGroups.forEach((id) => state.learningGroups.add(id))

  const { safeSend } = createSendQueue(bot)
  const storeSentenceForChat = (chatId, sentence) =>
    storeSentence(state.lastSent, chatId, sentence)
  const generateResponse = createResponder(state.lastSent)

  bot.catch((err, ctx) => {
    console.error('Bot error:', err.message, 'update type:', ctx.updateType)
  })

  registerCommandHandlers(bot, {
    ownerId,
    strings,
    state,
    safeSend,
    generateResponse,
    storeSentenceFn: storeSentenceForChat,
    addLearningGroupFn: addLearningGroup,
    removeLearningGroupFn: removeLearningGroup,
  })

  registerTextHandler(bot, {
    state,
    addMessageFn: addMessage,
    generateResponse,
    safeSend,
    storeSentenceFn: storeSentenceForChat,
  })

  startRandomTalker({
    state,
    generateResponse,
    safeSend,
    storeSentenceFn: storeSentenceForChat,
    chance: randomConfig.chance,
    intervalMs: randomConfig.intervalMs,
    activeWindowMs: randomConfig.activeWindowMs,
    minMessages: randomConfig.minMessages,
  })

  scheduleDailyMessage({
    state,
    safeSend,
    message: strings.DAILY_MESSAGE,
    timezone: randomConfig.dailyTimezone,
  })

  return bot
}

let botInstance

async function main() {
  const learningIds = await loadLearningGroups()

  const randomConfig = {
    chance: RANDOM_TALK_CHANCE,
    intervalMs: RANDOM_TALK_INTERVAL_MS,
    activeWindowMs: RANDOM_TALK_ACTIVE_WINDOW_MS,
    minMessages: RANDOM_TALK_REQUIRED_MESSAGES,
    dailyTimezone: DAILY_TIMEZONE,
  }

  botInstance = createBot({
    botToken: BOT_TOKEN,
    ownerId: OWNER_ID,
    initialLearningGroups: learningIds,
    randomConfig,
  })

  startHealthServer(PORT)

  await botInstance.launch()
  console.log('🤖 Bot started...')
}

main().catch((err) => {
  console.error('Bot failed:', err)
  process.exit(1)
})

process.once('SIGINT', () => botInstance?.stop('SIGINT'))
process.once('SIGTERM', () => botInstance?.stop('SIGTERM'))

function createResponder(lastSentMap) {
  return async function generateResponse(
    chatId,
    { maxWords, debug = defaultDebug } = {}
  ) {
    let lastCandidate = ''

    for (let i = 0; i < 3; i++) {
      const candidate = await generateRandomSentence(chatId, maxWords, {
        log: debug,
      })
      if (!candidate) continue
      lastCandidate = candidate
      if (!isDuplicate(lastSentMap, chatId, candidate)) {
        return { text: candidate, strategy: 'markov' }
      }
    }

    return { text: lastCandidate, strategy: 'none' }
  }
}
