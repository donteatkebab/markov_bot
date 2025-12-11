export function startRandomTalker({
  state,
  generateSentence,
  safeSend,
  storeSentence,
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

    const sentence = await generateSentence(randomChatId, 25)
    if (!sentence) return

    try {
      safeSend(randomChatId, sentence)
      storeSentence(randomChatId, sentence)
      state.messageCountSinceRandom.set(randomChatId, 0)
    } catch (err) {
      console.error('failed to send random message', err.message)
    }
  }, intervalMs)
}
