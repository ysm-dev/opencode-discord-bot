import type { OpencodePromptFilePart } from "../Opencode/OpencodePort.ts"
import type { DiscordMessage, DiscordScope } from "../Schema.ts"

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
  `Discord bridge context for <@${botUserId}>. Plain assistant text is streamed to Discord automatically; do not use bridge tools to send messages. <@id> pings that user in Discord; use the participants list to map server nicknames/display names to their <@id> values. When a display name is shared, the message header also includes that author's <@id>. For non-message bridge tools, combine the discord default scope or message target override with the header messageId. Do not emit @everyone, @here, or role pings unless explicitly allowed.`

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

const scopeOf = (message: DiscordMessage): DiscordScope => ({
  guildId: message.guildId,
  channelId: message.channelId,
  ...(message.threadId === undefined ? {} : { threadId: message.threadId })
})

const sameScope = (left: DiscordScope, right: DiscordScope): boolean =>
  left.guildId === right.guildId && left.channelId === right.channelId && left.threadId === right.threadId

const scopeSummary = (scope: DiscordScope): string => {
  const thread = scope.threadId === undefined ? "" : ` threadId=${scope.threadId}`
  return `guildId=${scope.guildId} channelId=${scope.channelId}${thread}`
}

const defaultScopeSummary = (scope: DiscordScope): string => `(discord default scope: ${scopeSummary(scope)})`

const targetSummary = (scope: DiscordScope): string => `(discord target: ${scopeSummary(scope)})`

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

const authorLabel = (message: DiscordMessage): string => message.author.nickname ?? message.author.displayName

type ParticipantsSummary = {
  readonly text: string | undefined
  readonly ambiguousAuthorIds: ReadonlySet<string>
}

const participantsSummary = (messages: ReadonlyArray<DiscordMessage>): ParticipantsSummary => {
  const participants: Array<{ readonly id: string; readonly label: string }> = []
  const seenAuthorIds = new Set<string>()
  const authorIdsByLabel = new Map<string, Set<string>>()

  for (const message of messages) {
    const id = message.author.id
    if (seenAuthorIds.has(id)) continue
    seenAuthorIds.add(id)

    const label = authorLabel(message)
    participants.push({ id, label })

    const authorIds = authorIdsByLabel.get(label)
    if (authorIds === undefined) authorIdsByLabel.set(label, new Set([id]))
    else authorIds.add(id)
  }

  const ambiguousAuthorIds = new Set<string>()
  for (const authorIds of authorIdsByLabel.values()) {
    if (authorIds.size <= 1) continue
    for (const id of authorIds) ambiguousAuthorIds.add(id)
  }

  return {
    ambiguousAuthorIds,
    text:
      participants.length === 0 ? undefined : `(participants)\n${participants.map((item) => `${item.label} - <@${item.id}>`).join("\n")}`
  }
}

export const formatDiscordMessage = (
  message: DiscordMessage,
  defaultScope?: DiscordScope,
  ambiguousAuthorIds?: ReadonlySet<string>
): string => {
  const label = authorLabel(message)
  const author = ambiguousAuthorIds?.has(message.author.id) === true ? `${label} | <@${message.author.id}>` : label
  const scope = scopeOf(message)
  const lines = [`[${author} | ${timestamp(message.timestamp)} | messageId=${message.id}]`, message.content]
  if (defaultScope === undefined || !sameScope(scope, defaultScope)) lines.push(targetSummary(scope))
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
  const latestMessage = messages.at(-1)
  const defaultScope = latestMessage === undefined ? undefined : scopeOf(latestMessage)
  const participants = participantsSummary(messages)
  return [
    preamble(botUserId),
    ...(participants.text === undefined ? [] : [participants.text]),
    ...(defaultScope === undefined ? [] : [defaultScopeSummary(defaultScope)]),
    ...messages.map(
      (message) =>
        `${skippedIds.has(message.id) ? "(queued intermediate message)\n" : ""}${formatDiscordMessage(message, defaultScope, participants.ambiguousAuthorIds)}`
    )
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
