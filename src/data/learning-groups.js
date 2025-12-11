import { getCollections } from './mongo.js'

export async function addLearningGroup(chatId) {
  const { learningGroups } = await getCollections()
  const key = String(chatId)

  await learningGroups.updateOne(
    { chatId: key },
    { $set: { chatId: key } },
    { upsert: true }
  )
}

export async function removeLearningGroup(chatId) {
  const { learningGroups } = await getCollections()
  const key = String(chatId)

  await learningGroups.deleteOne({ chatId: key })
}

export async function loadLearningGroups() {
  const { learningGroups } = await getCollections()

  const docs = await learningGroups
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
