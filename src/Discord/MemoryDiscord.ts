import { Effect } from "effect"
import type { DiscordMessage, DiscordScope } from "../Schema.ts"
import type { DiscordPostedMessage, DiscordService } from "./DiscordPort.ts"

type MemoryOptions = {
  readonly context?: ReadonlyArray<DiscordMessage>
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
    readonly op: "add" | "remove"
  }>
  readonly attachments: Array<{ readonly scope: DiscordScope; readonly path: string }>
  readonly threads: Array<{ readonly scope: DiscordScope; readonly name: string }>
  readonly deletes: Array<{ readonly scope: DiscordScope; readonly messageId: string }>
  readonly channelMessages: Array<{ readonly guildId: string; readonly channelId: string; readonly content: string }>
  readonly pins: Array<{ readonly scope: DiscordScope; readonly messageId: string; readonly op: "pin" | "unpin" }>
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
  const channelMessages: MemoryDiscord["channelMessages"] = []
  const pins: MemoryDiscord["pins"] = []

  return {
    context,
    typingScopes,
    messages,
    edits,
    reactions,
    attachments,
    threads,
    deletes,
    channelMessages,
    pins,
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
    removeReaction: (scope, messageId, emoji) =>
      Effect.sync(() => reactions.push({ scope, messageId, emoji, op: "remove" })).pipe(Effect.asVoid),
    fetchHistory: (_scope, limit) => Effect.succeed(context.slice(Math.max(0, context.length - limit))),
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
    deleteMessage: (scope, messageId) => Effect.sync(() => deletes.push({ scope, messageId })).pipe(Effect.asVoid),
    postChannelMessage: (guildId, channelId, content) =>
      Effect.sync(() => {
        nextId += 1
        channelMessages.push({ guildId, channelId, content })
        return { id: `posted-${nextId}` }
      }),
    pinMessage: (scope, messageId) => Effect.sync(() => pins.push({ scope, messageId, op: "pin" })).pipe(Effect.asVoid),
    unpinMessage: (scope, messageId) => Effect.sync(() => pins.push({ scope, messageId, op: "unpin" })).pipe(Effect.asVoid)
  }
}
