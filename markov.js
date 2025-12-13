import { MongoClient } from 'mongodb'
import { MONGO_COLLECTION, MONGO_DB_NAME, MONGO_URI } from './src/config.js'

export const GEN_CONFIG = {
  order: 4,
  maxHops: 1,
  maxRepeatAttempts: 3,
}

// Safety guard to prevent runaway generation when maxWords is not provided.
const MAX_GENERATION_GUARD = 200

let client
let collections

export async function getCollections() {
  if (collections) return collections

  if (!client) {
    client = new MongoClient(MONGO_URI)
  }

  await client.connect()
  const db = client.db(MONGO_DB_NAME)

  collections = {
    messages: db.collection(MONGO_COLLECTION),
    learningGroups: db.collection('learning_groups'),
  }

  console.log('📦 MongoDB connected:', MONGO_DB_NAME, '/', MONGO_COLLECTION)
  return collections
}

async function loadAllMessages() {
  const { messages } = await getCollections()

  const docs = await messages
    .find({}, { projection: { messages: 1, _id: 0 } })
    .toArray()

  const all = []

  for (const doc of docs) {
    if (!doc || !Array.isArray(doc.messages)) continue
    for (const t of doc.messages) {
      if (typeof t !== 'string') continue
      const trimmed = t.trim()
      if (!trimmed || trimmed.length === 0) continue
      all.push(trimmed)
    }
  }

  return all
}

function buildChainForOrder(messages, order) {
  const chain = {}
  const startKeys = []
  const prefixLen = order - 1
  if (prefixLen < 1) return { chain, startKeys, order }

  for (const text of messages) {
    const normalized = text.trim()
    if (!normalized) continue

    const words = normalized.split(/\s+/).filter(Boolean)
    if (words.length < order) continue

    startKeys.push(words.slice(0, prefixLen).join(' '))

    for (let i = 0; i <= words.length - order; i++) {
      const key = words.slice(i, i + prefixLen).join(' ')
      const next = words[i + prefixLen]
      if (!chain[key]) chain[key] = []
      chain[key].push(next)
    }
  }

  return { chain, startKeys, order }
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

function chooseStitchedStart(chainData, topicHints = []) {
  const hints = Array.isArray(topicHints)
    ? topicHints.map((h) => h.toLowerCase())
    : []

  const keys = Array.isArray(chainData.startKeys)
    ? chainData.startKeys
    : Object.keys(chainData.chain)
  if (keys.length === 0) return ''

  const byPrefix = new Map()
  const prefixLen = chainData.order - 1
  const groupLen = Math.max(1, prefixLen - 1)

  for (const key of keys) {
    const parts = key.split(' ')
    if (parts.length < prefixLen || groupLen >= parts.length) continue
    const prefix = parts.slice(0, groupLen).join(' ')
    const variant = parts[groupLen]
    const lower = key.toLowerCase()
    const hasHint = hints.length > 0 && hints.some((h) => lower.includes(h))

    const entry = byPrefix.get(prefix) || { words: new Set(), hasHint: false }
    entry.words.add(variant)
    entry.hasHint = entry.hasHint || hasHint
    byPrefix.set(prefix, entry)
  }

  const candidates = Array.from(byPrefix.entries()).filter(
    ([, entry]) => entry.words.size >= 2
  )
  if (candidates.length === 0) return ''

  const hinted = hints.length
    ? candidates.filter(([, entry]) => entry.hasHint)
    : []

  const pool = hinted.length > 0 ? hinted : candidates
  const [prefix, entry] = pool[Math.floor(Math.random() * pool.length)]

  const words = Array.from(entry.words)
  const first = words[Math.floor(Math.random() * words.length)]
  let second = first
  if (words.length > 1) {
    while (second === first) {
      second = words[Math.floor(Math.random() * words.length)]
    }
  }

  return `${prefix} ${second}`.trim()
}

function selectStart(chainData, topicHints) {
  return (
    chooseStitchedStart(chainData, topicHints) ||
    chooseStartKey(chainData, topicHints)
  )
}

function pickNext(nextList, prevWord, maxRepeatAttempts) {
  if (!Array.isArray(nextList) || nextList.length === 0) return ''
  let next = nextList[Math.floor(Math.random() * nextList.length)]
  let attempts = 0

  while (
    prevWord &&
    next === prevWord &&
    attempts < maxRepeatAttempts &&
    nextList.length > 1
  ) {
    next = nextList[Math.floor(Math.random() * nextList.length)]
    attempts++
  }

  return next
}

function appendJump(result, jumpStart, wordLimit) {
  const jumpParts = jumpStart.split(' ')
  const remaining = wordLimit - result.length
  if (remaining <= 0) return

  const overlapTrimmed =
    result.length > 0 &&
      jumpParts.length > 0 &&
      jumpParts[0] === result[result.length - 1]
      ? jumpParts.slice(1)
      : jumpParts

  result.push(...overlapTrimmed.slice(0, remaining))
}

function generateFromChain(
  chainData,
  wordLimit,
  onModelUsed,
  topicHints,
  { maxHops, maxRepeatAttempts }
) {
  const startKey = selectStart(chainData, topicHints)
  if (!startKey) return ''

  const modelName = `${chainData.order}-gram`
  onModelUsed?.(modelName)

  const result = startKey.split(' ')
  const prefixLen = chainData.order - 1
  let hops = 0

  for (let i = result.length; i < wordLimit; i++) {
    const len = result.length
    const key = result.slice(len - prefixLen, len).join(' ')
    const nextList = chainData.chain[key]

    if (!nextList || nextList.length === 0) {
      if (hops >= maxHops) break

      const jumpStart = selectStart(chainData, topicHints)
      if (!jumpStart) break

      appendJump(result, jumpStart, wordLimit)
      hops++
      continue
    }

    const prev = result.length > 0 ? result[result.length - 1] : ''
    const next = pickNext(nextList, prev, maxRepeatAttempts)
    if (!next) break
    result.push(next)
  }

  return result.join(' ')
}

function hasAdjacentRepeats(sentence) {
  const words = sentence.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return false

  let prevPair = ''
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === words[i + 1]) return true
    const pair = `${words[i]} ${words[i + 1]}`
    if (pair === prevPair) return true
    prevPair = pair
  }

  return false
}

