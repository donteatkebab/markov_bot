const fs = require('fs')
const path = require('path')

const MESSAGES_FILE = path.join(__dirname, 'data', 'messages.json')

// خواندن پیام‌ها برای یک چت خاص (گروه)
function loadMessagesForChat(chatId) {
  try {
    const raw = fs.readFileSync(MESSAGES_FILE, 'utf-8')
    const data = JSON.parse(raw)
    const key = String(chatId)

    // فقط ساختار جدید: map از chatId → آرایه پیام‌ها
    if (!data || typeof data !== 'object' || Array.isArray(data)) return []

    const arr = data[key]
    if (!Array.isArray(arr)) return []

    return arr
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  } catch (e) {
    console.error('loadMessagesForChat error:', e.message)
    return []
  }
}

// ساخت زنجیره‌ی مارکوف (bi-gram ساده: هر کلمه → لیستی از کلمه‌های بعدی)
function buildChain(messages) {
  const chain = {}

  for (const text of messages) {
    // خیلی ساده: اسپلیت با فاصله
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length < 2) continue

    for (let i = 0; i < words.length - 1; i++) {
      const w1 = words[i]
      const w2 = words[i + 1]

      if (!chain[w1]) {
        chain[w1] = []
      }
      chain[w1].push(w2)
    }
  }

  return chain
}

// تولید یک جمله‌ی رندوم از روی زنجیره
function generateFromChain(chain, maxWords = 25) {
  const keys = Object.keys(chain)
  if (keys.length === 0) return ''

  // شروع از یک کلمه‌ی تصادفی
  let current = keys[Math.floor(Math.random() * keys.length)]
  const result = [current]

  for (let i = 0; i < maxWords; i++) {
    const nextList = chain[current]
    if (!nextList || nextList.length === 0) break

    const next = nextList[Math.floor(Math.random() * nextList.length)]

    result.push(next)
    current = next
  }

  return result.join(' ')
}

// فانکشن آماده برای استفاده در بات (per-group)
function generateRandom(chatId, maxWords = 25) {
  const messages = loadMessagesForChat(chatId)
  console.log('MARKOV DEBUG:', chatId, 'messages:', messages.length)

  if (messages.length < 5) {
    return '' // دیتای این گروه کمه، بی‌خیال
  }

  const chain = buildChain(messages)
  return generateFromChain(chain, maxWords)
}

module.exports = {
  generateRandom,
}
