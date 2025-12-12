import { Telegraf } from 'telegraf'
import { createSendQueue } from './send-queue.js'
import { isDuplicate, storeSentence } from './dedup.js'
import { startRandomTalker } from './random-talker.js'
import { scheduleDailyMessage } from './daily-message.js'
import { registerCommandHandlers } from './handlers/commands.js'
import { registerTextHandler } from './handlers/text.js'
import { generateRandomSentence } from '../services/markov.js'
import { addMessage } from '../data/messages.js'
import { addLearningGroup, removeLearningGroup } from '../data/learning-groups.js'
import {
  addRecentText,
  getTopicHints,
  addReplyText,
  getReplyHints,
} from './topic-memory.js'

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

  bot.catch((err, ctx) => {
    console.error('Bot error:', err.message, 'update type:', ctx.updateType)
  })

  async function generateNonDuplicate(chatId, maxWords, extraHints = []) {
    let sentence = ''
    const topicHints = getTopicHints(state.recentTexts, chatId)
    const combinedHints = Array.from(
      new Set([...(topicHints || []), ...(extraHints || [])])
    )
    for (let i = 0; i < 3; i++) {
      sentence = await generateRandomSentence(chatId, maxWords, combinedHints)
      if (!sentence) return ''
      if (!isDuplicate(state.lastSent, chatId, sentence)) return sentence
    }
    return sentence
  }

  registerCommandHandlers(bot, {
    ownerId,
    strings,
    state,
    safeSend,
    generateNonDuplicate,
    storeSentence: storeSentenceForChat,
    addLearningGroup,
    removeLearningGroup,
  })

  registerTextHandler(bot, {
    state,
    addMessage,
    generateNonDuplicate,
    safeSend,
    storeSentence: storeSentenceForChat,
    addTopicSample: (chatId, text) =>
      addRecentText(state.recentTexts, chatId, text),
    addReplySample: (chatId, text) =>
      addReplyText(state.replyTexts, chatId, text),
    getReplyHints: (chatId) => getReplyHints(state.replyTexts, chatId),
  })

  startRandomTalker({
    state,
    generateSentence: generateNonDuplicate,
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
    recentTexts: new Map(),
    replyTexts: new Map(),
  }
}
