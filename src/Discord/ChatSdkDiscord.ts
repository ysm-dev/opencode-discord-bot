import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { createDiscordAdapter, type DiscordThreadId } from "@chat-adapter/discord"
import type { AdapterPostableMessage, FetchOptions, FetchResult, Message, PostableRaw, RawMessage } from "chat"
import { Duration, Effect } from "effect"
import type { DiscordAttachment, DiscordMessage, DiscordReaction, DiscordScope } from "../Schema.ts"
import { DiscordError, type DiscordService } from "./DiscordPort.ts"
import { type RawDiscordOptions, rawDiscord, rawDiscordRequest } from "./DiscordRest.ts"
import { searchDiscordMessages } from "./DiscordSearchRest.ts"

type ChatDiscordAdapter = {
  readonly encodeThreadId: (input: DiscordThreadId) => string
  readonly postMessage: (threadId: string, message: AdapterPostableMessage) => Promise<RawMessage<unknown>>
  readonly editMessage: (threadId: string, messageId: string, message: AdapterPostableMessage) => Promise<RawMessage<unknown>>
  readonly deleteMessage: (threadId: string, messageId: string) => Promise<void>
  readonly startTyping: (threadId: string, status?: string) => Promise<void>
  readonly addReaction: (threadId: string, messageId: string, emoji: string) => Promise<void>
  readonly fetchMessages: (threadId: string, options?: FetchOptions) => Promise<FetchResult<unknown>>
}

type LiveDiscordOptions = {
  readonly botToken: string
  readonly applicationId?: string
  readonly publicKey?: string
}

type NicknameCacheEntry = {
  readonly nickname: string | undefined
  readonly expiresAt: number
}

const defaultNicknameCacheTtlMs = 7 * 24 * 60 * 60 * 1000
const nicknameLookupFailureCacheTtlMs = 5 * 60 * 1000
const nicknameResolveConcurrency = 5

const threadIdFromScope = (adapter: ChatDiscordAdapter, scope: DiscordScope): string =>
  adapter.encodeThreadId({
    guildId: scope.guildId,
    channelId: scope.channelId,
    ...(scope.threadId === undefined ? {} : { threadId: scope.threadId })
  })

const mentions = (content: string): ReadonlyArray<string> => [...content.matchAll(/<@(\d+)>/g)].map((match) => match[1] ?? "")

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const attachments = (message: Message<unknown>): ReadonlyArray<DiscordAttachment> =>
  message.attachments.map((item, index) => ({
    id: `${message.id}-${index}`,
    filename: item.name ?? `attachment-${index + 1}`,
    ...(item.mimeType === undefined ? {} : { contentType: item.mimeType }),
    size: item.size ?? 0,
    url: item.url ?? ""
  }))

const reactionEmoji = (value: unknown): string => {
  if (!isRecord(value)) return "unknown"
  const name = typeof value.name === "string" && value.name.length > 0 ? value.name : undefined
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined
  if (id !== undefined && name !== undefined) return `${value.animated === true ? "a:" : ""}${name}:${id}`
  return name ?? id ?? "unknown"
}

const reactions = (message: Message<unknown>): ReadonlyArray<DiscordReaction> => {
  if (!isRecord(message.raw)) return []
  const rawReactions: ReadonlyArray<unknown> = Array.isArray(message.raw.reactions) ? message.raw.reactions : []
  return rawReactions.flatMap((item) => {
    if (!isRecord(item) || typeof item.count !== "number" || !Number.isFinite(item.count) || item.count < 0) return []
    return [{ emoji: reactionEmoji(item.emoji), count: item.count }]
  })
}

