import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { RuntimeConfig, ToolConfig } from "../Config.ts"
import { defaultConfig } from "../Config.ts"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { handleToolRequest } from "./ToolControl.ts"

const withTools = (tools: Partial<ToolConfig>): RuntimeConfig => ({
  ...defaultConfig,
  tools: { ...defaultConfig.tools, ...tools }
})

describe("handleToolRequest high-risk actions", () => {
  test("dispatches opt-in thread creation through the Discord port", async () => {
    const discord = makeMemoryDiscord()
    const config = withTools({ createThread: true })

    const created = await Effect.runPromise(
      handleToolRequest(
        { action: "createThread", target: { guildId: "g1", channelId: "c1" }, args: { name: "work" } },
        config,
        "/repo",
        discord
      )
    )

    expect(created).toEqual({ ok: true, result: { id: "thread-1" } })
    expect(discord.threads).toEqual([{ scope: { guildId: "g1", channelId: "c1" }, name: "work" }])
  })
})
