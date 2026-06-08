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
    deleteMessage: (scope, messageId) => Effect.sync(() => deletes.push({ scope, messageId })).pipe(Effect.asVoid)
  }
}
