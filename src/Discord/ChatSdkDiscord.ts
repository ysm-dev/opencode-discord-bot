import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { createDiscordAdapter, type DiscordThreadId } from "@chat-adapter/discord"
import type { AdapterPostableMessage, ChannelInfo, FetchOptions, FetchResult, Message, PostableRaw, RawMessage } from "chat"
import { Duration, Effect } from "effect"
import type { DiscordAttachment, DiscordMessage, DiscordScope } from "../Schema.ts"
import { DiscordError, type DiscordService } from "./DiscordPort.ts"

type ChatDiscordAdapter = {
  readonly encodeThreadId: (input: DiscordThreadId) => string
  readonly postMessage: (threadId: string, message: AdapterPostableMessage) => Promise<RawMessage<unknown>>
  readonly postChannelMessage: (channelId: string, message: AdapterPostableMessage) => Promise<RawMessage<unknown>>
  readonly editMessage: (threadId: string, messageId: string, message: AdapterPostableMessage) => Promise<RawMessage<unknown>>
  readonly deleteMessage: (threadId: string, messageId: string) => Promise<void>
  readonly startTyping: (threadId: string, status?: string) => Promise<void>
  readonly addReaction: (threadId: string, messageId: string, emoji: string) => Promise<void>
  readonly removeReaction: (threadId: string, messageId: string, emoji: string) => Promise<void>
  readonly fetchMessages: (threadId: string, options?: FetchOptions) => Promise<FetchResult<unknown>>
  readonly fetchChannelInfo?: ((channelId: string) => Promise<ChannelInfo>) | undefined
}

type LiveDiscordOptions = {
  readonly botToken: string
  readonly applicationId?: string
  readonly publicKey?: string
}

const threadIdFromScope = (adapter: ChatDiscordAdapter, scope: DiscordScope): string =>
  adapter.encodeThreadId({
    guildId: scope.guildId,
    channelId: scope.channelId,
    ...(scope.threadId === undefined ? {} : { threadId: scope.threadId })
  })

const mentions = (content: string): ReadonlyArray<string> => [...content.matchAll(/<@(\d+)>/g)].map((match) => match[1] ?? "")

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

const attachments = (message: Message<unknown>): ReadonlyArray<DiscordAttachment> =>
  message.attachments.map((item, index) => ({
    id: `${message.id}-${index}`,
    filename: item.name ?? `attachment-${index + 1}`,
    ...(item.mimeType === undefined ? {} : { contentType: item.mimeType }),
    size: item.size ?? 0,
    url: item.url ?? ""
  }))

const fromChatMessage = (scope: DiscordScope, message: Message<unknown>): DiscordMessage => ({
  id: message.id,
  guildId: scope.guildId,
  channelId: scope.channelId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
  author: {
    id: message.author.userId,
    displayName: message.author.fullName,
    nickname: message.author.userName,
    isBot: message.author.isBot === true
  },
  content: message.text,
  timestamp: message.metadata.dateSent.toISOString(),
  mentions: mentions(message.text),
  roleMentions: [...message.text.matchAll(/<@&(\d+)>/g)].map((match) => match[1] ?? ""),
  everyoneMention: message.text.includes("@everyone"),
  hereMention: message.text.includes("@here"),
  attachments: attachments(message),
  reactions: [],
  channelType: "guild"
})

const retryAfterFromCause = (cause: unknown) => {
  if (!isRecord(cause)) return undefined
  const retryAfter = cause.retryAfter
  if (Duration.isDuration(retryAfter)) return retryAfter
  if (typeof cause.retryAfterMs === "number" && Number.isFinite(cause.retryAfterMs) && cause.retryAfterMs >= 0) {
    return Duration.millis(cause.retryAfterMs)
  }
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) return Duration.millis(retryAfter * 1000)
  if (typeof cause.retry_after === "number" && Number.isFinite(cause.retry_after) && cause.retry_after >= 0) {
    return Duration.millis(cause.retry_after * 1000)
  }
  return undefined
}

const validateGuildChannel = async (adapter: ChatDiscordAdapter, guildId: string, channelThreadId: string): Promise<void> => {
  if (adapter.fetchChannelInfo === undefined) return
  const info = await adapter.fetchChannelInfo(channelThreadId)
  if (info.isDM === true) throw new DiscordError({ message: "Discord DMs are not supported" })
  const raw = info.metadata.raw
  const actualGuildId = isRecord(raw) ? stringField(raw, "guild_id") : undefined
  if (actualGuildId !== undefined && actualGuildId !== guildId) {
    throw new DiscordError({ message: "Discord channel does not belong to the requested guild" })
  }
}

const tryAdapter = <A>(operation: () => Promise<A>): Effect.Effect<A, DiscordError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof DiscordError
        ? cause
        : new DiscordError({
            message: cause instanceof Error ? cause.message : "chat-sdk Discord operation failed",
            retryAfter: retryAfterFromCause(cause)
          })
  })