const fromChatMessage = (scope: DiscordScope, message: Message<unknown>, nickname?: string | undefined): DiscordMessage => ({
  id: message.id,
  guildId: scope.guildId,
  channelId: scope.channelId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
  author: {
    id: message.author.userId,
    displayName: message.author.fullName,
    ...(nickname === undefined ? {} : { nickname }),
    isBot: message.author.isBot === true
  },
  content: message.text,
  timestamp: message.metadata.dateSent.toISOString(),
  mentions: mentions(message.text),
  roleMentions: [...message.text.matchAll(/<@&(\d+)>/g)].map((match) => match[1] ?? ""),
  everyoneMention: message.text.includes("@everyone"),
  hereMention: message.text.includes("@here"),
  attachments: attachments(message),
  reactions: reactions(message),
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

const memberNickname = (data: unknown): string | undefined => {
  if (!isRecord(data)) return undefined
  const nick = data.nick
  return typeof nick === "string" && nick.length > 0 ? nick : undefined
}

const normalizeMentionsForChatAdapter = (content: string): string => content.replace(/<@!?(\w+)>/g, "@$1")

export const makeChatSdkDiscord = (adapter: ChatDiscordAdapter, raw: RawDiscordOptions | undefined = undefined): DiscordService => {
  const nicknameCache = new Map<string, NicknameCacheEntry>()
  const nicknameInflight = new Map<string, Promise<string | undefined>>()
  const nicknameCacheTtlMs =
    raw?.nicknameCacheTtlMs !== undefined && Number.isFinite(raw.nicknameCacheTtlMs) && raw.nicknameCacheTtlMs > 0
      ? raw.nicknameCacheTtlMs
      : defaultNicknameCacheTtlMs

  const cacheNickname = (key: string, nickname: string | undefined, ttlMs = nicknameCacheTtlMs): void => {
    nicknameCache.set(key, { nickname, expiresAt: Date.now() + ttlMs })
  }

  const resolveNickname = async (scope: DiscordScope, userId: string): Promise<string | undefined> => {
    if (raw === undefined || scope.guildId === "@me") return undefined
    const key = `${scope.guildId}:${userId}`
    const cached = nicknameCache.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.nickname

    const inflight = nicknameInflight.get(key)
    if (inflight !== undefined) return inflight

    const request = rawDiscordRequest(raw, `/guilds/${scope.guildId}/members/${userId}`, { method: "GET" })
      .then(memberNickname)
      .then((nickname) => {
        cacheNickname(key, nickname)
        return nickname
      })
      .catch(() => {
        cacheNickname(key, undefined, nicknameLookupFailureCacheTtlMs)
        return undefined
      })
      .finally(() => nicknameInflight.delete(key))
    nicknameInflight.set(key, request)
    return request
  }

  const resolveNicknames = async (
    scope: DiscordScope,
    messages: ReadonlyArray<Message<unknown>>
  ): Promise<ReadonlyMap<string, string | undefined>> => {
    if (raw === undefined || scope.guildId === "@me") return new Map()
    const pending = [...new Set(messages.map((message) => message.author.userId))]
    const resolved = new Map<string, string | undefined>()
    const workers = Array.from({ length: Math.min(nicknameResolveConcurrency, pending.length) }, async () => {
      while (true) {
        const userId = pending.shift()
        if (userId === undefined) return
        resolved.set(userId, await resolveNickname(scope, userId))
      }
    })
    await Promise.all(workers)
    return resolved
  }

  const fetchMessages = (scope: DiscordScope, limit: number) =>
    tryAdapter(async () => {
      const threadId = threadIdFromScope(adapter, scope)
      const result = await adapter.fetchMessages(threadId, { limit })
      const nicknames = await resolveNicknames(scope, result.messages)
      return result.messages.map((message) => fromChatMessage(scope, message, nicknames.get(message.author.userId)))
    })

  return {
    fetchContext: fetchMessages,
    searchMessages: (scope, query, paging) => tryAdapter(() => searchDiscordMessages(raw, scope, query, paging, resolveNickname)),
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
      }).pipe(Effect.map((data) => ({ id: isRecord(data) && typeof data.id === "string" ? data.id : "" })))
  }
}

export const makeLiveChatSdkDiscord = (options: LiveDiscordOptions): DiscordService =>
  makeChatSdkDiscord(
    createDiscordAdapter({
      botToken: options.botToken,
      ...(options.applicationId === undefined ? {} : { applicationId: options.applicationId }),
      publicKey: options.publicKey ?? "0".repeat(64)
    }),
    { botToken: options.botToken }
  )
