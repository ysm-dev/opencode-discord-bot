import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Data, Duration, Effect, Redacted, Schema } from "effect"
import { type ParseError, parse } from "jsonc-parser"
import { RawConfigSchema } from "./ConfigSchema.ts"
import type { ConfigSources, LoadConfigOptions } from "./ConfigTypes.ts"

export type { ConfigSources, LoadConfigOptions } from "./ConfigTypes.ts"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
}> {}

export type ToolConfig = {
  readonly enabled: boolean
  readonly autoInstall: boolean
  readonly reactions: boolean
  readonly attachFiles: boolean
  readonly searchMessages: boolean
  readonly createThread: boolean
}

export type RuntimeConfig = {
  readonly discordToken: Redacted.Redacted<string>
  readonly discord: {
    readonly applicationId?: string
    readonly publicKey?: string
    readonly guildId?: string
  }
  readonly opencode: {
    readonly port: number
    readonly baseUrl: string
    readonly projectDir: string
    readonly model?: string
    readonly agent?: string
  }
  readonly bridge: {
    readonly host: "127.0.0.1"
    readonly port: number
  }
  readonly context: {
    readonly messages: number
    readonly maxChars: number
    readonly attachmentMaxBytes: number
  }
  readonly threads: {
    readonly activeByRecentBotParticipation: boolean
  }
  readonly tools: ToolConfig
  readonly streaming: {
    readonly updateInterval: Duration.Duration
    readonly placeholderText: string | null
    readonly showToolStatus: boolean
    readonly changedFilesSummary: boolean
  }
  readonly concurrency: {
    readonly strategy: "queue" | "burst"
    readonly lockScope: "discord-scope"
    readonly globalMaxActiveTurns: number | null
  }
  readonly guards: {
    readonly ignoreBots: boolean
    readonly stripMassMentions: boolean
    readonly redactSecretsInErrors: boolean
    readonly maxTurn: Duration.Duration | null
  }
}

