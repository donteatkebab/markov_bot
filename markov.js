import { MongoClient } from 'mongodb'
import {
  MONGO_COLLECTION,
  MONGO_DB_NAME,
  MONGO_URI,
  GEN_CONFIG,
} from './src/config.js'

// Safety guard to prevent runaway generation when maxWords is not provided.
const MAX_GENERATION_GUARD = 200

const DEBUG_MARKOV = process.env.DEBUG_MARKOV === '1'

// Anti-recent-repeat buffer (RAM only): prevents sending the same sentence repeatedly
const RECENT_SENT_MAX = 5
const recentSentByChat = new Map()

function normalizeForRepeat(text) {
  if (typeof text !== 'string') return ''
  // keep emojis and punctuation, just normalize whitespace
  return text.replace(/\s+/g, ' ').trim()
}

function isRecentlySent(chatId, sentence) {
  const list = recentSentByChat.get(chatId)
  if (!list || list.length === 0) return false
  const normalized = normalizeForRepeat(sentence)
  if (!normalized) return false
  return list.includes(normalized)
}

function rememberSent(chatId, sentence) {
  const normalized = normalizeForRepeat(sentence)
  if (!normalized) return
  const list = recentSentByChat.get(chatId) || []
  list.push(normalized)
  // keep only the last N
  if (list.length > RECENT_SENT_MAX) list.splice(0, list.length - RECENT_SENT_MAX)
  recentSentByChat.set(chatId, list)
}

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

  if (DEBUG_MARKOV) {
    console.log('📦 MongoDB connected:', MONGO_DB_NAME, '/', MONGO_COLLECTION)
  }
  return collections
}

async function loadAllMessages() {
  const { messages, learningGroups } = await getCollections()

  // فقط گروه‌هایی که train روی آن‌ها فعال شده، اجازه‌ی تغذیه‌ی مدل را دارند
  const allowedDocs = await learningGroups
    .find({}, { projection: { chatId: 1, _id: 0 } })
    .toArray()

  const allowedIds = allowedDocs
    .map((d) => (d && d.chatId != null ? String(d.chatId) : ''))
    .filter(Boolean)

  if (allowedIds.length === 0) return []

  // chatId ممکن است به صورت Number یا String ذخیره شده باشد، برای اطمینان هر دو را می‌سازیم
  const allowedAsNumbers = allowedIds
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n))

  const query =
    allowedAsNumbers.length > 0
      ? { chatId: { $in: [...allowedIds, ...allowedAsNumbers] } }
      : { chatId: { $in: allowedIds } }

  const docs = await messages
    .find(query, { projection: { messages: 1, _id: 0 } })
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
  const startKeysSet = new Set()
  const prefixLen = order - 1
  if (prefixLen < 1) return { chain, startKeys: [], order }

  for (const text of messages) {
    const normalized = text.trim()
    if (!normalized) continue

    const words = normalized.split(/\s+/).filter(Boolean)
    if (words.length < order) continue

    startKeysSet.add(words.slice(0, prefixLen).join(' '))

    for (let i = 0; i <= words.length - order; i++) {
      const key = words.slice(i, i + prefixLen).join(' ')
      const next = words[i + prefixLen]
      if (!chain[key]) chain[key] = []
      chain[key].push(next)
    }
  }

  return { chain, startKeys: Array.from(startKeysSet), order }
}

