#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Redacted, type Scope } from "effect"
import { startLoopbackServer } from "./Bridge/LoopbackServer.ts"
import { handleToolRequest } from "./Bridge/ToolControl.ts"
import { defaultConfig, loadConfig, type RuntimeConfig } from "./Config.ts"
import { makeLiveChatSdkDiscord } from "./Discord/ChatSdkDiscord.ts"
import { type ChatGatewayIntake, makeChatGatewayIntake } from "./Discord/ChatSdkGatewayIntake.ts"
import { type DiscordGateway, type DiscordGatewayOptions, startDiscordGateway } from "./Discord/DiscordGateway.ts"
import type { DiscordService } from "./Discord/DiscordPort.ts"
import type { OpencodeService } from "./Opencode/OpencodePort.ts"
import { makeLiveSdkOpencode } from "./Opencode/SdkOpencode.ts"
import { handleDiscordMessage } from "./Orchestrator/Orchestrator.ts"
import { handleStopCommand } from "./Orchestrator/StopCommand.ts"
import { runTriggeredPrompt } from "./Orchestrator/TriggeredPrompt.ts"
import { shouldTriggerTurn, toDiscordScope } from "./Orchestrator/Triggering.ts"
import { createTurnManager, type TurnManager } from "./Orchestrator/TurnManager.ts"
import type { BotIdentity, DiscordMessage, DiscordScope, ToolRequest, TriggerRequest } from "./Schema.ts"
import { ensureDiscordTools } from "./Tools/Scaffolding.ts"

type ApplicationOptions = {
  readonly bot: BotIdentity
  readonly config: RuntimeConfig
  readonly discord: DiscordService
  readonly opencode: OpencodeService
  readonly turns?: TurnManager | undefined
}

type QueuedMessage = {
  readonly latest: DiscordMessage
  readonly skipped: ReadonlyArray<DiscordMessage>
}

export const makeApplication = (options: ApplicationOptions) => {
  const activeToolScopes = new Map<string, DiscordScope>()
  const queuedMessages = new Map<string, QueuedMessage>()
  const turns =
    options.turns ??
    createTurnManager(options.opencode, options.discord, {
      strategy: options.config.concurrency.strategy,
      globalMaxActiveTurns: options.config.concurrency.globalMaxActiveTurns,
      maxTurn: options.config.guards.maxTurn
    })
  const activeScopeKey = (scope: DiscordScope): string => `${scope.guildId}:${scope.channelId}:${scope.threadId ?? ""}`
  const scopeFromTrigger = (request: TriggerRequest): DiscordScope => ({
    guildId: request.guildId,
    channelId: request.channelId,
    ...(request.threadId === undefined ? {} : { threadId: request.threadId })
  })
  const handleMessage = (message: DiscordMessage, skippedMessages: ReadonlyArray<DiscordMessage> = []) => {
    const scope = toDiscordScope(message)
    const key = activeScopeKey(scope)
    return Effect.gen(function* () {
      yield* Effect.sync(() => activeToolScopes.set(key, scope))
      return yield* handleDiscordMessage(message, options, skippedMessages)
    }).pipe(Effect.ensuring(Effect.sync(() => activeToolScopes.delete(key))))
  }

  const runQueuedMessage = (key: string) =>
    Effect.gen(function* () {
      const queued = yield* Effect.sync(() => queuedMessages.get(key))
      if (queued === undefined) return
      yield* Effect.sync(() => queuedMessages.delete(key))
      yield* handleMessage(queued.latest, queued.skipped).pipe(
        Effect.asVoid,
        Effect.catch(() => Effect.void)
      )
    }).pipe(Effect.asVoid)

  const queueMessage = (key: string, message: DiscordMessage, skippedMessages: ReadonlyArray<DiscordMessage>) =>
    Effect.sync(() => {
      const existing = queuedMessages.get(key)
      const skipped = (existing === undefined ? skippedMessages : [...existing.skipped, existing.latest, ...skippedMessages]).slice(
        -options.config.context.messages
      )
      queuedMessages.set(key, { latest: message, skipped })
    })

  const handleTriggeredPrompt = (request: TriggerRequest) => {
    const scope = scopeFromTrigger(request)
    const key = activeScopeKey(scope)
    return Effect.gen(function* () {
      yield* Effect.sync(() => activeToolScopes.set(key, scope))
      yield* runTriggeredPrompt(request, scope, options)
    }).pipe(
      Effect.catch(() => Effect.void),
      Effect.ensuring(Effect.sync(() => activeToolScopes.delete(key)))
    )
  }

  const startTriggeredTurn = (request: TriggerRequest) => {
    const scope = scopeFromTrigger(request)
    return turns.startTurn(scope, undefined, handleTriggeredPrompt(request)).pipe(Effect.asVoid)
  }

  return {
    start: Effect.tryPromise({
      try: () =>
        ensureDiscordTools({
          projectDir: options.config.opencode.projectDir,
          bridgePort: options.config.bridge.port,
          enabled: options.config.tools.enabled,
          autoInstall: options.config.tools.autoInstall
        }),
      catch: (cause) => cause
    }),
    handleMessage,
    startMessageTurn: (message: DiscordMessage, skippedMessages: ReadonlyArray<DiscordMessage> = []) => {
      const scope = toDiscordScope(message)
      const key = activeScopeKey(scope)
      return Effect.gen(function* () {
        const busy = activeToolScopes.has(key) || queuedMessages.has(key) || (yield* turns.isActive(scope))
        if (options.config.concurrency.strategy === "queue" && busy) {
          if (!shouldTriggerTurn(message, options.bot, message.threadId !== undefined)) return
          yield* queueMessage(key, message, skippedMessages)
          return yield* turns.startTurn(scope, undefined, runQueuedMessage(key)).pipe(Effect.asVoid)
        }
        return yield* turns
          .startTurn(
            scope,
            undefined,
            handleMessage(message, skippedMessages).pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void)
            )
          )
          .pipe(Effect.asVoid)
      })
    },
    startTriggeredTurn,
    handleStop: (scope: DiscordScope) => handleStopCommand(scope, turns, options.discord),
    handleTool: (request: ToolRequest) =>
      handleToolRequest(request, options.config, options.config.opencode.projectDir, options.discord, {
        allowedScopes: [...activeToolScopes.values()]
      }),
    startLoopback: (port = options.config.bridge.port) =>
      startLoopbackServer({
        port,
        config: options.config,
        projectDir: options.config.opencode.projectDir,
        discord: options.discord,
        getAllowedScopes: () => [...activeToolScopes.values()],
        ...(options.config.trigger.enabled ? { startTriggeredTurn } : {})
      })
  }
}

