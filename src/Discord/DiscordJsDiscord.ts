import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { Effect } from "effect"
import type { DiscordAttachment, DiscordMessage, DiscordReaction, DiscordScope } from "../Schema.ts"
import { DiscordError, type DiscordService } from "./DiscordPort.ts"

type CollectionLike<A> = {
  readonly values: () => IterableIterator<A>
}

type AttachmentLike = {
  readonly id: string
  readonly name: string
  readonly contentType: string | null
  readonly size: number
  readonly url: string
}

type ReactionLike = {
  readonly emoji: { readonly name: string | null; readonly identifier?: string }
  readonly count: number
}

type AuthorLike = {
  readonly id: string
  readonly displayName?: string
  readonly globalName?: string | null
  readonly username: string
  readonly bot: boolean
}

export type DiscordJsMessageLike = {
  readonly id: string
  readonly guildId: string | null
  readonly channelId: string
  readonly channel: DiscordJsChannelLike
  readonly author: AuthorLike
  readonly member?: { readonly nickname: string | null } | null
  readonly content: string
  readonly createdAt: Date
  readonly mentions: {
    readonly users: CollectionLike<{ readonly id: string }>
    readonly roles: CollectionLike<{ readonly id: string }>
    readonly everyone: boolean
  }
  readonly attachments: CollectionLike<AttachmentLike>
  readonly reactions: { readonly cache: CollectionLike<ReactionLike> }
  readonly system: boolean
  readonly inGuild?: () => boolean
}

type DiscordPostedLike = {
  readonly id: string
}

type DiscordFetchedMessageLike = DiscordJsMessageLike & {
  readonly edit: (content: string) => Promise<unknown>
  readonly react: (emoji: string) => Promise<unknown>
  readonly delete?: () => Promise<unknown>
}

export type DiscordJsChannelLike = {
  readonly id: string
  readonly parentId?: string | null
  readonly isDMBased?: () => boolean
  readonly isThread?: () => boolean
  readonly send?: (
    content: string | { readonly files: ReadonlyArray<{ readonly attachment: Uint8Array; readonly name: string }> }
  ) => Promise<DiscordPostedLike>
  readonly sendTyping?: () => Promise<void>
  readonly threads?: {
    readonly create: (input: { readonly name: string }) => Promise<{ readonly id: string }>
  }
  readonly messages?: {
    readonly fetch: (
      query: string | { readonly limit: number }
    ) => Promise<DiscordFetchedMessageLike | CollectionLike<DiscordJsMessageLike>>
  }
}

export type DiscordJsClientLike = {
  readonly user: { readonly id: string } | null
  readonly channels: {
    readonly fetch: (id: string) => Promise<unknown>
  }
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

const hasMethod = (value: object, key: string): boolean => typeof Reflect.get(value, key) === "function"

const isTextChannel = (value: unknown): value is Required<Pick<DiscordJsChannelLike, "send" | "messages">> & DiscordJsChannelLike =>
  isObject(value) &&
  hasMethod(value, "send") &&
  isObject(Reflect.get(value, "messages")) &&
  hasMethod(Reflect.get(value, "messages"), "fetch")

const isCollectionLike = <A>(value: unknown): value is CollectionLike<A> => isObject(value) && hasMethod(value, "values")

const isFetchedMessage = (value: unknown): value is DiscordFetchedMessageLike =>
  isObject(value) && hasMethod(value, "edit") && hasMethod(value, "react")

const fromCollection = <A>(collection: CollectionLike<A>): ReadonlyArray<A> => [...collection.values()]

const channelTargetId = (scope: DiscordScope): string => scope.threadId ?? scope.channelId

const channelScope = (message: DiscordJsMessageLike): DiscordScope | undefined => {
  if (message.guildId === null) return undefined
  const channel = message.channel
  if (channel.isDMBased?.() === true) return undefined
  if (channel.isThread?.() === true) {
    return { guildId: message.guildId, channelId: channel.parentId ?? message.channelId, threadId: message.channelId }
  }
  return { guildId: message.guildId, channelId: message.channelId }
}

const attachment = (item: AttachmentLike): DiscordAttachment => ({
  id: item.id,
  filename: item.name,
  ...(item.contentType === null ? {} : { contentType: item.contentType }),
  size: item.size,
  url: item.url
})

const reaction = (item: ReactionLike): DiscordReaction => ({
  emoji: item.emoji.identifier ?? item.emoji.name ?? "unknown",
  count: item.count
})

export const fromDiscordJsMessage = (message: DiscordJsMessageLike): DiscordMessage | undefined => {
  if (message.inGuild?.() === false) return undefined
  const scope = channelScope(message)
  if (scope === undefined) return undefined

  return {
    id: message.id,
    ...scope,
    author: {
      id: message.author.id,
      displayName: message.author.displayName ?? message.author.globalName ?? message.author.username,
      ...(message.member?.nickname === undefined || message.member.nickname === null ? {} : { nickname: message.member.nickname }),
      isBot: message.author.bot
    },
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    mentions: fromCollection(message.mentions.users).map((user) => user.id),
    roleMentions: fromCollection(message.mentions.roles).map((role) => role.id),
    everyoneMention: message.mentions.everyone,
    hereMention: message.content.includes("@here"),
    attachments: fromCollection(message.attachments).map(attachment),
    reactions: fromCollection(message.reactions.cache).map(reaction),
    channelType: "guild",
    isSystem: message.system
  }
}

const tryDiscord = <A>(operation: () => Promise<A>): Effect.Effect<A, DiscordError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new DiscordError({ message: cause instanceof Error ? cause.message : "Discord operation failed" })
  })

