export function isDuplicate(lastSent, chatId, sentence) {
  const list = lastSent.get(chatId) || []
  return list.includes(sentence)
}

export function storeSentence(lastSent, chatId, sentence) {
  const list = lastSent.get(chatId) || []
  list.push(sentence)
  if (list.length > 10) list.shift()
  lastSent.set(chatId, list)
}
