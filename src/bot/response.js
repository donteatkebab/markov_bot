import { isDuplicate } from './dedup.js'
import {
  generateRandomSentence,
  generateRandomMessage,
  generateRandomWord,
} from '../services/markov.js'

export function createResponder(lastSentMap) {
  return async function generateResponse(
    chatId,
    { maxWords = 25, hints = [] } = {}
  ) {
    let lastCandidate = ''
    let sawDuplicate = false
    const retryLogs = []

    for (let i = 0; i < 2; i++) {
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
          'used: 4-gram'
        )
        return { text: candidate, strategy: 'markov' }
      }
      sawDuplicate = true
      retryLogs.push(candidate)
    }

    if (sawDuplicate) {
      const randomMsg = await generateRandomMessage(chatId)
      if (randomMsg && !isDuplicate(lastSentMap, chatId, randomMsg)) {
        console.log(
          'MARKOV DEBUG:',
          chatId,
          'retry:',
          retryLogs.length,
          'used: 4-gram'
        )
        return { text: randomMsg, strategy: 'random-message' }
      }
    }

    const randomWord = await generateRandomWord(chatId)
    if (randomWord) {
      console.log(
        'MARKOV DEBUG:',
        chatId,
        'retry:',
        retryLogs.length,
        'used: 4-gram'
      )
      return { text: randomWord, strategy: 'random-word' }
    }

    return { text: lastCandidate, strategy: 'none' }
  }
}