function chooseStartKey({ chain, startKeys }) {
  const keys = Object.keys(chain)

  const pick = (keyList) => {
    if (!Array.isArray(keyList) || keyList.length === 0) return ''
    return keyList[Math.floor(Math.random() * keyList.length)]
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

function chooseStitchedStart(chainData) {
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

    const entry = byPrefix.get(prefix) || { words: new Set() }
    entry.words.add(variant)
    byPrefix.set(prefix, entry)
  }

  const candidates = Array.from(byPrefix.entries()).filter(
    ([, entry]) => entry.words.size >= 2
  )
  if (candidates.length === 0) return ''

  const [prefix, entry] = candidates[Math.floor(Math.random() * candidates.length)]

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

function selectStart(chainData) {
  return chooseStitchedStart(chainData) || chooseStartKey(chainData)
}

function pickNext(nextList, prevWord, recentPairs, maxRepeatAttempts) {
  if (!Array.isArray(nextList) || nextList.length === 0) return ''

  const hasRecent = Array.isArray(recentPairs) && recentPairs.length > 0
  const maxTries = Math.max(3, (maxRepeatAttempts || 0) * 3)

  // Try multiple times to find a next token that doesn't immediately loop
  for (let tries = 0; tries < maxTries; tries++) {
    const next = nextList[Math.floor(Math.random() * nextList.length)]

    // 1) avoid repeating the exact previous word when possible
    if (prevWord && next === prevWord && nextList.length > 1) continue

    // 2) avoid repeating recent (prev,next) pairs when possible
    if (hasRecent && prevWord) {
      const pair = `${prevWord} ${next}`
      if (recentPairs.includes(pair) && nextList.length > 1) continue
    }

    return next
  }

  // Fallback: return something (original behavior)
  return nextList[Math.floor(Math.random() * nextList.length)]
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
  { maxHops, maxRepeatAttempts }
) {
  const startKey = selectStart(chainData)
  if (!startKey) return ''

  const modelName = `${chainData.order}-gram`
  onModelUsed?.(modelName)

  const result = startKey.split(' ')
  const prefixLen = chainData.order - 1
  let hops = 0
  const recentPairs = []
  const RECENT_PAIR_MAX = 12

  for (let i = result.length; i < wordLimit; i++) {
    const len = result.length
    const key = result.slice(len - prefixLen, len).join(' ')
    const nextList = chainData.chain[key]

    if (!nextList || nextList.length === 0) {
      if (hops >= maxHops) break

      const jumpStart = selectStart(chainData)
      if (!jumpStart) break

      appendJump(result, jumpStart, wordLimit)
      hops++
      continue
    }

    const prev = result.length > 0 ? result[result.length - 1] : ''
    const next = pickNext(nextList, prev, recentPairs, maxRepeatAttempts)
    if (!next) break
    result.push(next)

    if (prev) {
      recentPairs.push(`${prev} ${next}`)
      if (recentPairs.length > RECENT_PAIR_MAX) {
        recentPairs.splice(0, recentPairs.length - RECENT_PAIR_MAX)
      }
    }

    // جلوگیری از تکرارهای رگباری مثل "A A" که باعث اسپم و تکرار متن می‌شوند
    if (hasMultiWordTailLoop(result, 5)) break
    if (hasLongTailLoop(result, 8)) break
  }

  return result.join(' ')
}

function normalizeToken(t) {
  if (typeof t !== 'string') return ''
  return (
    t
      // normalize Arabic/Persian variants
      .replace(/ك/g, 'ک')
      .replace(/ي/g, 'ی')
      // collapse repeated dots/ellipses
      .replace(/[.٫،,]{2,}/g, '.')
      .replace(/…+/g, '…')
      // trim
      .trim()
  )
}

function hasShortTailLoop(sentence) {
  const words = sentence.trim().split(/\s+/).filter(Boolean).map(normalizeToken)
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

function hasLongTailLoop(wordArray, minHalfWords = 8) {
  if (!Array.isArray(wordArray)) return false
  const len = wordArray.length
  if (len < minHalfWords * 2) return false

  // Only inspect the tail to keep it cheap and truly "tail"-based
  const tailWindow = 200
  const tail = wordArray
    .slice(Math.max(0, len - tailWindow))
    .map((t) => normalizeToken(String(t)))
  const tlen = tail.length
  if (tlen < minHalfWords * 2) return false

  const maxBlock = Math.floor(tlen / 2)

  // If the last [block][block] occurs at the end, we consider it a bad repeat.
  for (let blockLen = minHalfWords; blockLen <= maxBlock; blockLen++) {
    const a = tail.slice(tlen - blockLen * 2, tlen - blockLen).join(' ')
    const b = tail.slice(tlen - blockLen, tlen).join(' ')
    if (a === b) return true
  }

  return false
}

function hasMultiWordTailLoop(wordArray, minBlockWords = 5) {
  if (!Array.isArray(wordArray)) return false
  const len = wordArray.length
  if (len < minBlockWords * 2) return false

  // Only inspect the tail to keep it cheap
  const tailWindow = 200
  const tail = wordArray
    .slice(Math.max(0, len - tailWindow))
    .map((t) => normalizeToken(String(t)))
  const tlen = tail.length
  if (tlen < minBlockWords * 2) return false

  // allow longer blocks in the tail without scanning the whole sentence
  const maxBlockWords = Math.min(100, Math.floor(tlen / 2))

  for (let blockLen = minBlockWords; blockLen <= maxBlockWords; blockLen++) {
    const a = tail.slice(tlen - blockLen * 2, tlen - blockLen).join(' ')
    const b = tail.slice(tlen - blockLen, tlen).join(' ')
    if (a === b) return true
  }

  return false
}

export async function generateRandomSentence(
  chatId,
  maxWords,
  { log = false } = {}
) {
  const messages = await loadAllMessages()
  if (messages.length < 5) return ''

  const chain = buildChainForOrder(messages, GEN_CONFIG.order)
  const wordLimit = Number.isFinite(maxWords) ? maxWords : MAX_GENERATION_GUARD
  const nonStitchRun = Math.random() < 0.4
  const maxHopsThisRun = nonStitchRun ? 0 : GEN_CONFIG.maxHops
  const genConfig = {
    maxHops: maxHopsThisRun,
    maxRepeatAttempts: GEN_CONFIG.maxRepeatAttempts,
  }

  let finalSentence = ''

  {
    const chainData = chain
    const usedModels = new Set()
    const hasChain = Object.keys(chainData.chain).length > 0
    if (hasChain) {
      const sentence = generateFromChain(
        chainData,
        wordLimit,
        (model) => usedModels.add(model),
        genConfig
      )
      if (sentence) {
        const cleaned = sentence.trim()
        if (
          cleaned &&
          !isRecentlySent(chatId, cleaned) &&
          !hasShortTailLoop(cleaned)
        ) {
          finalSentence = sentence
          rememberSent(chatId, cleaned)
        }
      }
    }
  }

  if (finalSentence && log && DEBUG_MARKOV) {
    const used = chain ? `${GEN_CONFIG.order}-gram` : 'none'
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
