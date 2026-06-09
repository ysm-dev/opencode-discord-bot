import { Effect } from "effect"
import type { DiscordMessage, DiscordScope, DiscordSearchQuery, DiscordSearchResult } from "../Schema.ts"
import type { DiscordPostedMessage, DiscordService } from "./DiscordPort.ts"

type MemoryOptions = {
  readonly context?: ReadonlyArray<DiscordMessage>
}

const lowerIncludes = (value: string, expected: string): boolean => value.toLowerCase().includes(expected.toLowerCase())

const matchesContent = (message: DiscordMessage, query: DiscordSearchQuery): boolean =>
  query.content === undefined || lowerIncludes(message.content, query.content)

const matchesAuthor = (message: DiscordMessage, query: DiscordSearchQuery): boolean =>
  (query.authors.length === 0 || query.authors.includes(message.author.id)) &&
  (query.authorNames.length === 0 || query.authorNames.some((name) => lowerIncludes(message.author.displayName, name)))

const matchesChannel = (message: DiscordMessage, query: DiscordSearchQuery): boolean =>
  query.channels.length === 0 || query.channels.some((id) => id === message.channelId || id === message.threadId)

const matchesMentions = (message: DiscordMessage, query: DiscordSearchQuery): boolean =>
  (query.mentions.length === 0 || query.mentions.every((id) => message.mentions.includes(id))) &&
  (query.roleMentions.length === 0 || query.roleMentions.every((id) => message.roleMentions.includes(id))) &&
  (query.mentionEveryone === undefined || message.everyoneMention === query.mentionEveryone)

const matchesHas = (message: DiscordMessage, query: DiscordSearchQuery): boolean =>
  (!query.has.includes("file") || message.attachments.length > 0) && (!query.has.includes("link") || /https?:\/\//i.test(message.content))

const matchesSearch = (message: DiscordMessage, scope: DiscordScope, query: DiscordSearchQuery): boolean => {
  if (message.guildId !== scope.guildId) return false
  return [matchesContent, matchesAuthor, matchesChannel, matchesMentions, matchesHas].every((matches) => matches(message, query))
}

const memorySearch = (
  context: ReadonlyArray<DiscordMessage>,
  scope: DiscordScope,
  query: DiscordSearchQuery,
  limit: number,
  offset: number
): DiscordSearchResult => {
  const matching = context.filter((message) => matchesSearch(message, scope, query))
  const messages = matching.slice(offset, offset + limit)
  return { totalResults: matching.length, offset, hasMore: offset + messages.length < matching.length, messages }
}

export type MemoryDiscord = DiscordService & {
  readonly context: Array<DiscordMessage>
  readonly typingScopes: Array<DiscordScope>
  readonly messages: Array<DiscordPostedMessage>
  readonly edits: Array<{ readonly scope: DiscordScope; readonly messageId: string; readonly content: string }>
  readonly reactions: Array<{
    readonly scope: DiscordScope
    readonly messageId: string
    readonly emoji: string
    readonly op: "add"
  }>
  readonly attachments: Array<{ readonly scope: DiscordScope; readonly path: string }>
  readonly threads: Array<{ readonly scope: DiscordScope; readonly name: string }>
  readonly deletes: Array<{ readonly scope: DiscordScope; readonly messageId: string }>
}

export const makeMemoryDiscord = (options: MemoryOptions = {}): MemoryDiscord => {
  let nextId = 0
  const context = [...(options.context ?? [])]
  const typingScopes: Array<DiscordScope> = []
  const messages: Array<DiscordPostedMessage> = []
  const edits: MemoryDiscord["edits"] = []
  const reactions: MemoryDiscord["reactions"] = []
  const attachments: MemoryDiscord["attachments"] = []
  const threads: MemoryDiscord["threads"] = []
  const deletes: MemoryDiscord["deletes"] = []

  return {
    context,
    typingScopes,
    messages,
    edits,
    reactions,
    attachments,
    threads,
    deletes,
    fetchContext: (_scope, limit) => Effect.succeed(context.slice(Math.max(0, context.length - limit))),
    sendTyping: (scope) => Effect.sync(() => typingScopes.push(scope)).pipe(Effect.asVoid),
    postMessage: (scope, content) =>
      Effect.sync(() => {
        nextId += 1
        messages.push({ scope, content })
        return { id: `posted-${nextId}` }
      }),
    editMessage: (scope, messageId, content) => Effect.sync(() => edits.push({ scope, messageId, content })).pipe(Effect.asVoid),
    addReaction: (scope, messageId, emoji) => Effect.sync(() => reactions.push({ scope, messageId, emoji, op: "add" })).pipe(Effect.asVoid),
    searchMessages: (scope, query, paging) => Effect.succeed(memorySearch(context, scope, query, paging.limit, paging.offset)),
    attachFile: (scope, path) =>
      Effect.sync(() => {
        attachments.push({ scope, path })
        return { path }
      }),
    createThread: (scope, name) =>
      Effect.sync(() => {
        nextId += 1
        threads.push({ scope, name })
        return { id: `thread-${nextId}` }
      }),
    deleteMessage: (scope, messageId) => Effect.sync(() => deletes.push({ scope, messageId })).pipe(Effect.asVoid)
  }
}