export async function generateRandomSentence(
  chatId,
  maxWords,
  topicHints = [],
  { log = true } = {}
) {
  const messages = await loadAllMessages()
  if (messages.length < 5) return ''

  const messageSet = new Set(
    messages.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean)
  )
  const chain = buildChainForOrder(messages, GEN_CONFIG.order)
  const attempts = [chain, chain, chain]
  const wordLimit = Number.isFinite(maxWords) ? maxWords : MAX_GENERATION_GUARD
  const nonStitchRun = Math.random() < 0.3
  const maxHopsThisRun = nonStitchRun ? 0 : GEN_CONFIG.maxHops
  const genConfig = {
    maxHops: maxHopsThisRun,
    maxRepeatAttempts: GEN_CONFIG.maxRepeatAttempts,
  }

  let finalSentence = ''

  for (const chainData of attempts) {
    const usedModels = new Set()
    const hasChain = Object.keys(chainData.chain).length > 0
    if (!hasChain) break

    const sentence = generateFromChain(
      chainData,
      wordLimit,
      (model) => usedModels.add(model),
      topicHints,
      genConfig
    )
    if (!sentence) continue

    const cleaned = sentence.trim()
    if (!cleaned || messageSet.has(cleaned)) continue
    if (hasAdjacentRepeats(cleaned)) continue

    finalSentence = sentence
    break
  }

  if (finalSentence && log) {
    const used = attempts.length > 0 ? `${GEN_CONFIG.order}-gram` : 'none'
    console.log(
      'MARKOV DEBUG:',
      chatId,
      'messages:',
      messages.length,
      'used:',
      used,
      'maxHops:',
      maxHopsThisRun,
      'nonStitch:',
      nonStitchRun
    )
  }

  return finalSentence
}

export async function generateRandomWord(chatId) {
  const { messages } = await getCollections()
  const docs = await messages
    .find({}, { projection: { messages: 1, _id: 0 } })
    .toArray()

  const words = []
  for (const doc of docs) {
    if (!doc || !Array.isArray(doc.messages)) continue
    for (const msg of doc.messages) {
      if (typeof msg !== 'string') continue
      const parts = msg.split(/\s+/).filter(Boolean)
      for (const p of parts) {
        words.push(p)
      }
    }
  }

  if (words.length === 0) return ''

  return words[Math.floor(Math.random() * words.length)]
}
