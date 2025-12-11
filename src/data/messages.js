import { getCollections } from './mongo.js'

function cleanText(text) {
  if (typeof text !== 'string') return ''

  let cleaned = text

  cleaned = cleaned.replace(/https?:\/\/\S+/gi, '')
  cleaned = cleaned.replace(/www\.\S+/gi, '')
  cleaned = cleaned.replace(
    /\b\S+\.(com|net|org|ir|io|me|app|xyz|info|site|online|shop|top)\S*/gi,
    ''
  )
  cleaned = cleaned.replace(/@[a-zA-Z0-9_]{3,32}/g, '')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  return cleaned
}

export async function addMessage(chatId, text) {
  const cleaned = cleanText(text)
  if (!cleaned || cleaned.length < 2) return

  const { messages } = await getCollections()
  const key = String(chatId)

  await messages.updateOne(
    { chatId: key },
    { $push: { messages: cleaned } },
    { upsert: true }
  )
}

export async function loadAllMessages() {
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
