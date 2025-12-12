import { loadAllMessages } from '../data/messages.js'

function buildChains(messages) {
  const chain4 = {}
  const chain5 = {}
  const startKeys4 = []
  const startKeys5 = []

  for (const text of messages) {
    const normalized = text.trim()
    if (!normalized) continue

    const words = normalized.split(/\s+/).filter(Boolean)
    if (words.length < 4) continue

    // 4-gram start (3-word key)
    startKeys4.push(`${words[0]} ${words[1]} ${words[2]}`)

    for (let i = 0; i < words.length - 3; i++) {
      const key4 = `${words[i]} ${words[i + 1]} ${words[i + 2]}`
      const next = words[i + 3]
      if (!chain4[key4]) chain4[key4] = []
      chain4[key4].push(next)
    }

    if (words.length >= 5) {
      // 5-gram start (4-word key)
      startKeys5.push(
        `${words[0]} ${words[1]} ${words[2]} ${words[3]}`
      )

      for (let i = 0; i < words.length - 4; i++) {
        const key5 = `${words[i]} ${words[i + 1]} ${words[i + 2]} ${words[i + 3]}`
        const next = words[i + 4]
        if (!chain5[key5]) chain5[key5] = []
        chain5[key5].push(next)
      }
    }
  }

  return { chain4, chain5, startKeys4, startKeys5 }
}

function chooseStartKey({ chain4, chain5, startKeys4, startKeys5 }) {
  const keys5 = Object.keys(chain5)
  const keys4 = Object.keys(chain4)

  if (startKeys5.length > 0) {
    const chosen = startKeys5[Math.floor(Math.random() * startKeys5.length)]
    if (chain5[chosen]) return chosen
  }

  if (keys5.length > 0) {
    return keys5[Math.floor(Math.random() * keys5.length)]
  }

  if (startKeys4.length > 0) {
    const chosen = startKeys4[Math.floor(Math.random() * startKeys4.length)]
    if (chain4[chosen]) return chosen
  }

  if (keys4.length > 0) {
    return keys4[Math.floor(Math.random() * keys4.length)]
  }

  return ''
}

function generateFromChains(chains, maxWords = 25, onModelUsed) {
  const startKey = chooseStartKey(chains)
  if (!startKey) return ''

  const result = startKey.split(' ')

  for (let i = result.length; i < maxWords; i++) {
    let nextList = null
    const len = result.length

    if (len >= 4) {
      const key5 = result.slice(len - 4, len).join(' ')
      nextList = chains.chain5[key5]
      if (nextList) {
        onModelUsed?.('5-gram')
      }
    }

    if (!nextList && len >= 3) {
      const key4 = result.slice(len - 3, len).join(' ')
      nextList = chains.chain4[key4]
      if (nextList) {
        onModelUsed?.('4-gram')
      }
    }

    if (!nextList || nextList.length === 0) break

    const next = nextList[Math.floor(Math.random() * nextList.length)]
    result.push(next)
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
  if (messages.length < 5) return ''

  const chains = buildChains(messages)

  let fallback = ''
  let usedForFallback = 'none'
  let chosen = ''

  for (let i = 0; i < 3; i++) {
    const usedModels = new Set()
    const sentence = generateFromChains(chains, maxWords, (model) =>
      usedModels.add(model)
    )
    if (!sentence) continue
    fallback = sentence
    usedForFallback =
      usedModels.size > 0 ? Array.from(usedModels).sort().join(',') : 'none'

    if (looksGood(sentence)) {
      chosen = sentence
      break
    }
  }

  const finalSentence = chosen || fallback
  if (finalSentence) {
    console.log(
      'MARKOV DEBUG:',
      chatId,
      'messages:',
      messages.length,
      'used:',
      usedForFallback
    )
  }

  return finalSentence
}
