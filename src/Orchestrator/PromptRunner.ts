import { Effect } from "effect"
import type { RuntimeConfig } from "../Config.ts"
import type { DiscordService } from "../Discord/DiscordPort.ts"
import type { OpencodePromptFilePart, OpencodeService } from "../Opencode/OpencodePort.ts"
import { renderOpencodeEvents } from "../Render/Renderer.ts"
import type { DiscordScope } from "../Schema.ts"

type RunPromptOptions = {
  readonly prompt: string
  readonly parts?: ReadonlyArray<OpencodePromptFilePart> | undefined
  readonly scope: DiscordScope
  readonly config: RuntimeConfig
  readonly discord: DiscordService
  readonly opencode: OpencodeService
  readonly model?: string | undefined
  readonly agent?: string | undefined
}

const redactError = (message: string): string => message.replace(/secret[-_a-z0-9]*/gi, "[redacted]")

export const runOpencodePrompt = Effect.fn("runOpencodePrompt")(function* (options: RunPromptOptions) {
  const model = options.model ?? options.config.opencode.model
  const agent = options.agent ?? options.config.opencode.agent
  const parts = options.parts
  const events = options.opencode.runPrompt({
    prompt: options.prompt,
    projectDir: options.config.opencode.projectDir,
    scope: options.scope,
    ...(parts === undefined ? {} : { parts }),
    ...(model === undefined ? {} : { model }),
    ...(agent === undefined ? {} : { agent })
  })

  yield* renderOpencodeEvents(events, options.scope, options.config, options.discord).pipe(
    Effect.catchTag("OpencodeError", (error) =>
      options.discord.postMessage(options.scope, `opencode is unavailable or returned an error: ${redactError(error.message)}`)
    )
  )
})
