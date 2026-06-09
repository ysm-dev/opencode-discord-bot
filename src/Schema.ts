import { Schema } from "effect"

export type Snowflake = string

export type DiscordScope = {
  readonly guildId: Snowflake
  readonly channelId: Snowflake
  readonly threadId?: Snowflake
}

export type BotIdentity = {
  readonly userId: Snowflake
}

export type DiscordAuthor = {
  readonly id: Snowflake
  readonly displayName: string
  readonly nickname?: string
  readonly isBot: boolean
}

export type DiscordAttachment = {
  readonly id: string
  readonly filename: string
  readonly contentType?: string
  readonly size: number
  readonly url: string
}

export type DiscordReaction = {
  readonly emoji: string
  readonly count: number
}

export type DiscordMessage = {
  readonly id: Snowflake
  readonly guildId: Snowflake
  readonly channelId: Snowflake
  readonly threadId?: Snowflake
  readonly author: DiscordAuthor
  readonly content: string
  readonly timestamp: string
  readonly mentions: ReadonlyArray<Snowflake>
  readonly roleMentions: ReadonlyArray<Snowflake>
  readonly everyoneMention: boolean
  readonly hereMention: boolean
  readonly attachments: ReadonlyArray<DiscordAttachment>
  readonly reactions: ReadonlyArray<DiscordReaction>
  readonly channelType: "guild" | "dm"
  readonly isSystem?: boolean
}

export type DiscordSearchQuery = {
  readonly content?: string
  readonly authors: ReadonlyArray<string>
  readonly authorNames: ReadonlyArray<string>
  readonly authorTypes: ReadonlyArray<string>
  readonly channels: ReadonlyArray<string>
  readonly channelNames: ReadonlyArray<string>
  readonly mentions: ReadonlyArray<string>
  readonly mentionNames: ReadonlyArray<string>
  readonly roleMentions: ReadonlyArray<string>
  readonly repliedToUsers: ReadonlyArray<string>
  readonly repliedToUserNames: ReadonlyArray<string>
  readonly repliedToMessages: ReadonlyArray<string>
  readonly has: ReadonlyArray<string>
  readonly embedTypes: ReadonlyArray<string>
  readonly embedProviders: ReadonlyArray<string>
  readonly linkHostnames: ReadonlyArray<string>
  readonly attachmentFilenames: ReadonlyArray<string>
  readonly attachmentExtensions: ReadonlyArray<string>
  readonly maxId?: string
  readonly minId?: string
  readonly slop?: number
  readonly pinned?: boolean
  readonly mentionEveryone?: boolean
  readonly sortBy?: "timestamp" | "relevance"
  readonly sortOrder?: "asc" | "desc"
  readonly includeNsfw?: boolean
}

export type DiscordSearchResult = {
  readonly totalResults: number
  readonly offset: number
  readonly hasMore: boolean
  readonly messages: ReadonlyArray<DiscordMessage>
}

export type ToolTarget = {
  readonly guildId?: string | undefined
  readonly channelId?: string | undefined
  readonly threadId?: string | undefined
  readonly messageId?: string | undefined
}

export type ToolRequest = {
  readonly action: string
  readonly target: ToolTarget
  readonly args: Readonly<Record<string, unknown>>
}

export type ToolResponse = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string }

export type OpencodeEvent =
  | { readonly type: "text-delta"; readonly id?: string; readonly text: string }
  | { readonly type: "text-snapshot"; readonly id?: string; readonly text: string }
  | { readonly type: "reasoning-start" }
  | { readonly type: "tool-start"; readonly title: string }
  | { readonly type: "tool-end" }
  | { readonly type: "changed-files"; readonly files: number; readonly insertions: number; readonly deletions: number }
  | { readonly type: "idle" }
  | { readonly type: "error"; readonly message: string }

export const ToolTargetSchema = Schema.Struct({
  guildId: Schema.optional(Schema.String),
  channelId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String)
})

export const ToolRequestSchema = Schema.Struct({
  action: Schema.String,
  target: ToolTargetSchema,
  args: Schema.Record(Schema.String, Schema.Unknown)
})

export const ToolResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String })
])
