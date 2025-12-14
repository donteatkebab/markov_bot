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

// ------------------------------
// Related reply (simple version)
// Uses word 3-gram Jaccard similarity to pick a local subset of messages,
// then generates with Markov on that subset (not a copy).
// ------------------------------

function normalizePersianLite(text) {
  return String(text || '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/‌/g, ' ')
    .replace(/ـ+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOPWORDS = new Set([
  'و', 'یا', 'که', 'به', 'از', 'در', 'با', 'برای', 'تا', 'این', 'اون', 'آن', 'من', 'تو', 'ما', 'شما', 'اونا', 'او', 'هم', 'همه',
  'یه', 'یک', 'دیگه', 'ولی', 'چون', 'اگر', 'پس', 'رو', 'را', 'همین', 'اونم', 'اینجا', 'اونجا', 'الان', 'بعد', 'قبل',
  'نه', 'آره', 'اره', 'چی', 'چیه', 'کجاست', 'چرا', 'چطور', 'چجوری', 'مگه', 'خب'
])

function tokenizeForMatch(text) {
  const t = normalizePersianLite(text)
  // remove most punctuation for matching; keep letters/numbers/spaces
  const cleaned = t.replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const tokens = cleaned
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.length >= 2)
    .filter((x) => !STOPWORDS.has(x))
  return tokens
}

function toWordTrigrams(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 3) return []
  const grams = []
  for (let i = 0; i <= tokens.length - 3; i++) {
    grams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`)
  }
  return grams
}

function toWordBigrams(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) return []
  const grams = []
  for (let i = 0; i <= tokens.length - 2; i++) {
    grams.push(`${tokens[i]} ${tokens[i + 1]}`)
  }
  return grams
}

function containsAnyKeyword(normalizedMsg, keywords) {
  for (const kw of keywords) {
    if (kw && normalizedMsg.includes(kw)) return true
  }
  return false
}

function keywordScore(normalizedMsg, keywords, weights) {
  let s = 0
  for (const kw of keywords) {
    if (!kw) continue
    if (normalizedMsg.includes(kw)) s += weights.get(kw) || 0
  }
  return s
}

function jaccard(aList, bList) {
  if (!aList.length || !bList.length) return 0
  const a = new Set(aList)
  const b = new Set(bList)
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  if (union <= 0) return 0
  return inter / union
}

async function loadMessagesForChat(chatId) {
  const { messages } = await getCollections()
  const idStr = String(chatId)
  const idNum = Number(chatId)

  const query =
    Number.isFinite(idNum) ? { chatId: { $in: [idStr, idNum] } } : { chatId: idStr }

  const doc = await messages.findOne(query, { projection: { messages: 1, _id: 0 } })
  const arr = Array.isArray(doc?.messages) ? doc.messages : []
  return arr
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * Generate a Markov sentence that is *related* to userText, without copying.
 * - Pulls messages for the same chatId (fast + relevant style).
 * - Scores messages by word 3-gram Jaccard similarity against userText.
 * - Builds a local chain from top-K and generates.
 * - Avoids returning an exact stored message.
 */
export async function generateRelatedSentence(
  chatId,
  userText,
  maxWords,
  { log = false } = {}
) {
  const seed = normalizePersianLite(userText)
  const seedTokens = tokenizeForMatch(seed)
  // Backoff: we may not have enough tokens for 3-grams, so we will try 3-gram -> 2-gram -> 1-gram
  const seed3 = toWordTrigrams(seedTokens)
  const seed2 = toWordBigrams(seedTokens)

  // Globalized DB: use the global pool already filtered by learning_groups
  const all = await loadAllMessages()

  // Keyword-first + backoff similarity (3-gram -> 2-gram -> 1-gram)
  // 1) pick a few keywords from the seed using a lightweight IDF-like score
  const MAX_KEYWORDS = 4
  const candidateKw = seedTokens
    .filter((t) => t.length >= 2)
    .slice(0, 12)

  // If we have no usable keywords, fall back (seed too weak)
  if (candidateKw.length === 0) {
    return generateRandomSentence(chatId, maxWords, { log, isReplyFallback: true })
  }

  // compute document-frequency for candidate keywords across the global pool
  const df = new Map()
  for (const kw of candidateKw) df.set(kw, 0)

  for (const m of all) {
    const nm = normalizePersianLite(m)
    // count each keyword at most once per message
    for (const kw of candidateKw) {
      if (nm.includes(kw)) df.set(kw, (df.get(kw) || 0) + 1)
    }
  }

  // weights: rarer keywords get higher weight; also prefer longer tokens a bit
  const weights = new Map()
  for (const kw of candidateKw) {
    const d = df.get(kw) || 0
    const w = (1 / Math.sqrt(d + 1)) * Math.min(2.2, 1 + kw.length / 6)
    weights.set(kw, w)
  }

  // pick top keywords by weight
  const keywords = Array.from(candidateKw)
    .sort((a, b) => (weights.get(b) || 0) - (weights.get(a) || 0))
    .slice(0, MAX_KEYWORDS)

  // 2) Build seed grams for backoff (prefer 3-gram, then 2-gram, then 1-gram tokens)
  const seed3grams = seed3
  const seed2grams = seed2
  const seed1set = seedTokens
  const mode = seed3grams.length > 0 ? 3 : seed2grams.length > 0 ? 2 : 1

  // 3) Retrieve candidates that contain at least one keyword
  const candidates = []
  for (const m of all) {
    const nm = normalizePersianLite(m)
    if (!containsAnyKeyword(nm, keywords)) continue
    candidates.push({ m, nm })
  }

  // If candidates are too few, relax: use whole pool but still score by grams (backoff)
  const poolForScoring = candidates.length >= 40 ? candidates : all.map((m) => ({ m, nm: normalizePersianLite(m) }))

  const scored = []
  for (const { m, nm } of poolForScoring) {
    const kwS = keywordScore(nm, keywords, weights)
    if (kwS <= 0 && candidates.length >= 40) continue

    const tks = tokenizeForMatch(m)
    let sim = 0

    if (mode === 3) {
      const grams = toWordTrigrams(tks)
      if (grams.length > 0) sim = jaccard(seed3grams, grams)
    } else if (mode === 2) {
      const grams = toWordBigrams(tks)
      if (seed2grams.length > 0 && grams.length > 0) sim = jaccard(seed2grams, grams)
    } else {
      // 1-gram: token set overlap (Jaccard on tokens)
      if (seed1set.length > 0 && tks.length > 0) sim = jaccard(seed1set, tks)
    }

    // Combine: keyword score dominates, similarity refines ranking
    const total = kwS + sim * 0.9
    if (total > 0) scored.push({ m, s: total })
  }

  scored.sort((x, y) => y.s - x.s)

  // Take top-K. Keep it bounded for speed + style consistency.
  const topK = scored.slice(0, 140).map((x) => x.m)
  if (topK.length < 12) {
    // not enough related examples
    return generateRandomSentence(chatId, maxWords, { log, isReplyFallback: true })
  }

  const localChain = buildChainForOrder(topK, GEN_CONFIG.order)
  const wordLimit = Number.isFinite(maxWords) ? maxWords : MAX_GENERATION_GUARD

  // Avoid copying: if output equals any source message, retry a few times.
  const sourceSet = new Set(topK.map((x) => normalizeForRepeat(x)))

  const nonStitchRun = Math.random() < 0.4
  const maxHopsThisRun = nonStitchRun ? 0 : GEN_CONFIG.maxHops
  const genConfig = {
    maxHops: maxHopsThisRun,
    maxRepeatAttempts: GEN_CONFIG.maxRepeatAttempts,
  }

  let finalSentence = ''

  for (let attempt = 0; attempt < 6; attempt++) {
    const usedModels = new Set()
    const hasChain = Object.keys(localChain.chain).length > 0
    if (!hasChain) break

    const sentence = generateFromChain(
      localChain,
      wordLimit,
      (model) => usedModels.add(model),
      genConfig
    )

    if (!sentence) continue
    const cleaned = sentence.trim()

    // Keep the same minimal output checks we already use
    if (!cleaned) continue
    if (sourceSet.has(normalizeForRepeat(cleaned))) continue
    if (isRecentlySent(chatId, cleaned)) continue
    if (hasShortTailLoop(cleaned)) continue

    finalSentence = sentence
    rememberSent(chatId, cleaned)
    break
  }

  // fallback
  if (!finalSentence) {
    return generateRandomSentence(chatId, maxWords, { log, isReplyFallback: true })
  }

  if (finalSentence && log && DEBUG_MARKOV) {
    console.log(
      'MARKOV RELATED DEBUG:',
      chatId,
      'pool:',
      all.length,
      'topK:',
      topK.length,
      'mode:',
      mode,
      'seedTokens:',
      seedTokens.length,
      'seed3:',
      seed3grams.length,
      'seed2:',
      seed2grams.length,
      'keywords:',
      keywords,
      'maxHops:',
      maxHopsThisRun,
      'nonStitch:',
      nonStitchRun
    )
  }

  return finalSentence
}

export async function generateRandomSentence(
  chatId,
  maxWords,
  { log = false, isReplyFallback = false } = {}
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
      nonStitchRun,
      'isReplyFallback:',
      isReplyFallback
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
