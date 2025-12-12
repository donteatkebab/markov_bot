import { loadAllMessages } from '../data/messages.js'

function buildChain(messages) {
  const chain = {}
  const startKeys = []

  for (const text of messages) {
    const normalized = text.trim()
    if (!normalized) continue

    const words = normalized.split(/\s+/).filter(Boolean)
    if (words.length < 4) continue

    startKeys.push(`${words[0]} ${words[1]} ${words[2]}`)

    for (let i = 0; i < words.length - 3; i++) {
      const key = `${words[i]} ${words[i + 1]} ${words[i + 2]}`
      const next = words[i + 3]
      if (!chain[key]) chain[key] = []
      chain[key].push(next)
    }
  }

  return { chain, startKeys }
}

function chooseStartKey({ chain, startKeys }, topicHints = []) {
  const keys = Object.keys(chain)
  const hints = Array.isArray(topicHints)
    ? topicHints.map((h) => h.toLowerCase())
    : []

  const preferHints = (keyList) =>
    hints.length === 0
      ? []
      : keyList.filter((k) => {
          const lower = k.toLowerCase()
          return hints.some((h) => lower.includes(h))
        })

  const pick = (keyList) => {
    const filtered = preferHints(keyList)
    const pool = filtered.length > 0 ? filtered : keyList
    if (pool.length === 0) return ''
    return pool[Math.floor(Math.random() * pool.length)]
  }

  if (startKeys.length > 0) {
    const chosen = pick(startKeys)
    if (chain[chosen]) return chosen
  }

  if (keys.length > 0) {
    const chosen = pick(keys)
    if (chain[chosen]) return chosen
  }

  return ''
}

function generateFromChain(chainData, maxWords = 25, onModelUsed, topicHints = []) {
  const startKey = chooseStartKey(chainData, topicHints)
  if (!startKey) return ''

  const result = startKey.split(' ')

  for (let i = result.length; i < maxWords; i++) {
    const len = result.length
    const key = result.slice(len - 3, len).join(' ')
    const nextList = chainData.chain[key]

    if (!nextList || nextList.length === 0) break

    onModelUsed?.('4-gram')

    const next = nextList[Math.floor(Math.random() * nextList.length)]
    result.push(next)
  }

  return result.join(' ')
}

function looksGood(sentence) {
  const s = sentence.trim()
  if (!s) return false

  const words = s.split(/\s+/)
  if (words.length < 7) return false

  const last = words[words.length - 1]
  return /[.!؟?؛…]$/.test(last)
}

export async function generateRandomSentence(chatId, maxWords = 25, topicHints = []) {
  const messages = await loadAllMessages()
  if (messages.length < 5) return ''

  const chainData = buildChain(messages)

  let fallback = ''
  let usedForFallback = 'none'
  let chosen = ''

  for (let i = 0; i < 3; i++) {
    const usedModels = new Set()
    const sentence = generateFromChain(chainData, maxWords, (model) =>
      usedModels.add(model)
    , topicHints)
    if (!sentence) continue
    fallback = sentence
    usedForFallback =
      usedModels.size > 0 ? Array.from(usedModels).sort().join(',') : 'none'

    if (looksGood(sentence)) {
      chosen = sentence
      break
    }
  }

  const finalSentence = chosen || fallback
  if (finalSentence) {
    console.log(
      'MARKOV DEBUG:',
      chatId,
      'messages:',
      messages.length,
      'used:',
      usedForFallback
    )
  }

  return finalSentence
}
