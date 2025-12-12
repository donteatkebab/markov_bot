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
const MAX_HINTS = 5
const MAX_TOPIC_TEXTS = 5

function createBotState() {
  return {
    knownGroups: new Set(),
    lastMessageTime: new Map(),
    messageCountSinceRandom: new Map(),
    lastSent: new Map(),
    learningGroups: new Set(),
    topicTexts: new Map(),
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

function getHintsFromTexts(texts = []) {
  if (!texts || texts.length === 0) return []

  const words = texts
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9_\u0600-\u06FF]+/g, ''))
    .filter(
      (w) =>
        w &&
        w.length >= 3 &&
        !w.startsWith('@') &&
        !w.startsWith('http') &&
        !w.startsWith('www')
    )

  const counts = new Map()
  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1)
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)

  return sorted.slice(0, MAX_HINTS)
}

function addTopicText(map, chatId, text) {
  const list = map.get(chatId) || []
  list.push(text)
  if (list.length > MAX_TOPIC_TEXTS) list.shift()
  map.set(chatId, list)
}

function getTopicHints(map, chatId) {
  const texts = map.get(chatId) || []
  return getHintsFromTexts(texts)
}

function createResponder(lastSentMap) {
  return async function generateResponse(
    chatId,
    { maxWords, hints = [], debug = defaultDebug } = {}
  ) {
    let lastCandidate = ''

    for (let i = 0; i < 3; i++) {
      const candidate = await generateRandomSentence(chatId, maxWords, hints, {
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

async function addMessage(chatId, text) {
  if (typeof text !== 'string') return

  let cleaned = text
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, '')
  cleaned = cleaned.replace(/www\.\S+/gi, '')
  cleaned = cleaned.replace(
    /\b\S+\.(com|net|org|ir|io|me|app|xyz|info|site|online|shop|top)\S*/gi,
    ''
  )
  cleaned = cleaned.replace(/@[a-zA-Z0-9_]{3,32}/g, '')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  if (!cleaned || cleaned.length < 2) return

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
    getTopicHintsFn,
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

    const hints = getTopicHintsFn(ctx.chat.id)
    const { text } = await generateResponse(ctx.chat.id, {
      hints,
    })

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
    addTopicSample,
    getTopicHintsFn,
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
        const shouldReply = isReplyToBot || Math.random() < 0.05

        if (shouldReply) {
          const hints = getHintsFromTexts([text])
          const { text: sentence } = await generateResponse(chat.id, {
            hints,
          })
          if (sentence) {
            safeSend(chat.id, sentence, msg.message_id)
            storeSentenceFn(chat.id, sentence)
          }
        }

        addTopicSample(chat.id, text)
      }
    }
  })
}

function startRandomTalker({
  state,
  generateResponse,
  getTopicHintsFn,
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

    const hints = getTopicHintsFn(randomChatId)
    const { text } = await generateResponse(randomChatId, {
      hints,
    })
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
    getTopicHintsFn: (chatId) => getTopicHints(state.topicTexts, chatId),
  })

  registerTextHandler(bot, {
    state,
    addMessageFn: addMessage,
    generateResponse,
    safeSend,
    storeSentenceFn: storeSentenceForChat,
    addTopicSample: (chatId, text) =>
      addTopicText(state.topicTexts, chatId, text),
    getTopicHintsFn: (chatId) => getTopicHints(state.topicTexts, chatId),
  })

  startRandomTalker({
    state,
    generateResponse,
    getTopicHintsFn: (chatId) => getTopicHints(state.topicTexts, chatId),
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
