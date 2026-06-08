import { Context, Data, type Duration, type Effect } from "effect"
import type { DiscordMessage, DiscordScope } from "../Schema.ts"

export class DiscordError extends Data.TaggedError("DiscordError")<{
  readonly message: string
  readonly retryAfter?: Duration.Duration | undefined
}> {}

export type DiscordPostedMessage = {
  readonly scope: DiscordScope
  readonly content: string
}

export type DiscordService = {
  readonly fetchContext: (scope: DiscordScope, limit: number) => Effect.Effect<ReadonlyArray<DiscordMessage>, DiscordError>
  readonly sendTyping: (scope: DiscordScope) => Effect.Effect<void, DiscordError>
  readonly postMessage: (scope: DiscordScope, content: string) => Effect.Effect<{ readonly id: string }, DiscordError>
  readonly editMessage: (scope: DiscordScope, messageId: string, content: string) => Effect.Effect<void, DiscordError>
  readonly addReaction: (scope: DiscordScope, messageId: string, emoji: string) => Effect.Effect<void, DiscordError>
  readonly removeReaction: (scope: DiscordScope, messageId: string, emoji: string) => Effect.Effect<void, DiscordError>
  readonly fetchHistory: (scope: DiscordScope, limit: number) => Effect.Effect<ReadonlyArray<DiscordMessage>, DiscordError>
  readonly attachFile: (scope: DiscordScope, path: string) => Effect.Effect<{ readonly path: string }, DiscordError>
  readonly createThread: (scope: DiscordScope, name: string) => Effect.Effect<{ readonly id: string }, DiscordError>
  readonly deleteMessage: (scope: DiscordScope, messageId: string) => Effect.Effect<void, DiscordError>
  readonly postChannelMessage: (guildId: string, channelId: string, content: string) => Effect.Effect<{ readonly id: string }, DiscordError>
  readonly pinMessage: (scope: DiscordScope, messageId: string) => Effect.Effect<void, DiscordError>
  readonly unpinMessage: (scope: DiscordScope, messageId: string) => Effect.Effect<void, DiscordError>
}

export const Discord = Context.Service<DiscordService>("opencode-discord-bot/Discord")
