import { Effect } from "effect"
import type { RuntimeConfig } from "../Config.ts"
import type { DiscordService } from "../Discord/DiscordPort.ts"
import type { OpencodeService } from "../Opencode/OpencodePort.ts"
import type { BotIdentity, DiscordScope, TriggerRequest } from "../Schema.ts"
import { assembleScheduledPrompt } from "./ContextAssembly.ts"
import { runOpencodePrompt } from "./PromptRunner.ts"

type TriggeredPromptOptions = {
  readonly bot: BotIdentity
  readonly config: RuntimeConfig
  readonly discord: DiscordService
  readonly opencode: OpencodeService
}

export const runTriggeredPrompt = Effect.fn("runTriggeredPrompt")(function* (
  request: TriggerRequest,
  scope: DiscordScope,
  options: TriggeredPromptOptions
) {
  const prompt = assembleScheduledPrompt({
    botUserId: options.bot.userId,
    scope,
    prompt: request.prompt,
    name: request.name,
    maxChars: options.config.context.maxChars
  })

  yield* runOpencodePrompt({
    prompt: prompt.text,
    parts: prompt.parts,
    scope,
    config: options.config,
    discord: options.discord,
    opencode: options.opencode,
    model: request.model,
    agent: request.agent
  })
})
