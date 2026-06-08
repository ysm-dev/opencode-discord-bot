import type { BotIdentity, DiscordMessage, DiscordScope } from "../Schema.ts"

export const toDiscordScope = (message: DiscordMessage): DiscordScope => ({
  guildId: message.guildId,
  channelId: message.channelId,
  ...(message.threadId === undefined ? {} : { threadId: message.threadId })
})

const isDirectMention = (message: DiscordMessage, bot: BotIdentity): boolean => message.mentions.includes(bot.userId)

const canConsiderMessage = (message: DiscordMessage, bot: BotIdentity): boolean => {
  if (message.channelType === "dm") return false
  if (message.isSystem === true) return false
  if (message.author.id === bot.userId) return false
  if (message.author.isBot) return false
  return true
}

export const shouldTriggerTurn = (message: DiscordMessage, bot: BotIdentity, activeThread: boolean): boolean => {
  if (!canConsiderMessage(message, bot)) return false
  if (isDirectMention(message, bot)) return true
  return message.threadId !== undefined && activeThread
}

export const isThreadActiveFromContext = (messages: ReadonlyArray<DiscordMessage>, bot: BotIdentity): boolean =>
  messages.some((message) => message.threadId !== undefined && (message.author.id === bot.userId || isDirectMention(message, bot)))
