import 'dotenv/config'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const DB_NAME = 'markov_bot'
const COLLECTION = 'groups'

// ====== same rules as index.js ======
function normalizePersian(text) {
  return String(text || '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/‌/g, ' ') // ZWNJ to space
    .replace(/ـ+/g, '') // keshide
    .replace(/\s+/g, ' ')
    .trim()
}

function hasTooMuchEmoji(text) {
  // Needs Node 16+ with unicode property escapes
  const emojiCount = (text.match(/[\p{Emoji}]/gu) || []).length
  return emojiCount > 0 && emojiCount / text.length > 0.5
}

function hasStretchedChars(text) {
  return /(.)\1{3,}/u.test(text)
}

function collapseRepeatedHalves(text) {
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

function shouldDrop(text) {
  if (!text) return true
  if (/[A-Za-z]/.test(text)) return true

  const hasLink =
    /https?:\/\/\S+/i.test(text) ||
    /www\.\S+/i.test(text) ||
    /\b\S+\.(com|net|org|ir|io|me|app|xyz|info|site|online|shop|top)\b/i.test(text) ||
    /t\.me\/\S+/i.test(text) ||
    /telegram\.me\/\S+/i.test(text) ||
    /@[a-zA-Z0-9_]{3,32}/.test(text)

  if (hasLink) return true

  if (text.length < 6) return true
  if (text.length > 350) return true
  if (hasTooMuchEmoji(text)) return true
  if (hasStretchedChars(text)) return true

  return false
}

function cleanMessage(raw) {
  const t = normalizePersian(raw)
  if (shouldDrop(t)) return null
  const collapsed = collapseRepeatedHalves(t)
  if (!collapsed || shouldDrop(collapsed)) return null
  return collapsed
}

// ====== main ======
async function main() {
  if (!MONGO_URI) throw new Error('MONGO_URI missing')

  const client = new MongoClient(MONGO_URI)
  await client.connect()

  const db = client.db(DB_NAME)
  const col = db.collection(COLLECTION)

  const cursor = col.find({}, { projection: { chatId: 1, messages: 1 } })

  let total = 0
  let kept = 0
  let dropped = 0
  let updatedDocs = 0

  while (await cursor.hasNext()) {
    const doc = await cursor.next()
    const msgs = Array.isArray(doc.messages) ? doc.messages : []

    total += msgs.length

    const cleaned = []
    const seen = new Set() // global dedupe inside this chat's list (exact match)
    for (const m of msgs) {
      const cm = cleanMessage(m)
      if (!cm) {
        dropped++
        continue
      }
      // optional: dedupe exact duplicates inside same chat
      if (seen.has(cm)) {
        dropped++
        continue
      }
      seen.add(cm)
      cleaned.push(cm)
      kept++
    }

    // Only update if changed (saves writes)
    const changed = cleaned.length !== msgs.length
    if (changed) {
      await col.updateOne(
        { _id: doc._id },
        { $set: { messages: cleaned } }
      )
      updatedDocs++
    }
  }

  await client.close()

  console.log('Done ✅')
  console.log({ total, kept, dropped, updatedDocs })
}

main().catch((e) => {
  console.error('Cleanup failed:', e)
  process.exit(1)
})