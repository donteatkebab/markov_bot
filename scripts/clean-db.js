import 'dotenv/config'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const DB_NAME = process.env.MONGO_DB_NAME || 'markov_bot'
const COLLECTION = process.env.MONGO_COLLECTION || 'groups'

// Run mode
const DRY_RUN = process.env.DRY_RUN !== '0' // default: true
const BATCH = Number(process.env.BATCH || 50)

// Same “troll-like” constraints you added in index.js
const MAX_WORD_LEN = 11
const MAX_AVG_WORD_LEN = 6.5
const MAX_TEXT_LEN = 220

function normalizePersian(text) {
  return String(text || '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/‌/g, ' ') // ZWNJ to space
    .replace(/ـ+/g, '') // keshide
    .replace(/\s+/g, ' ')
    .trim()
}

function collapseRepeatedHalves(text) {
  if (typeof text !== 'string') return text
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 6) return text

  let current = words
  for (let iter = 0; iter < 2; iter++) {
    if (current.length % 2 !== 0) break
    const half = current.length / 2
    const a = current.slice(0, half).join(' ')
    const b = current.slice(half).join(' ')
    if (a !== b) break
    current = current.slice(0, half)
  }
  return current.join(' ')
}

function hasTooMuchEmoji(text) {
  const emojiCount = (text.match(/[\p{Emoji}]/gu) || []).length
  return emojiCount > 0 && emojiCount / text.length > 0.5
}

function hasStretchedChars(text) {
  return /(.)\1{3,}/u.test(text)
}

function hasAnyLinkOrMention(text) {
  return (
    /https?:\/\/\S+/i.test(text) ||
    /www\.\S+/i.test(text) ||
    /\b\S+\.(com|net|org|ir|io|me|app|xyz|info|site|online|shop|top)\b/i.test(text) ||
    /t\.me\/\S+/i.test(text) ||
    /telegram\.me\/\S+/i.test(text) ||
    /@[a-zA-Z0-9_]{3,32}/.test(text)
  )
}

function isFormal(text) {
  return /(لذا|بدین|می‌باشد|میباشد|نتیجه‌گیری|ساختار|تحلیل)/.test(text)
}

function isValidMessage(raw) {
  if (typeof raw !== 'string') return { ok: false }
  let text = normalizePersian(raw)
  if (!text) return { ok: false }

  // Same filters as index.js
  if (/[A-Za-z]/.test(text)) return { ok: false }
  if (hasAnyLinkOrMention(text)) return { ok: false }
  if (text.length < 6) return { ok: false }
  if (text.length > MAX_TEXT_LEN) return { ok: false }
  if (hasTooMuchEmoji(text)) return { ok: false }
  if (hasStretchedChars(text)) return { ok: false }
  if (isFormal(text)) return { ok: false }

  // Word-based filters
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return { ok: false }
  if (words.some((w) => w.length > MAX_WORD_LEN)) return { ok: false }
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / words.length
  if (avgWordLen > MAX_AVG_WORD_LEN) return { ok: false }

  // Normalize repeated halves (keeps it troll-ish but not spammy)
  text = collapseRepeatedHalves(text)
  if (!text || text.length < 6) return { ok: false }

  return { ok: true, text }
}

function dedupeSmart(list) {
  const out = []
  const seen = new Set()
  let last = ''
  for (const t of list) {
    if (!t) continue
    if (t === last) continue // consecutive dup
    if (seen.has(t)) continue // global dup inside same chat doc
    seen.add(t)
    out.push(t)
    last = t
  }
  return out
}

async function main() {
  if (!MONGO_URI) throw new Error('MONGO_URI is missing')
  const client = new MongoClient(MONGO_URI)
  await client.connect()

  const db = client.db(DB_NAME)
  const col = db.collection(COLLECTION)

  console.log('Connected:', DB_NAME, '/', COLLECTION)
  console.log('Mode:', DRY_RUN ? 'DRY_RUN (no writes)' : 'WRITE')

  const cursor = col.find({}, { projection: { chatId: 1, messages: 1 } })
  let totalDocs = 0
  let totalBefore = 0
  let totalAfter = 0
  let totalRemoved = 0
  let bulk = []

  while (await cursor.hasNext()) {
    const doc = await cursor.next()
    totalDocs++

    const arr = Array.isArray(doc.messages) ? doc.messages : []
    totalBefore += arr.length

    const cleaned = []
    for (const raw of arr) {
      const r = isValidMessage(raw)
      if (r.ok) cleaned.push(r.text)
    }

    const finalList = dedupeSmart(cleaned)
    totalAfter += finalList.length
    totalRemoved += arr.length - finalList.length

    const changed =
      arr.length !== finalList.length ||
      arr.some((x, i) => normalizePersian(x) !== finalList[i])

    if (changed) {
      bulk.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { messages: finalList } },
        },
      })
    }

    if (bulk.length >= BATCH) {
      if (!DRY_RUN) {
        const res = await col.bulkWrite(bulk, { ordered: false })
        console.log('bulkWrite:', res.modifiedCount, 'modified')
      } else {
        console.log('bulkPlan:', bulk.length, 'docs would be updated')
      }
      bulk = []
    }
  }

  if (bulk.length) {
    if (!DRY_RUN) {
      const res = await col.bulkWrite(bulk, { ordered: false })
      console.log('bulkWrite:', res.modifiedCount, 'modified')
    } else {
      console.log('bulkPlan:', bulk.length, 'docs would be updated')
    }
  }

  console.log('Docs:', totalDocs)
  console.log('Messages before:', totalBefore)
  console.log('Messages after :', totalAfter)
  console.log('Removed:', totalRemoved)

  await client.close()
  console.log('Done.')
}

main().catch((e) => {
  console.error('Cleaner failed:', e)
  process.exit(1)
})