const fetchTextChannel = (
  client: DiscordJsClientLike,
  scope: DiscordScope
): Effect.Effect<Required<Pick<DiscordJsChannelLike, "send" | "messages">> & DiscordJsChannelLike, DiscordError> =>
  tryDiscord(async () => {
    const channel = await client.channels.fetch(channelTargetId(scope))
    if (!isTextChannel(channel)) throw new Error("Discord channel is not text-capable")
    if (channel.isDMBased?.() === true) throw new Error("Discord DMs are not supported")
    return channel
  })

const fetchMessage = (
  client: DiscordJsClientLike,
  scope: DiscordScope,
  messageId: string
): Effect.Effect<DiscordFetchedMessageLike, DiscordError> =>
  Effect.gen(function* () {
    const channel = yield* fetchTextChannel(client, scope)
    const message = yield* tryDiscord(() => channel.messages.fetch(messageId))
    if (!isFetchedMessage(message)) return yield* Effect.fail(new DiscordError({ message: "Discord message is not editable/reactable" }))
    return message
  })

export const makeDiscordJsDiscord = (client: DiscordJsClientLike): DiscordService => ({
  fetchContext: (scope, limit) =>
    Effect.gen(function* () {
      const channel = yield* fetchTextChannel(client, scope)
      const result = yield* tryDiscord(() => channel.messages.fetch({ limit }))
      if (!isCollectionLike<DiscordJsMessageLike>(result)) return []
      return fromCollection(result).flatMap((message) => {
        const mapped = fromDiscordJsMessage(message)
        return mapped === undefined ? [] : [mapped]
      })
    }),
  searchMessages: () => Effect.fail(new DiscordError({ message: "Discord search is only available through the live REST adapter" })),
  sendTyping: (scope) =>
    Effect.gen(function* () {
      const channel = yield* fetchTextChannel(client, scope)
      if (channel.sendTyping !== undefined) yield* tryDiscord(() => channel.sendTyping?.() ?? Promise.resolve())
    }),
  postMessage: (scope, content) =>
    Effect.gen(function* () {
      const channel = yield* fetchTextChannel(client, scope)
      const result = yield* tryDiscord(() => channel.send(content))
      return { id: result.id }
    }),
  editMessage: (scope, messageId, content) =>
    Effect.gen(function* () {
      const message = yield* fetchMessage(client, scope, messageId)
      yield* tryDiscord(() => message.edit(content))
    }),
  deleteMessage: (scope, messageId) =>
    Effect.gen(function* () {
      const message = yield* fetchMessage(client, scope, messageId)
      if (message.delete === undefined) return yield* Effect.fail(new DiscordError({ message: "Discord message is not deletable" }))
      yield* tryDiscord(() => message.delete?.() ?? Promise.resolve())
    }),
  addReaction: (scope, messageId, emoji) =>
    Effect.gen(function* () {
      const message = yield* fetchMessage(client, scope, messageId)
      yield* tryDiscord(() => message.react(emoji))
    }),
  attachFile: (scope, path) =>
    Effect.gen(function* () {
      const channel = yield* fetchTextChannel(client, scope)
      const data = yield* tryDiscord(() => readFile(path))
      const result = yield* tryDiscord(() => channel.send({ files: [{ attachment: data, name: basename(path) }] }))
      return { path: result.id }
    }),
  createThread: (scope, name) =>
    Effect.gen(function* () {
      const channel = yield* fetchTextChannel(client, scope)
      if (channel.threads === undefined) return yield* Effect.fail(new DiscordError({ message: "Discord channel cannot create threads" }))
      return yield* tryDiscord(() => channel.threads?.create({ name }) ?? Promise.resolve({ id: "" }))
    })
})
