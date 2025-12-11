import { loadAllMessages } from '../data/messages.js'

function buildChain(messages) {
  const chain = {}
  const startKeys = []

  for (const text of messages) {
    const normalized = text.trim()
    if (!normalized) continue

    const sentence = normalized
    const words = sentence.split(/\s+/).filter(Boolean)

    if (words.length < 4) continue

    const badEndings = [
      'به',
      'تو',
      'برای',
      'با',
      'از',
      'در',
      'که',
      'و',
      'یا',
      'تا',
      'پیش',
      'روی',
      'زیر',
      'توی',
      'سر',
      'داخل',
    ]
    const lastWord = words[words.length - 1]
    if (badEndings.includes(lastWord)) {
      continue
    }

    const startKey = `${words[0]} ${words[1]} ${words[2]}`
    startKeys.push(startKey)

    for (let i = 0; i < words.length - 3; i++) {
      const w1 = words[i]
      const w2 = words[i + 1]
      const w3 = words[i + 2]
      const w4 = words[i + 3]

      const key = `${w1} ${w2} ${w3}`

      if (!chain[key]) {
        chain[key] = []
      }
      chain[key].push(w4)
    }
  }

  return { chain, startKeys }
}

function generateFromChain(chain, startKeys, maxWords = 25) {
  const keys = Object.keys(chain)
  if (keys.length === 0) return ''

  let currentKey

  if (Array.isArray(startKeys) && startKeys.length > 0) {
    const chosen = startKeys[Math.floor(Math.random() * startKeys.length)]
    if (chain[chosen]) {
      currentKey = chosen
    } else {
      currentKey = keys[Math.floor(Math.random() * keys.length)]
    }
  } else {
    currentKey = keys[Math.floor(Math.random() * keys.length)]
  }

  const parts = currentKey.split(' ')
  if (parts.length < 3) return ''

  const result = [...parts]

  for (let i = 0; i < maxWords - 3; i++) {
    const nextList = chain[currentKey]
    if (!nextList || nextList.length === 0) break

    const counts = {}
    nextList.forEach((w) => (counts[w] = (counts[w] || 0) + 1))

    let weighted = []
    for (const w of Object.keys(counts)) {
      const c = counts[w]
      const weight = Math.max(1, Math.floor(5 / c))
      for (let k = 0; k < weight; k++) weighted.push(w)
    }

    const next = weighted[Math.floor(Math.random() * weighted.length)]
    result.push(next)

    const len = result.length
    currentKey = `${result[len - 3]} ${result[len - 2]} ${result[len - 1]}`

    if (!chain[currentKey]) break
  }

  return result.join(' ')
}

function looksGood(sentence) {
  const s = sentence.trim()
  if (!s) return false

  const words = s.split(/\s+/)
  if (words.length < 7) return false

  const last = words[words.length - 1]
  return /[.!؟?؛…]$/.test(last)
}

export async function generateRandomSentence(chatId, maxWords = 25) {
  const messages = await loadAllMessages()
  console.log('MARKOV DEBUG:', chatId, 'messages:', messages.length)

  if (messages.length < 5) return ''

  const { chain, startKeys } = buildChain(messages)

  let fallback = ''

  for (let i = 0; i < 3; i++) {
    const sentence = generateFromChain(chain, startKeys, maxWords)
    if (!sentence) continue
    fallback = sentence

    if (looksGood(sentence)) {
      return sentence
    }
  }

  return fallback
}
