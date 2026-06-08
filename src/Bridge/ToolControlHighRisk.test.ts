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
  test("dispatches opt-in high-risk actions through the Discord port", async () => {
    const discord = makeMemoryDiscord({
      context: [
        {
          id: "m1",
          guildId: "g1",
          channelId: "c1",
          author: { id: "bot-1", displayName: "bot", isBot: true },
          content: "old",
          timestamp: "2026-06-05T14:03:00.000Z",
          mentions: [],
          roleMentions: [],
          everyoneMention: false,
          hereMention: false,
          attachments: [],
          reactions: [],
          channelType: "guild"
        }
      ]
    })
    const config = withTools({ createThread: true, editDeleteOwn: true, pin: true })

    const created = await Effect.runPromise(
      handleToolRequest(
        { action: "createThread", target: { guildId: "g1", channelId: "c1" }, args: { name: "work" } },
        config,
        "/repo",
        discord,
        { botId: "bot-1" }
      )
    )
    const edited = await Effect.runPromise(
      handleToolRequest(
        { action: "editOwnMessage", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: { content: "edited" } },
        config,
        "/repo",
        discord,
        { botId: "bot-1" }
      )
    )
    const deleted = await Effect.runPromise(
      handleToolRequest(
        { action: "deleteOwnMessage", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: {} },
        config,
        "/repo",
        discord,
        { botId: "bot-1" }
      )
    )
    const pinned = await Effect.runPromise(
      handleToolRequest({ action: "pin", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: {} }, config, "/repo", discord)
    )
    const unpinned = await Effect.runPromise(
      handleToolRequest(
        { action: "unpin", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: {} },
        config,
        "/repo",
        discord
      )
    )

    expect(created).toEqual({ ok: true, result: { id: "thread-1" } })
    expect(edited).toEqual({ ok: true, result: { edited: true } })
    expect(deleted).toEqual({ ok: true, result: { deleted: true } })
    expect(pinned).toEqual({ ok: true, result: { pinned: true } })
    expect(unpinned).toEqual({ ok: true, result: { pinned: false } })
    expect(discord.threads).toEqual([{ scope: { guildId: "g1", channelId: "c1" }, name: "work" }])
    expect(discord.pins.map((item) => item.op)).toEqual(["pin", "unpin"])
  })

  test("rejects edit/delete requests for messages not authored by the bot", async () => {
    const discord = makeMemoryDiscord({
      context: [
        {
          id: "m1",
          guildId: "g1",
          channelId: "c1",
          author: { id: "user-1", displayName: "user", isBot: false },
          content: "user text",
          timestamp: "2026-06-05T14:03:00.000Z",
          mentions: [],
          roleMentions: [],
          everyoneMention: false,
          hereMention: false,
          attachments: [],
          reactions: [],
          channelType: "guild"
        }
      ]
    })
    const config = withTools({ editDeleteOwn: true })

    const edited = await Effect.runPromise(
      handleToolRequest(
        { action: "editOwnMessage", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: { content: "edited" } },
        config,
        "/repo",
        discord,
        { botId: "bot-1" }
      )
    )
    const deleted = await Effect.runPromise(
      handleToolRequest(
        { action: "deleteOwnMessage", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: {} },
        config,
        "/repo",
        discord,
        { botId: "bot-1" }
      )
    )

    expect(edited).toEqual({ ok: false, error: "messageId must refer to a bot-authored message" })
    expect(deleted).toEqual({ ok: false, error: "messageId must refer to a bot-authored message" })
    expect(discord.edits).toEqual([])
    expect(discord.deletes).toEqual([])
  })
})
