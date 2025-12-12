import { getHintsFromTexts } from '../topic-memory.js'

export function registerTextHandler(bot, deps) {
  const {
    state,
    addMessage,
    generateNonDuplicate,
    safeSend,
    storeSentence,
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
        const sentence = await generateNonDuplicate(chat.id, 25, replyHints)
        if (!sentence) return

        safeSend(chat.id, sentence, msg.message_id)
        storeSentence(chat.id, sentence)
      }
    }
  })
}
