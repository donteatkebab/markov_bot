import { isDuplicate } from './dedup.js'
import { generateRandomSentence } from '../services/markov.js'

export function createResponder(lastSentMap) {
  return async function generateResponse(
    chatId,
    { maxWords = 25, hints = [] } = {}
  ) {
    let lastCandidate = ''
    const retryLogs = []

    for (let i = 0; i < 3; i++) {
      const candidate = await generateRandomSentence(chatId, maxWords, hints, {
        log: false,
      })
      if (!candidate) continue
      lastCandidate = candidate
      if (!isDuplicate(lastSentMap, chatId, candidate)) {
        console.log(
          'MARKOV DEBUG:',
          chatId,
          'retry:',
          retryLogs.length,
          'used: markov'
        )
        return { text: candidate, strategy: 'markov' }
      }
      retryLogs.push(candidate)
    }

    return { text: lastCandidate, strategy: 'none' }
  }
}
