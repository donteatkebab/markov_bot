const { MongoClient } = require('mongodb')

const uri = process.env.MONGO_URI
if (!uri) {
  throw new Error('MONGO_URI is not set in environment variables')
}

const DB_NAME = process.env.MONGO_DB_NAME || 'markov_bot'
const COLLECTION_NAME = process.env.MONGO_COLLECTION || 'groups'

const client = new MongoClient(uri)
let collection = null
const chainCache = new Map()

// اتصال به دیتابیس
async function initDb() {
  if (collection) return
  await client.connect()
  const db = client.db(DB_NAME)
  collection = db.collection(COLLECTION_NAME)
  console.log('📦 MongoDB connected:', DB_NAME, '/', COLLECTION_NAME)
}

// خواندن پیام‌های یک گروه
async function loadMessagesForChat(chatId) {
  if (!collection) await initDb()
  const key = String(chatId)

  const doc = await collection.findOne(
    { chatId: key },
    { projection: { messages: 1, _id: 0 } }
  )

  if (!doc || !Array.isArray(doc.messages)) return []
  return doc.messages
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

// ذخیره یک پیام
async function addMessage(chatId, text) {
  if (!collection) await initDb()
  const key = String(chatId)

  if (typeof text !== 'string' || text.trim().length === 0) return

  // --- Clean text ---
  let cleaned = text

  // Remove URLs
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, '')
  cleaned = cleaned.replace(/www\.\S+/gi, '')
  cleaned = cleaned.replace(/\S+\.(com|net|org|ir|io|me|app)\S*/gi, '')

  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  if (!cleaned || cleaned.length < 2) return

  await collection.updateOne(
    { chatId: key },
    { $push: { messages: cleaned } },
    { upsert: true }
  )
}

// ساخت زنجیره مارکوف (tri-gram: دو کلمه → کلمه بعدی) + کلیدهای شروع
function buildChain(messages) {
  const chain = {}
  const startKeys = []

  for (const text of messages) {
    const normalized = text.trim()
    if (!normalized) continue

    // جمله‌ها را بر اساس نشانه‌های پایان جمله جدا می‌کنیم
    const sentences = normalized
      .split(/[.!؟?]+/g)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const sentence of sentences) {
      const words = sentence.split(/\s+/).filter(Boolean)
      if (words.length < 3) continue

      // دو کلمه اول هر جمله را به عنوان شروع ذخیره می‌کنیم
      const startKey = `${words[0]} ${words[1]}`
      startKeys.push(startKey)

      for (let i = 0; i < words.length - 2; i++) {
        const w1 = words[i]
        const w2 = words[i + 1]
        const w3 = words[i + 2]

        const key = `${w1} ${w2}`

        if (!chain[key]) {
          chain[key] = []
        }
        chain[key].push(w3)
      }
    }
  }

  return { chain, startKeys }
}

// تولید جمله رندوم بر اساس tri-gram و شروع‌های طبیعی‌تر
function generateFromChain(chain, startKeys, maxWords = 25) {
  const keys = Object.keys(chain)
  if (keys.length === 0) return ''

  let currentKey

  // اگر startKeys داشتیم، سعی می‌کنیم از یکی از آنها شروع کنیم
  if (Array.isArray(startKeys) && startKeys.length > 0) {
    currentKey = startKeys[Math.floor(Math.random() * startKeys.length)]
    if (!chain[currentKey]) {
      currentKey = keys[Math.floor(Math.random() * keys.length)]
    }
  } else {
    currentKey = keys[Math.floor(Math.random() * keys.length)]
  }

  const parts = currentKey.split(' ')
  if (parts.length < 2) return ''

  const result = [parts[0], parts[1]]

  for (let i = 0; i < maxWords - 2; i++) {
    const nextList = chain[currentKey]
    if (!nextList || nextList.length === 0) break

    const next = nextList[Math.floor(Math.random() * nextList.length)]
    result.push(next)

    // جفت جدید: دو کلمه آخر
    const len = result.length
    currentKey = `${result[len - 2]} ${result[len - 1]}`

    if (!chain[currentKey]) {
      break
    }
  }

  return result.join(' ')
}

function looksGood(sentence) {
  const s = sentence.trim()
  if (!s) return false

  const words = s.split(/\s+/)
  if (words.length < 6) return false // خیلی کوتاه است

  const last = words[words.length - 1]
  // پایان با علائم نگارشی خوشگل
  return /[.!؟?؛…]$/.test(last)
}

// خروجی آماده برای بات با کش per-group
async function generateRandom(chatId, maxWords = 25) {
  const messages = await loadMessagesForChat(chatId)
  console.log('MARKOV DEBUG:', chatId, 'messages:', messages.length)

  if (messages.length < 5) return ''

  const cacheKey = String(chatId)
  let cached = chainCache.get(cacheKey)

  // اگر کش نداریم یا تعداد پیام‌ها عوض شده، زنجیره را دوباره بساز
  if (!cached || cached.messageCount !== messages.length) {
    const { chain, startKeys } = buildChain(messages)
    cached = { chain, startKeys, messageCount: messages.length }
    chainCache.set(cacheKey, cached)

    // محدود کردن اندازه کش برای جلوگیری از مصرف بیش از حد رم
    if (chainCache.size > 100) {
      const firstKey = chainCache.keys().next().value
      if (firstKey !== undefined) {
        chainCache.delete(firstKey)
      }
    }
  }

  let fallback = ''

  // تا چند بار تلاش می‌کنیم جمله‌ای بسازیم که پایان مناسبی داشته باشد
  for (let i = 0; i < 3; i++) {
    const sentence = generateFromChain(cached.chain, cached.startKeys, maxWords)
    if (!sentence) continue
    fallback = sentence

    if (looksGood(sentence)) {
      return sentence
    }
  }

  // اگر جمله‌ای با پایان خوب پیدا نشد، همان بهترین جمله را برمی‌گردانیم
  return fallback
}

module.exports = {
  initDb,
  addMessage,
  generateRandom,
}