const preflight = Effect.sync(() => {
  if (typeof Bun === "undefined") throw new Error("opencode-discord-bot requires the Bun runtime")
})

export type RuntimeFactories = {
  readonly makeOpencode: (config: RuntimeConfig) => OpencodeService
  readonly makeDiscord: (gateway: DiscordGateway, config: RuntimeConfig) => DiscordService
  readonly startGateway: (options: DiscordGatewayOptions) => Effect.Effect<DiscordGateway, unknown, Scope.Scope>
  readonly keepAlive: Effect.Effect<void>
}

const makeProductionDiscord = (gateway: DiscordGateway, config: RuntimeConfig): DiscordService => {
  return makeLiveChatSdkDiscord({
    botToken: Redacted.value(config.discordToken),
    applicationId: config.discord.applicationId ?? gateway.bot.userId,
    ...(config.discord.publicKey === undefined ? {} : { publicKey: config.discord.publicKey })
  })
}

export const liveRuntimeFactories: RuntimeFactories = {
  makeOpencode: (config) => makeLiveSdkOpencode({ baseUrl: config.opencode.baseUrl, projectDir: config.opencode.projectDir }),
  makeDiscord: makeProductionDiscord,
  startGateway: startDiscordGateway,
  keepAlive: Effect.never
}

export const makeProgram = (
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  factories: RuntimeFactories = liveRuntimeFactories
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* preflight
      const config = yield* loadConfig({ cwd, env })
      const opencode = factories.makeOpencode(config)
      yield* opencode.checkHealth

      let app: ReturnType<typeof makeApplication> | undefined
      let intake: ChatGatewayIntake | undefined
      const gateway = yield* factories.startGateway({
        token: Redacted.value(config.discordToken),
        guildId: config.discord.guildId,
        onMessage: (message) => intake?.processMessage(message) ?? app?.startMessageTurn(message) ?? Effect.void,
        onStop: (scope) => app?.handleStop(scope) ?? Effect.void
      })
      const discord = factories.makeDiscord(gateway, config)
      app = makeApplication({ bot: gateway.bot, config, discord, opencode })
      intake = makeChatGatewayIntake({
        bot: gateway.bot,
        onMessage: (message, skippedMessages) => app?.startMessageTurn(message, skippedMessages) ?? Effect.void
      })

      const scaffoldedTools = yield* app.start
      const loopback = yield* app.startLoopback()
      const tools = scaffoldedTools.length === 0 ? "none" : scaffoldedTools.join(", ")
      yield* Effect.logInfo(
        `ready: Discord gateway connected as <@${gateway.bot.userId}>, opencode ${config.opencode.baseUrl}, bridge ${loopback.url}, tools ${tools}`
      )
      yield* factories.keepAlive
    })
  )

if (import.meta.main) {
  BunRuntime.runMain(makeProgram(process.cwd(), process.env), { disableErrorReporting: true })
}

export { defaultConfig }
