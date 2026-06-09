import { Effect } from "effect"
import type { RuntimeConfig } from "../Config.ts"
import type { DiscordService } from "../Discord/DiscordPort.ts"
import type { OpencodeService } from "../Opencode/OpencodePort.ts"
import type { BotIdentity, DiscordMessage } from "../Schema.ts"
import { assembleContextPrompt } from "./ContextAssembly.ts"
import { runOpencodePrompt } from "./PromptRunner.ts"
import { isThreadActiveFromContext, shouldTriggerTurn, toDiscordScope } from "./Triggering.ts"

type HandleOptions = {
  readonly bot: BotIdentity
  readonly config: RuntimeConfig
  readonly discord: DiscordService
  readonly opencode: OpencodeService
}

type HandleResult = {
  readonly handled: boolean
}

export const handleDiscordMessage = Effect.fn("handleDiscordMessage")(function* (
  message: DiscordMessage,
  options: HandleOptions,
  skippedMessages: ReadonlyArray<DiscordMessage> = []
) {
  const scope = toDiscordScope(message)
  const directTrigger = shouldTriggerTurn(message, options.bot, false)
  let context: ReadonlyArray<DiscordMessage> | undefined
  let activeThread = false

  if (!directTrigger && message.threadId !== undefined && options.config.threads.activeByRecentBotParticipation) {
    context = yield* options.discord.fetchContext(scope, options.config.context.messages)
    activeThread = isThreadActiveFromContext(context, options.bot)
  }

  if (!shouldTriggerTurn(message, options.bot, activeThread)) return { handled: false } satisfies HandleResult

  const contextMessages = context ?? (yield* options.discord.fetchContext(scope, options.config.context.messages))
  const prompt = assembleContextPrompt({
    botUserId: options.bot.userId,
    contextMessages,
    triggerMessage: message,
    skippedMessages,
    maxMessages: options.config.context.messages,
    maxChars: options.config.context.maxChars,
    maxAttachmentBytes: options.config.context.attachmentMaxBytes
  })

  yield* runOpencodePrompt({
    prompt: prompt.text,
    parts: prompt.parts,
    scope,
    config: options.config,
    discord: options.discord,
    opencode: options.opencode
  })

  return { handled: true } satisfies HandleResult
})