const retryAfterHeader = (response: Response) => {
  const value = response.headers.get("retry-after")
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Duration.millis(seconds * 1000) : undefined
}

type RawDiscordOptions = {
  readonly botToken: string
  readonly apiUrl?: string | undefined
}

const rawDiscord = (options: RawDiscordOptions | undefined, path: string, init: RequestInit): Effect.Effect<unknown, DiscordError> =>
  tryAdapter(async () => {
    if (options === undefined) throw new Error("Discord adapter does not expose this operation")
    const response = await fetch(`${options.apiUrl ?? "https://discord.com/api/v10"}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${options.botToken}`,
        "content-type": "application/json",
        ...init.headers
      }
    })
    if (!response.ok)
      throw new DiscordError({
        message: `Discord REST ${response.status}: ${await response.text()}`,
        retryAfter: retryAfterHeader(response)
      })
    if (response.status === 204) return {}
    return await response.json()
  })

const normalizeMentionsForChatAdapter = (content: string): string => content.replace(/<@!?(\w+)>/g, "@$1")

export const makeChatSdkDiscord = (adapter: ChatDiscordAdapter, raw: RawDiscordOptions | undefined = undefined): DiscordService => ({
  fetchContext: (scope, limit) =>
    tryAdapter(async () => {
      const threadId = threadIdFromScope(adapter, scope)
      const result = await adapter.fetchMessages(threadId, { limit })
      return result.messages.map((message) => fromChatMessage(scope, message))
    }),
  fetchHistory: (scope, limit) =>
    tryAdapter(async () => {
      const threadId = threadIdFromScope(adapter, scope)
      const result = await adapter.fetchMessages(threadId, { limit })
      return result.messages.map((message) => fromChatMessage(scope, message))
    }),
  sendTyping: (scope) => tryAdapter(() => adapter.startTyping(threadIdFromScope(adapter, scope))).pipe(Effect.asVoid),
  postMessage: (scope, content) =>
    tryAdapter(async () => {
      const result = await adapter.postMessage(threadIdFromScope(adapter, scope), normalizeMentionsForChatAdapter(content))
      return { id: result.id }
    }),
  editMessage: (scope, messageId, content) =>
    tryAdapter(() => adapter.editMessage(threadIdFromScope(adapter, scope), messageId, normalizeMentionsForChatAdapter(content))).pipe(
      Effect.asVoid
    ),
  deleteMessage: (scope, messageId) =>
    tryAdapter(() => adapter.deleteMessage(threadIdFromScope(adapter, scope), messageId)).pipe(Effect.asVoid),
  addReaction: (scope, messageId, emoji) =>
    tryAdapter(() => adapter.addReaction(threadIdFromScope(adapter, scope), messageId, emoji)).pipe(Effect.asVoid),
  removeReaction: (scope, messageId, emoji) =>
    tryAdapter(() => adapter.removeReaction(threadIdFromScope(adapter, scope), messageId, emoji)).pipe(Effect.asVoid),
  attachFile: (scope, path) =>
    tryAdapter(async () => {
      const file: PostableRaw = { raw: "", files: [{ filename: basename(path), data: await readFile(path) }] }
      const result = await adapter.postMessage(threadIdFromScope(adapter, scope), file)
      return { path: result.id }
    }),
  createThread: (scope, name) =>
    rawDiscord(raw, `/channels/${scope.channelId}/threads`, {
      method: "POST",
      body: JSON.stringify({ name, type: 11 })
    }).pipe(Effect.map((data) => ({ id: isRecord(data) && typeof data.id === "string" ? data.id : "" }))),
  postChannelMessage: (guildId, channelId, content) =>
    tryAdapter(async () => {
      const encodedChannelId = adapter.encodeThreadId({ guildId, channelId })
      await validateGuildChannel(adapter, guildId, encodedChannelId)
      const result = await adapter.postChannelMessage(
        encodedChannelId,
        normalizeMentionsForChatAdapter(sanitizeGuildContent(guildId, content))
      )
      return { id: result.id }
    }),
  pinMessage: (scope, messageId) =>
    rawDiscord(raw, `/channels/${scope.threadId ?? scope.channelId}/pins/${messageId}`, { method: "PUT" }).pipe(Effect.asVoid),
  unpinMessage: (scope, messageId) =>
    rawDiscord(raw, `/channels/${scope.threadId ?? scope.channelId}/pins/${messageId}`, { method: "DELETE" }).pipe(Effect.asVoid)
})

const sanitizeGuildContent = (_guildId: string, content: string): string => content

export const makeLiveChatSdkDiscord = (options: LiveDiscordOptions): DiscordService =>
  makeChatSdkDiscord(
    createDiscordAdapter({
      botToken: options.botToken,
      ...(options.applicationId === undefined ? {} : { applicationId: options.applicationId }),
      publicKey: options.publicKey ?? "0".repeat(64)
    }),
    { botToken: options.botToken }
  )
