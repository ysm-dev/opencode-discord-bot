import {
  type Adapter,
  type Attachment,
  Chat,
  type FetchOptions,
  type FetchResult,
  type Lock,
  Message,
  type MessageContext,
  parseMarkdown,
  type QueueEntry,
  type StateAdapter,
  stringifyMarkdown
} from "chat"
import { Effect } from "effect"
import type { BotIdentity, DiscordAttachment, DiscordMessage, DiscordScope } from "../Schema.ts"

export type ChatGatewayIntake = {
  readonly processMessage: (message: DiscordMessage) => Effect.Effect<void, unknown>
}

type ChatGatewayIntakeOptions = {
  readonly bot: BotIdentity
  readonly onMessage: (message: DiscordMessage, skippedMessages: ReadonlyArray<DiscordMessage>) => Effect.Effect<void, unknown>
}

type StoredValue = {
  readonly value: unknown
  readonly expiresAt?: number | undefined
}

const threadIdFromMessage = (message: DiscordMessage): string =>
  message.threadId === undefined
    ? `discord:${message.guildId}:${message.channelId}`
    : `discord:${message.guildId}:${message.channelId}:${message.threadId}`

const scopeFromThreadId = (threadId: string): DiscordScope => {
  const [, guildId = "", channelId = "", threadIdPart = channelId] = threadId.split(":")
  return threadIdPart === channelId ? { guildId, channelId } : { guildId, channelId, threadId: threadIdPart }
}

const chatAttachment = (attachment: DiscordAttachment): Attachment => ({
  type: attachment.contentType?.startsWith("image/") ? "image" : "file",
  name: attachment.filename,
  size: attachment.size,
  url: attachment.url,
  ...(attachment.contentType === undefined ? {} : { mimeType: attachment.contentType })
})

const isDiscordMessage = (value: unknown): value is DiscordMessage =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "guildId" in value &&
  typeof value.guildId === "string" &&
  "channelId" in value &&
  typeof value.channelId === "string"

const toChatMessage = (message: DiscordMessage, bot: BotIdentity): Message<DiscordMessage> =>
  new Message({
    id: message.id,
    threadId: threadIdFromMessage(message),
    text: message.content,
    formatted: parseMarkdown(message.content),
    raw: message,
    author: {
      userId: message.author.id,
      userName: message.author.nickname ?? message.author.displayName,
      fullName: message.author.displayName,
      isBot: message.author.isBot,
      isMe: message.author.id === bot.userId
    },
    metadata: { dateSent: new Date(message.timestamp), edited: false },
    attachments: message.attachments.map(chatAttachment),
    isMention: message.mentions.includes(bot.userId)
  })

const fromChatMessage = (message: Message<unknown>): DiscordMessage | undefined => (isDiscordMessage(message.raw) ? message.raw : undefined)

export const collectDiscordMessages = (messages: Iterable<Message<unknown>>): ReadonlyArray<DiscordMessage> => {
  const collected: Array<DiscordMessage> = []
  for (const message of messages) {
    const discordMessage = fromChatMessage(message)
    if (discordMessage !== undefined) collected.push(discordMessage)
  }
  return collected
}

const liveValue = (stored: StoredValue | undefined): unknown | undefined => {
  if (stored === undefined) return undefined
  if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now()) return undefined
  return stored.value
}

