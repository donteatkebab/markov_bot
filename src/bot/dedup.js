const MAX_BUFFER = 25
const MIN_REPEAT_MS = 10 * 60 * 1000 // 10 minutes

export function isDuplicate(lastSent, chatId, sentence) {
  const entries = lastSent.get(chatId) || []
  const now = Date.now()

  return entries.some(
    (e) =>
      e.text === sentence && (!e.timestamp || now - e.timestamp < MIN_REPEAT_MS)
  )
}

export function storeSentence(lastSent, chatId, sentence) {
  const entries = lastSent.get(chatId) || []
  entries.push({ text: sentence, timestamp: Date.now() })
  if (entries.length > MAX_BUFFER) entries.shift()
  lastSent.set(chatId, entries)
}
