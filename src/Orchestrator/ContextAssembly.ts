import type { OpencodePromptFilePart } from "../Opencode/OpencodePort.ts"
import type { DiscordMessage } from "../Schema.ts"

export type ContextPrompt = {
  readonly text: string
  readonly messages: ReadonlyArray<DiscordMessage>
  readonly parts: ReadonlyArray<OpencodePromptFilePart>
}

type ContextInput = {
  readonly botUserId: string
  readonly contextMessages: ReadonlyArray<DiscordMessage>
  readonly triggerMessage: DiscordMessage
  readonly skippedMessages?: ReadonlyArray<DiscordMessage> | undefined
  readonly maxMessages: number
  readonly maxChars: number
  readonly maxAttachmentBytes: number
}

const preamble = (botUserId: string) =>
  `Discord bridge context for <@${botUserId}>. <@id> pings that user in Discord. Use discord target metadata when calling bridge tools. Do not emit @everyone, @here, or role pings unless explicitly allowed.`

const timestamp = (value: string): string => {
  const date = new Date(value)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hour = String(date.getUTCHours()).padStart(2, "0")
  const minute = String(date.getUTCMinutes()).padStart(2, "0")
  return `${year}-${month}-${day} ${hour}:${minute} UTC`
}

const attachmentSummary = (message: DiscordMessage): string | undefined => {
  if (message.attachments.length === 0) return undefined
  return `(attachments: ${message.attachments
    .map((item) => `${item.filename} [${item.contentType ?? "unknown"}; ${item.size} bytes; ${item.url}]`)
    .join(", ")})`
}

const reactionSummary = (message: DiscordMessage): string | undefined => {
  if (message.reactions.length === 0) return undefined
  return `(reactions: ${message.reactions.map((item) => `${item.emoji} x${item.count}`).join(", ")})`
}

const targetSummary = (message: DiscordMessage): string => {
  const thread = message.threadId === undefined ? "" : ` threadId=${message.threadId}`
  return `(discord target: guildId=${message.guildId} channelId=${message.channelId}${thread} messageId=${message.id})`
}

const isForwardableMime = (mime: string): boolean =>
  mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("audio/") || mime.startsWith("text/")

const attachmentParts = (messages: ReadonlyArray<DiscordMessage>, maxBytes: number): ReadonlyArray<OpencodePromptFilePart> =>
  messages.flatMap((message) =>
    message.attachments.flatMap((attachment) => {
      const mime = attachment.contentType
      if (mime === undefined || attachment.size > maxBytes || !isForwardableMime(mime)) return []
      return [{ type: "file", mime, filename: attachment.filename, url: attachment.url } satisfies OpencodePromptFilePart]
    })
  )

export const formatDiscordMessage = (message: DiscordMessage): string => {
  const label = message.author.nickname ?? message.author.displayName
  const lines = [`[${label} | <@${message.author.id}> | ${timestamp(message.timestamp)}]`, message.content]
  lines.push(targetSummary(message))
  const attachments = attachmentSummary(message)
  const reactions = reactionSummary(message)
  if (attachments !== undefined) lines.push(attachments)
  if (reactions !== undefined) lines.push(reactions)
  return lines.join("\n")
}

const dedupeContext = (input: ContextInput): ReadonlyArray<DiscordMessage> => {
  const seen = new Set<string>()
  const context: Array<DiscordMessage> = []
  const maxMessages = Math.max(1, input.maxMessages)
  const skipped = (input.skippedMessages ?? [])
    .filter((message) => message.id !== input.triggerMessage.id)
    .filter((message) => {
      if (seen.has(message.id)) return false
      seen.add(message.id)
      return true
    })
    .slice(-Math.max(0, maxMessages - 1))
  const skippedIds = new Set(skipped.map((message) => message.id))
  for (const message of input.contextMessages) {
    if (message.id === input.triggerMessage.id || skippedIds.has(message.id) || seen.has(message.id)) continue
    seen.add(message.id)
    context.push(message)
  }
  const retainedLimit = Math.max(0, maxMessages - skipped.length - 1)
  const retained = context.slice(Math.max(0, context.length - retainedLimit))
  return [...retained, ...skipped, input.triggerMessage]
}

const renderPrompt = (
  botUserId: string,
  messages: ReadonlyArray<DiscordMessage>,
  skippedMessages: ReadonlyArray<DiscordMessage>
): string => {
  const skippedIds = new Set(skippedMessages.map((message) => message.id))
  return [
    preamble(botUserId),
    ...messages.map((message) => `${skippedIds.has(message.id) ? "(queued intermediate message)\n" : ""}${formatDiscordMessage(message)}`)
  ].join("\n\n")
}

export const assembleContextPrompt = (input: ContextInput): ContextPrompt => {
  const skippedMessages = input.skippedMessages ?? []
  const messages = [...dedupeContext(input)]
  while (messages.length > 1 && renderPrompt(input.botUserId, messages, skippedMessages).length > input.maxChars) {
    messages.shift()
  }
  const text = renderPrompt(input.botUserId, messages, skippedMessages)
  return {
    messages,
    parts: attachmentParts(messages, input.maxAttachmentBytes),
    text: text.length <= input.maxChars ? text : text.slice(0, input.maxChars)
  }
}
