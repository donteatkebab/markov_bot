const requiredEnv = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  OWNER_ID: process.env.OWNER_ID,
  MONGO_URI: process.env.MONGO_URI,
}

if (!requiredEnv.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set in environment variables')
}

if (!requiredEnv.OWNER_ID || Number.isNaN(Number(requiredEnv.OWNER_ID))) {
  throw new Error('OWNER_ID is not set or invalid')
}

if (!requiredEnv.MONGO_URI) {
  throw new Error('MONGO_URI is not set in environment variables')
}

export const BOT_TOKEN = requiredEnv.BOT_TOKEN
export const OWNER_ID = Number(requiredEnv.OWNER_ID)
export const MONGO_URI = requiredEnv.MONGO_URI

export const MONGO_DB_NAME = 'markov_bot'
export const MONGO_COLLECTION = 'groups'

export const PORT = Number(process.env.PORT || 3000)

export const RANDOM_TALK_CHANCE = 0.2
export const RANDOM_TALK_INTERVAL_MS = 60 * 1000
export const RANDOM_TALK_ACTIVE_WINDOW_MS = 15 * 60 * 1000
export const RANDOM_TALK_REQUIRED_MESSAGES = 10

export const DAILY_TIMEZONE = 'Asia/Tehran'

export const GEN_CONFIG = {
  order: 4,
  maxHops: 1,
}
