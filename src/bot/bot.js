import { Telegraf } from 'telegraf'
import { createSendQueue } from './send-queue.js'
import { storeSentence } from './dedup.js'
import { startRandomTalker } from './random-talker.js'
import { scheduleDailyMessage } from './daily-message.js'
import { registerCommandHandlers } from './handlers/commands.js'
import { registerTextHandler } from './handlers/text.js'
import { addMessage } from '../data/messages.js'
import { addLearningGroup, removeLearningGroup } from '../data/learning-groups.js'
import { createResponder } from './response.js'
import { addTopicText, getTopicHints } from './topic-memory.js'

export function createBot({
  botToken,
  ownerId,
  strings,
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
    storeSentence: storeSentenceForChat,
    addLearningGroup,
    removeLearningGroup,
    getTopicHints: (chatId) => getTopicHints(state.topicTexts, chatId),
  })

  registerTextHandler(bot, {
    state,
    addMessage,
    generateResponse,
    safeSend,
    storeSentence: storeSentenceForChat,
    addTopicSample: (chatId, text) =>
      addTopicText(state.topicTexts, chatId, text),
    getTopicHints: (chatId) => getTopicHints(state.topicTexts, chatId),
  })

  startRandomTalker({
    state,
    generateResponse,
    getTopicHints: (chatId) => getTopicHints(state.topicTexts, chatId),
    safeSend,
    storeSentence: storeSentenceForChat,
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