export const defaultConfig: RuntimeConfig = {
  discordToken: Redacted.make(""),
  discord: {},
  opencode: {
    port: 4096,
    baseUrl: "http://127.0.0.1:4096",
    projectDir: process.cwd()
  },
  bridge: {
    host: "127.0.0.1",
    port: 8787
  },
  context: {
    messages: 30,
    maxChars: 60_000,
    attachmentMaxBytes: 10 * 1024 * 1024
  },
  threads: {
    activeByRecentBotParticipation: true
  },
  tools: {
    enabled: true,
    autoInstall: true,
    reactions: true,
    attachFiles: true,
    searchMessages: true,
    createThread: false
  },
  streaming: {
    updateInterval: Duration.millis(500),
    placeholderText: null,
    showToolStatus: true,
    changedFilesSummary: true
  },
  concurrency: {
    strategy: "queue",
    lockScope: "discord-scope",
    globalMaxActiveTurns: null
  },
  guards: {
    ignoreBots: true,
    stripMassMentions: true,
    redactSecretsInErrors: true,
    maxTurn: null
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const decodeRawConfig = (value: unknown): Effect.Effect<Readonly<Record<string, unknown>>, ConfigError> =>
  Schema.decodeUnknownEffect(RawConfigSchema)(value).pipe(
    Effect.map((decoded) => decoded),
    Effect.mapError(() => new ConfigError({ message: "Config file failed schema validation" }))
  )

const readRecord = (source: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> => {
  const value = source[key]
  return isRecord(value) ? value : {}
}

const readNumber = (source: Readonly<Record<string, unknown>>, key: string, fallback: number): number => {
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

const readBoolean = (source: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean => {
  const value = source[key]
  return typeof value === "boolean" ? value : fallback
}

const readNullableString = (source: Readonly<Record<string, unknown>>, key: string, fallback: string | null): string | null => {
  const value = source[key]
  if (value === null) return null
  return typeof value === "string" ? value : fallback
}

const readNullableNumber = (source: Readonly<Record<string, unknown>>, key: string, fallback: number | null): number | null => {
  const value = source[key]
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

const readConcurrencyStrategy = (source: Readonly<Record<string, unknown>>): "queue" | "burst" => {
  const value = source.strategy
  return value === "queue" || value === "burst" ? value : defaultConfig.concurrency.strategy
}

const optionalEnv = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

const parsePort = (value: string | undefined, fallback: number, name: string): Effect.Effect<number, ConfigError> => {
  if (value === undefined || value.trim() === "") return Effect.succeed(fallback)
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) return Effect.succeed(parsed)
  return Effect.fail(new ConfigError({ message: `${name} must be a TCP port` }))
}

const parseConfigText = (text: string | undefined): Effect.Effect<Readonly<Record<string, unknown>>, ConfigError> => {
  if (text === undefined || text.trim() === "") return Effect.succeed({})
  return Effect.try({
    try: () => {
      const errors: Array<ParseError> = []
      const parsed: unknown = parse(text, errors)
      if (errors.length > 0) throw new Error("Invalid JSONC")
      if (!isRecord(parsed)) return {}
      return parsed
    },
    catch: () => new ConfigError({ message: "Config file must be valid JSONC" })
  }).pipe(Effect.flatMap(decodeRawConfig))
}

const isMissingFile = (cause: unknown): boolean => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

const readOptionalConfigFile = (path: string): Effect.Effect<string | undefined, ConfigError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(path, "utf8")
      } catch (cause) {
        if (isMissingFile(cause)) return undefined
        throw cause
      }
    },
    catch: () => new ConfigError({ message: "Unable to read config file" })
  })

export const loadConfigFromSources = Effect.fn("loadConfigFromSources")(function* (sources: ConfigSources) {
  const file = yield* parseConfigText(sources.configText)
  const token = sources.env.DISCORD_TOKEN
  if (token === undefined || token.trim() === "") {
    return yield* Effect.fail(new ConfigError({ message: "DISCORD_TOKEN is required" }))
  }

  const opencodePort = yield* parsePort(sources.env.OPENCODE_PORT, defaultConfig.opencode.port, "OPENCODE_PORT")
  const bridgePort = yield* parsePort(sources.env.DISCORD_BRIDGE_PORT, defaultConfig.bridge.port, "DISCORD_BRIDGE_PORT")
  const tools = readRecord(file, "tools")
  const streaming = readRecord(file, "streaming")
  const threads = readRecord(file, "threads")
  const concurrency = readRecord(file, "concurrency")
  const guards = readRecord(file, "guards")

  const applicationId = optionalEnv(sources.env.DISCORD_APPLICATION_ID)
  const publicKey = optionalEnv(sources.env.DISCORD_PUBLIC_KEY)
  const guildId = optionalEnv(sources.env.DISCORD_GUILD_ID)
  const model = optionalEnv(sources.env.OPENCODE_MODEL)
  const agent = optionalEnv(sources.env.OPENCODE_AGENT)
  const projectDir = optionalEnv(sources.env.OPENCODE_PROJECT_DIR) ?? sources.cwd
  const maxTurnMs = readNullableNumber(guards, "maxTurnMs", null)

  return {
    discordToken: Redacted.make(token),
    discord: {
      ...(applicationId === undefined ? {} : { applicationId }),
      ...(publicKey === undefined ? {} : { publicKey }),
      ...(guildId === undefined ? {} : { guildId })
    },
    opencode: {
      port: opencodePort,
      baseUrl: `http://127.0.0.1:${opencodePort}`,
      projectDir,
      ...(model === undefined ? {} : { model }),
      ...(agent === undefined ? {} : { agent })
    },
    bridge: {
      host: defaultConfig.bridge.host,
      port: bridgePort
    },
    context: {
      messages: readNumber(file, "contextMessages", defaultConfig.context.messages),
      maxChars: readNumber(file, "contextMaxChars", defaultConfig.context.maxChars),
      attachmentMaxBytes: readNumber(file, "attachmentMaxBytes", defaultConfig.context.attachmentMaxBytes)
    },
    threads: {
      activeByRecentBotParticipation: readBoolean(
        threads,
        "activeByRecentBotParticipation",
        defaultConfig.threads.activeByRecentBotParticipation
      )
    },
    tools: {
      enabled: readBoolean(tools, "enabled", defaultConfig.tools.enabled),
      autoInstall: readBoolean(tools, "autoInstall", defaultConfig.tools.autoInstall),
      reactions: readBoolean(tools, "reactions", defaultConfig.tools.reactions),
      attachFiles: readBoolean(tools, "attachFiles", defaultConfig.tools.attachFiles),
      searchMessages: readBoolean(tools, "searchMessages", defaultConfig.tools.searchMessages),
      createThread: readBoolean(tools, "createThread", defaultConfig.tools.createThread)
    },
    streaming: {
      updateInterval: Duration.millis(readNumber(streaming, "updateIntervalMs", 500)),
      placeholderText: readNullableString(streaming, "placeholderText", defaultConfig.streaming.placeholderText),
      showToolStatus: readBoolean(streaming, "showToolStatus", defaultConfig.streaming.showToolStatus),
      changedFilesSummary: readBoolean(streaming, "changedFilesSummary", defaultConfig.streaming.changedFilesSummary)
    },
    concurrency: {
      strategy: readConcurrencyStrategy(concurrency),
      lockScope: defaultConfig.concurrency.lockScope,
      globalMaxActiveTurns: readNullableNumber(concurrency, "globalMaxActiveTurns", defaultConfig.concurrency.globalMaxActiveTurns)
    },
    guards: {
      ignoreBots: readBoolean(guards, "ignoreBots", defaultConfig.guards.ignoreBots),
      stripMassMentions: readBoolean(guards, "stripMassMentions", defaultConfig.guards.stripMassMentions),
      redactSecretsInErrors: readBoolean(guards, "redactSecretsInErrors", defaultConfig.guards.redactSecretsInErrors),
      maxTurn: maxTurnMs === null ? null : Duration.millis(maxTurnMs)
    }
  } satisfies RuntimeConfig
})

export const loadConfig = Effect.fn("loadConfig")(function* (options: LoadConfigOptions) {
  const configText = yield* readOptionalConfigFile(options.configPath ?? join(options.cwd, ".opencode-discord.jsonc"))
  return yield* loadConfigFromSources({ cwd: options.cwd, env: options.env, configText })
})
