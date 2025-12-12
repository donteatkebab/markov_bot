const MAX_RECENT_TEXTS = 5
const MAX_REPLY_TEXTS = 5
const MAX_HINTS = 5

function addText(map, chatId, text, cap) {
  const list = map.get(chatId) || []
  list.push(text)
  if (list.length > cap) list.shift()
  map.set(chatId, list)
}

function computeHints(texts) {
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

export function addRecentText(recentMap, chatId, text) {
  addText(recentMap, chatId, text, MAX_RECENT_TEXTS)
}

export function getTopicHints(recentMap, chatId) {
  const texts = recentMap.get(chatId)
  return computeHints(texts)
}

export function addReplyText(replyMap, chatId, text) {
  addText(replyMap, chatId, text, MAX_REPLY_TEXTS)
}

export function getReplyHints(replyMap, chatId) {
  const texts = replyMap.get(chatId)
  return computeHints(texts)
}
