import 'dotenv/config'

import strings from './src/strings.js'
import {
  BOT_TOKEN,
  OWNER_ID,
  PORT,
  RANDOM_TALK_CHANCE,
  RANDOM_TALK_INTERVAL_MS,
  RANDOM_TALK_ACTIVE_WINDOW_MS,
  RANDOM_TALK_REQUIRED_MESSAGES,
  DAILY_TIMEZONE,
} from './src/config.js'
import { createBot } from './src/bot/bot.js'
import { startHealthServer } from './src/http/health.js'
import { loadLearningGroups } from './src/data/learning-groups.js'

let botInstance

async function main() {
  const learningIds = await loadLearningGroups()

  const randomConfig = {
    chance: RANDOM_TALK_CHANCE,
    intervalMs: RANDOM_TALK_INTERVAL_MS,
    activeWindowMs: RANDOM_TALK_ACTIVE_WINDOW_MS,
    minMessages: RANDOM_TALK_REQUIRED_MESSAGES,
    dailyTimezone: DAILY_TIMEZONE,
  }

  botInstance = createBot({
    botToken: BOT_TOKEN,
    ownerId: OWNER_ID,
    strings,
    initialLearningGroups: learningIds,
    randomConfig,
  })

  startHealthServer(PORT)

  await botInstance.launch()
  console.log('🤖 Bot started...')
}

main().catch((err) => {
  console.error('Bot failed:', err)
  process.exit(1)
})

process.once('SIGINT', () => botInstance?.stop('SIGINT'))
process.once('SIGTERM', () => botInstance?.stop('SIGTERM'))