export const makeTransientChatState = (): StateAdapter => {
  const values = new Map<string, StoredValue>()
  const lists = new Map<string, Array<unknown>>()
  const queues = new Map<string, Array<QueueEntry>>()
  const locks = new Map<string, Lock>()
  const subscribed = new Set<string>()

  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    set: (key, value, ttlMs) => {
      values.set(key, { value, ...(ttlMs === undefined ? {} : { expiresAt: Date.now() + ttlMs }) })
      return Promise.resolve()
    },
    setIfNotExists: (key, value, ttlMs) => {
      if (liveValue(values.get(key)) !== undefined) return Promise.resolve(false)
      values.set(key, { value, ...(ttlMs === undefined ? {} : { expiresAt: Date.now() + ttlMs }) })
      return Promise.resolve(true)
    },
    delete: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
    appendToList: (key, value, options) => {
      const next = [...(lists.get(key) ?? []), value].slice(-(options?.maxLength ?? Number.POSITIVE_INFINITY))
      lists.set(key, next)
      return Promise.resolve()
    },
    getList: () => Promise.resolve([]),
    acquireLock: (threadId, ttlMs) => {
      const existing = locks.get(threadId)
      if (existing !== undefined && existing.expiresAt > Date.now()) return Promise.resolve(null)
      const lock = { threadId, token: crypto.randomUUID(), expiresAt: Date.now() + ttlMs }
      locks.set(threadId, lock)
      return Promise.resolve(lock)
    },
    extendLock: (lock, ttlMs) => {
      if (locks.get(lock.threadId)?.token !== lock.token) return Promise.resolve(false)
      locks.set(lock.threadId, { ...lock, expiresAt: Date.now() + ttlMs })
      return Promise.resolve(true)
    },
    releaseLock: (lock) => {
      if (locks.get(lock.threadId)?.token === lock.token) locks.delete(lock.threadId)
      return Promise.resolve()
    },
    forceReleaseLock: (threadId) => {
      locks.delete(threadId)
      return Promise.resolve()
    },
    enqueue: (threadId, entry, maxSize) => {
      const next = [...(queues.get(threadId) ?? []), entry].slice(-maxSize)
      queues.set(threadId, next)
      return Promise.resolve(next.length)
    },
    dequeue: (threadId) => {
      const queue = queues.get(threadId) ?? []
      const now = Date.now()
      while (queue.length > 0) {
        const entry = queue.shift()
        if (entry !== undefined && entry.expiresAt > now) return Promise.resolve(entry)
      }
      queues.delete(threadId)
      return Promise.resolve(null)
    },
    queueDepth: (threadId) => Promise.resolve(queues.get(threadId)?.length ?? 0),
    subscribe: (threadId) => {
      subscribed.add(threadId)
      return Promise.resolve()
    },
    unsubscribe: (threadId) => {
      subscribed.delete(threadId)
      return Promise.resolve()
    },
    isSubscribed: (threadId) => Promise.resolve(subscribed.has(threadId))
  }
}

const unsupported = (operation: string): Promise<never> => Promise.reject(new Error(`chat-sdk gateway intake cannot ${operation}`))

export const makeGatewayAdapter = (bot: BotIdentity): Adapter<DiscordScope, DiscordMessage> => ({
  name: "discord",
  userName: bot.userId,
  botUserId: bot.userId,
  lockScope: "thread",
  initialize: () => Promise.resolve(),
  handleWebhook: () => Promise.resolve(new Response(null, { status: 404 })),
  encodeThreadId: (scope) =>
    scope.threadId === undefined
      ? `discord:${scope.guildId}:${scope.channelId}`
      : `discord:${scope.guildId}:${scope.channelId}:${scope.threadId}`,
  decodeThreadId: scopeFromThreadId,
  channelIdFromThreadId: (threadId) => scopeFromThreadId(threadId).channelId,
  parseMessage: (raw) => toChatMessage(raw, bot),
  renderFormatted: (content) => stringifyMarkdown(content),
  fetchMessages: (_threadId, _options?: FetchOptions): Promise<FetchResult<DiscordMessage>> => Promise.resolve({ messages: [] }),
  fetchThread: (threadId) => {
    const scope = scopeFromThreadId(threadId)
    return Promise.resolve({ id: threadId, channelId: scope.channelId, isDM: false, metadata: {} })
  },
  isDM: () => false,
  postMessage: () => unsupported("post messages"),
  postChannelMessage: () => unsupported("post channel messages"),
  editMessage: () => unsupported("edit messages"),
  deleteMessage: () => unsupported("delete messages"),
  addReaction: () => unsupported("add reactions"),
  removeReaction: () => unsupported("remove reactions"),
  startTyping: () => unsupported("start typing")
})

export const makeChatGatewayIntake = (options: ChatGatewayIntakeOptions): ChatGatewayIntake => {
  const adapter = makeGatewayAdapter(options.bot)
  const chat = new Chat({
    adapters: { discord: adapter },
    state: makeTransientChatState(),
    userName: options.bot.userId,
    concurrency: "concurrent",
    dedupeTtlMs: 5 * 60 * 1000
  })

  const handle = (message: Message<unknown>, context?: MessageContext) => {
    const current = fromChatMessage(message)
    if (current === undefined) return Promise.resolve()
    const skipped = collectDiscordMessages(context?.skipped ?? [])
    return Effect.runPromise(options.onMessage(current, skipped))
  }

  const dispatch = (_thread: unknown, message: Message<unknown>, context?: MessageContext) => handle(message, context)
  chat.onNewMention(dispatch)
  chat.onSubscribedMessage(dispatch)
  chat.onNewMessage(/[\s\S]*/, dispatch)

  return {
    processMessage: (message) =>
      Effect.tryPromise({
        try: () => chat.processMessage(adapter, threadIdFromMessage(message), toChatMessage(message, options.bot)),
        catch: (cause) => cause
      })
  }
}
