import { Context, Data, type Effect, type Stream } from "effect"
import type { DiscordScope, OpencodeEvent } from "../Schema.ts"

export class OpencodeError extends Data.TaggedError("OpencodeError")<{
  readonly message: string
}> {}

export type OpencodePrompt = {
  readonly prompt: string
  readonly parts?: ReadonlyArray<OpencodePromptFilePart>
  readonly projectDir: string
  readonly scope: DiscordScope
  readonly model?: string
  readonly agent?: string
}

export type OpencodePromptFilePart = {
  readonly type: "file"
  readonly mime: string
  readonly filename?: string
  readonly url: string
}

export type OpencodeService = {
  readonly runPrompt: (input: OpencodePrompt) => Stream.Stream<OpencodeEvent, OpencodeError>
  readonly abort: (scope: DiscordScope) => Stream.Stream<never, OpencodeError>
  readonly checkHealth: Effect.Effect<void, OpencodeError>
}

export const Opencode = Context.Service<OpencodeService>("opencode-discord-bot/Opencode")
