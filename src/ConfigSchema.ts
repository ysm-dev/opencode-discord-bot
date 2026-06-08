import { Schema } from "effect"

const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const OptionalBoolean = Schema.optional(Schema.Boolean)
const RawToolsSchema = Schema.Struct({
  enabled: OptionalBoolean,
  autoInstall: OptionalBoolean,
  reactions: OptionalBoolean,
  attachFiles: OptionalBoolean,
  fetchHistory: OptionalBoolean,
  createThread: OptionalBoolean
})

export const RawConfigSchema = Schema.Struct({
  contextMessages: Schema.optional(PositiveInt),
  contextMaxChars: Schema.optional(PositiveInt),
  attachmentMaxBytes: Schema.optional(PositiveInt),
  threads: Schema.optional(Schema.Struct({ activeByRecentBotParticipation: OptionalBoolean })),
  tools: Schema.optional(RawToolsSchema),
  streaming: Schema.optional(
    Schema.Struct({
      updateIntervalMs: Schema.optional(PositiveInt),
      placeholderText: Schema.optional(Schema.NullOr(Schema.String)),
      showToolStatus: OptionalBoolean,
      changedFilesSummary: OptionalBoolean
    })
  ),
  concurrency: Schema.optional(
    Schema.Struct({
      strategy: Schema.optional(Schema.Union([Schema.Literal("queue"), Schema.Literal("burst")])),
      globalMaxActiveTurns: Schema.optional(Schema.NullOr(PositiveInt))
    })
  ),
  guards: Schema.optional(
    Schema.Struct({
      ignoreBots: OptionalBoolean,
      stripMassMentions: OptionalBoolean,
      redactSecretsInErrors: OptionalBoolean,
      maxTurnMs: Schema.optional(Schema.NullOr(PositiveInt))
    })
  )
})
