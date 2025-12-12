import { getHintsFromTexts } from '../topic-memory.js'

export function registerTextHandler(bot, deps) {
  const {
    state,
    addMessage,
    generateResponse,
    safeSend,
    storeSentence,
    addTopicSample,
    getTopicHints,
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
          await addMessage(chat.id, text)

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

      if (isReplyToBot) {
        const replyHints = getHintsFromTexts([text])
        const topicHints = getTopicHints(chat.id)
        const hints = Array.from(new Set([...replyHints, ...topicHints]))
        const { text: sentence } = await generateResponse(chat.id, {
          maxWords: 25,
          hints,
        })
        if (!sentence) return

        safeSend(chat.id, sentence, msg.message_id)
        storeSentence(chat.id, sentence)
      } else if (!text.startsWith('/')) {
        addTopicSample(chat.id, text)
      }
    }
  })
}
