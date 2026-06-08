import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Redacted } from "effect"
import { defaultConfig, loadConfig, loadConfigFromSources } from "./Config.ts"

describe("loadConfigFromSources", () => {
  test("merges defaults, JSONC config, and environment with env precedence", async () => {
    const config = await Effect.runPromise(
      loadConfigFromSources({
        cwd: "/repo/bot",
        env: {
          DISCORD_TOKEN: "discord-token",
          OPENCODE_PORT: "5050",
          DISCORD_BRIDGE_PORT: "9999",
          OPENCODE_AGENT: "discord-agent"
        },
        configText: `{
          // file values are lower precedence than env
          "contextMessages": 12,
          "contextMaxChars": 1234,
          "streaming": { "updateIntervalMs": 250, "showToolStatus": false },
          "threads": { "activeByRecentBotParticipation": false },
          "concurrency": { "strategy": "burst", "globalMaxActiveTurns": 4 },
          "guards": { "ignoreBots": false, "stripMassMentions": false, "redactSecretsInErrors": false, "maxTurnMs": 1000 },
          "tools": { "createThread": true, "pin": true }
        }`
      })
    )

    expect(Redacted.value(config.discordToken)).toBe("discord-token")
    expect(config.opencode.baseUrl).toBe("http://127.0.0.1:5050")
    expect(config.opencode.projectDir).toBe("/repo/bot")
    expect(config.opencode.agent).toBe("discord-agent")
    expect(config.bridge.port).toBe(9999)
    expect(config.context.messages).toBe(12)
    expect(config.context.maxChars).toBe(1234)
    expect(config.streaming.updateInterval).toEqual(Duration.millis(250))
    expect(config.streaming.showToolStatus).toBe(false)
    expect(config.threads.activeByRecentBotParticipation).toBe(false)
    expect(config.concurrency.strategy).toBe("burst")
    expect(config.concurrency.globalMaxActiveTurns).toBe(4)
    expect(config.guards.ignoreBots).toBe(false)
    expect(config.guards.stripMassMentions).toBe(false)
    expect(config.guards.redactSecretsInErrors).toBe(false)
    expect(config.guards.maxTurn).toEqual(Duration.millis(1000))
    expect(config.tools.reactions).toBe(true)
    expect(config.tools.createThread).toBe(true)
    expect(config.tools.pin).toBe(true)
  })

  test("uses the normative localhost defaults", async () => {
    const config = await Effect.runPromise(loadConfigFromSources({ cwd: "/work", env: { DISCORD_TOKEN: "token" } }))

    expect(config.opencode.baseUrl).toBe("http://127.0.0.1:4096")
    expect(config.opencode.projectDir).toBe("/work")
    expect(config.bridge.host).toBe(defaultConfig.bridge.host)
    expect(config.bridge.port).toBe(8787)
    expect(config.context.messages).toBe(30)
    expect(config.tools.autoInstall).toBe(true)
    expect(config.tools.followUpMessages).toBe(true)
    expect(config.tools.postOtherChannels).toBe(false)
  })

  test("fails fast when DISCORD_TOKEN is missing", async () => {
    await expect(loadConfigFromSources({ cwd: "/work", env: {} }).pipe(Effect.runPromise)).rejects.toMatchObject({
      _tag: "ConfigError"
    })
  })

  test("fails fast when config text is invalid JSONC", async () => {
    await expect(
      loadConfigFromSources({ cwd: "/work", env: { DISCORD_TOKEN: "token" }, configText: "{" }).pipe(Effect.runPromise)
    ).rejects.toMatchObject({
      _tag: "ConfigError",
      message: "Config file must be valid JSONC"
    })
  })

  test("fails fast when JSONC config fails schema validation", async () => {
    await expect(
      loadConfigFromSources({ cwd: "/work", env: { DISCORD_TOKEN: "token" }, configText: `{ "contextMessages": "many" }` }).pipe(
        Effect.runPromise
      )
    ).rejects.toMatchObject({
      _tag: "ConfigError",
      message: "Config file failed schema validation"
    })

    await expect(
      loadConfigFromSources({
        cwd: "/work",
        env: { DISCORD_TOKEN: "token" },
        configText: `{ "streaming": { "updateIntervalMs": -1 } }`
      }).pipe(Effect.runPromise)
    ).rejects.toMatchObject({
      _tag: "ConfigError",
      message: "Config file failed schema validation"
    })
  })

  test("loads .opencode-discord.jsonc from the working directory when present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ocdb-config-"))

    try {
      await writeFile(join(cwd, ".opencode-discord.jsonc"), `{ "contextMessages": 7, "tools": { "pin": true } }`)
      const config = await Effect.runPromise(loadConfig({ cwd, env: { DISCORD_TOKEN: "token" } }))

      expect(config.context.messages).toBe(7)
      expect(config.tools.pin).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("treats a missing .opencode-discord.jsonc as an empty config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ocdb-config-missing-"))

    try {
      const config = await Effect.runPromise(loadConfig({ cwd, env: { DISCORD_TOKEN: "token" } }))

      expect(config.context.messages).toBe(defaultConfig.context.messages)
      expect(config.opencode.projectDir).toBe(cwd)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("reports unreadable config files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ocdb-config-unreadable-"))

    try {
      await expect(loadConfig({ cwd, env: { DISCORD_TOKEN: "token" }, configPath: cwd }).pipe(Effect.runPromise)).rejects.toMatchObject({
        _tag: "ConfigError",
        message: "Unable to read config file"
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
