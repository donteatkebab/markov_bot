import { MongoClient } from 'mongodb'
import {
  MONGO_URI,
  MONGO_DB_NAME,
  MONGO_COLLECTION,
} from '../config.js'

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
