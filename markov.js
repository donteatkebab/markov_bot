const { MongoClient } = require('mongodb')

const uri = process.env.MONGO_URI
if (!uri) {
  throw new Error('MONGO_URI is not set in environment variables')
}

const DB_NAME = process.env.MONGO_DB_NAME || 'markov_bot'
const COLLECTION_NAME = process.env.MONGO_COLLECTION || 'groups'

const client = new MongoClient(uri)
let collection = null
let learningCollection = null

// اتصال به دیتابیس
async function initDb() {
  if (collection && learningCollection) return
  await client.connect()
  const db = client.db(DB_NAME)
  collection = db.collection(COLLECTION_NAME)
  learningCollection = db.collection('learning_groups')
  console.log('📦 MongoDB connected:', DB_NAME, '/', COLLECTION_NAME)
}

// خواندن پیام‌های یک گروه
async function loadMessagesForChat() {
  if (!collection) await initDb()

  const docs = await collection
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

// ذخیره یک پیام
async function addMessage(chatId, text) {
  if (!collection) await initDb()
  const key = String(chatId)

  if (typeof text !== 'string' || text.trim().length === 0) return

  // --- Clean text ---
  let cleaned = text

  // Remove URLs with http/https
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, '')

  // Remove URLs starting with www.
  cleaned = cleaned.replace(/www\.\S+/gi, '')

  // Remove bare domains with common TLDs (more complete list)
  cleaned = cleaned.replace(/\b\S+\.(com|net|org|ir|io|me|app|xyz|info|site|online|shop|top)\S*/gi, '')

  // Remove Telegram-style @usernames (internal links)
  cleaned = cleaned.replace(/@[a-zA-Z0-9_]{3,32}/g, '')

  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  if (!cleaned || cleaned.length < 2) return

  await collection.updateOne(
    { chatId: key },
    { $push: { messages: cleaned } },
    { upsert: true }
  )
}

// ساخت زنجیره مارکوف (4-gram: سه کلمه → کلمه بعدی) + کلیدهای شروع هوشمند
function buildChain(messages) {
  const chain = {}
  const startKeys = []

  for (const text of messages) {
    const normalized = text.trim()
    if (!normalized) continue

    const sentence = normalized
    const words = sentence.split(/\s+/).filter(Boolean)

    // نیاز به حداقل 4 کلمه
    if (words.length < 4) continue

    // پیام‌هایی که با کلمات ربط و حروف اضافه تمام می‌شوند، معمولاً نیمه‌تمام‌اند
    const badEndings = ['به', 'تو', 'برای', 'با', 'از', 'در', 'که', 'و', 'یا', 'تا', 'پیش', 'روی', 'زیر', 'توی', 'سر', 'داخل']
    const lastWord = words[words.length - 1]
    if (badEndings.includes(lastWord)) {
      continue
    }

    // اضافه‌کردن همه شروع‌ها (بدون فیلتر stopword)
    const startKey = `${words[0]} ${words[1]} ${words[2]}`
    startKeys.push(startKey)

    // 4‑gram: سه کلمه → کلمه بعدی
    for (let i = 0; i < words.length - 3; i++) {
      const w1 = words[i]
      const w2 = words[i + 1]
      const w3 = words[i + 2]
      const w4 = words[i + 3]

      const key = `${w1} ${w2} ${w3}`

      if (!chain[key]) {
        chain[key] = []
      }
      chain[key].push(w4)
    }

    continue
  }

  return { chain, startKeys }
}

// تولید جمله رندوم بر اساس 4-gram و شروع‌های هوشمند + انتخاب وزن‌دار کلمه بعدی
function generateFromChain(chain, startKeys, maxWords = 25) {
  const keys = Object.keys(chain)
  if (keys.length === 0) return ''

  let currentKey

  // Smart start: اگر startKeys مناسب بود، از آن استفاده کن
  if (Array.isArray(startKeys) && startKeys.length > 0) {
    const chosen = startKeys[Math.floor(Math.random() * startKeys.length)]
    if (chain[chosen]) {
      currentKey = chosen
    } else {
      currentKey = keys[Math.floor(Math.random() * keys.length)]
    }
  } else {
    currentKey = keys[Math.floor(Math.random() * keys.length)]
  }

  const parts = currentKey.split(' ')
  if (parts.length < 3) return ''

  const result = [...parts]

  for (let i = 0; i < maxWords - 3; i++) {
    const nextList = chain[currentKey]
    if (!nextList || nextList.length === 0) break

    // --- Weighted selection ---
    // کلمات پرتکرار ضریب کمتر، کم‌تکرارها ضریب بیشتر
    const counts = {}
    nextList.forEach(w => counts[w] = (counts[w] || 0) + 1)

    let weighted = []
    for (const w of Object.keys(counts)) {
      const c = counts[w]
      const weight = Math.max(1, Math.floor(5 / c)) // هرچه تکرار بیشتر، وزن کمتر
      for (let k = 0; k < weight; k++) weighted.push(w)
    }

    const next = weighted[Math.floor(Math.random() * weighted.length)]
    result.push(next)

    const len = result.length
    currentKey = `${result[len - 3]} ${result[len - 2]} ${result[len - 1]}`

    if (!chain[currentKey]) break
  }

  return result.join(' ')
}

function looksGood(sentence) {
  const s = sentence.trim()
  if (!s) return false

  const words = s.split(/\s+/)
  if (words.length < 7) return false // خیلی کوتاه است

  const last = words[words.length - 1]
  // پایان با علائم نگارشی خوشگل
  return /[.!؟?؛…]$/.test(last)
}

// خروجی آماده برای بات (بدون کش)
async function generateRandom(chatId, maxWords = 25) {
  const messages = await loadMessagesForChat()
  console.log('MARKOV DEBUG:', chatId, 'messages:', messages.length)

  if (messages.length < 5) return ''

  const { chain, startKeys } = buildChain(messages)

  let fallback = ''

  // تا چند بار تلاش می‌کنیم جمله‌ای بسازیم که پایان مناسبی داشته باشد
  for (let i = 0; i < 3; i++) {
    const sentence = generateFromChain(chain, startKeys, maxWords)
    if (!sentence) continue
    fallback = sentence

    if (looksGood(sentence)) {
      return sentence
    }
  }

  // اگر جمله‌ای با پایان خوب پیدا نشد، همان بهترین جمله را برمی‌گردانیم
  return fallback
}

async function addLearningGroup(chatId) {
  if (!learningCollection) await initDb()
  const key = String(chatId)

  await learningCollection.updateOne(
    { chatId: key },
    { $set: { chatId: key } },
    { upsert: true }
  )
}

async function removeLearningGroup(chatId) {
  if (!learningCollection) await initDb()
  const key = String(chatId)

  await learningCollection.deleteOne({ chatId: key })
}

async function loadLearningGroups() {
  if (!learningCollection) await initDb()

  const docs = await learningCollection
    .find({}, { projection: { chatId: 1, _id: 0 } })
    .toArray()

  return docs
    .map((d) => {
      if (!d || !d.chatId) return null
      const n = Number(d.chatId)
      return Number.isNaN(n) ? d.chatId : n
    })
    .filter((v) => v !== null)
}

module.exports = {
  initDb,
  addMessage,
  generateRandom,
  addLearningGroup,
  removeLearningGroup,
  loadLearningGroups,
}