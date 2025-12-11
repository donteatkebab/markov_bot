export function createSendQueue(bot) {
  const sendQueue = []
  let isSending = false

  async function processQueue() {
    if (isSending || sendQueue.length === 0) return
    isSending = true

    const job = sendQueue.shift()

    try {
      if (job.replyTo) {
        await bot.telegram.sendMessage(job.chatId, job.text, {
          reply_to_message_id: job.replyTo,
        })
      } else {
        await bot.telegram.sendMessage(job.chatId, job.text)
      }
    } catch (err) {
      console.error('sendQueue error:', err.message)

      const retryAfter =
        (err.parameters && err.parameters.retry_after) ||
        (err.on && err.on.parameters && err.on.parameters.retry_after)

      if (retryAfter && Number.isFinite(retryAfter)) {
        const delayMs = (retryAfter + 1) * 1000
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }

    isSending = false
  }

  setInterval(processQueue, 1000)

  function safeSend(chatId, text, replyTo = null) {
    sendQueue.push({ chatId, text, replyTo })
  }

  return { safeSend }
}
