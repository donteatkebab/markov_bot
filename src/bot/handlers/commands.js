export function registerCommandHandlers(bot, deps) {
  const {
    ownerId,
    strings,
    state,
    safeSend,
    generateNonDuplicate,
    storeSentence,
    addLearningGroup,
    removeLearningGroup,
  } = deps

  bot.command(strings.TRAIN_CMD, async (ctx) => {
    if (ctx.from.id !== ownerId) return
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

    state.learningGroups.add(ctx.chat.id)
    try {
      await addLearningGroup(ctx.chat.id)
    } catch (e) {
      console.error('failed to persist learning group:', e.message)
    }
    safeSend(ctx.chat.id, strings.TRAIN_ENABLED)
  })

  bot.command(strings.UNTRAIN_CMD, async (ctx) => {
    if (ctx.from.id !== ownerId) return
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

    state.learningGroups.delete(ctx.chat.id)
    try {
      await removeLearningGroup(ctx.chat.id)
    } catch (e) {
      console.error('failed to remove learning group:', e.message)
    }
    safeSend(ctx.chat.id, strings.TRAIN_DISABLED)
  })

  bot.command(strings.COMMAND_KEY, async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return

    const sentence = await generateNonDuplicate(ctx.chat.id, 25)

    if (!sentence) {
      safeSend(ctx.chat.id, strings.NEED_MORE_DATA)
      return
    }

    safeSend(ctx.chat.id, sentence)
    storeSentence(ctx.chat.id, sentence)
  })
}
