import cron from 'node-cron'

export function scheduleDailyMessage({ state, safeSend, message, timezone }) {
  cron.schedule(
    '0 0 * * *',
    () => {
      if (state.knownGroups.size === 0) return
      for (const chatId of state.knownGroups) {
        safeSend(chatId, message)
      }
    },
    {
      timezone,
    }
  )
}
