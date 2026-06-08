import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { RuntimeConfig, ToolConfig } from "../Config.ts"
import { defaultConfig } from "../Config.ts"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { handleToolRequest } from "./ToolControl.ts"

const withTools = (tools: Partial<ToolConfig>): RuntimeConfig => ({
  ...defaultConfig,
  tools: { ...defaultConfig.tools, ...tools }
})

describe("handleToolRequest", () => {
  test("allows safe default actions through the Discord port", async () => {
    const discord = makeMemoryDiscord()
    const response = await Effect.runPromise(
      handleToolRequest(
        {
          action: "followUpMessage",
          target: { guildId: "g1", channelId: "c1" },
          args: { content: "done" }
        },
        defaultConfig,
        "/repo",
        discord
      )
    )

    expect(response.ok).toBe(true)
    expect(discord.messages).toEqual([{ scope: { guildId: "g1", channelId: "c1" }, content: "done" }])
  })

  test("neutralizes mass mentions in follow-up tool content", async () => {
    const discord = makeMemoryDiscord()

    const response = await Effect.runPromise(
      handleToolRequest(
        {
          action: "followUpMessage",
          target: { guildId: "g1", channelId: "c1" },
          args: { content: "@everyone @here <@&123>" }
        },
        defaultConfig,
        "/repo",
        discord
      )
    )

    expect(response.ok).toBe(true)
    expect(discord.messages).toEqual([{ scope: { guildId: "g1", channelId: "c1" }, content: "@ everyone @ here <@& 123>" }])
  })

  test("blocks higher-risk actions unless explicitly enabled", async () => {
    const response = await Effect.runPromise(
      handleToolRequest(
        { action: "createThread", target: { guildId: "g1", channelId: "c1" }, args: { name: "new" } },
        defaultConfig,
        "/repo",
        makeMemoryDiscord()
      )
    )

    expect(response).toEqual({ ok: false, error: "Action createThread is disabled" })
  })

  test("rejects DMs and unsafe attachment paths", async () => {
    const dm = await Effect.runPromise(
      handleToolRequest(
        { action: "followUpMessage", target: { channelId: "dm1" }, args: { content: "nope" } },
        defaultConfig,
        "/repo",
        makeMemoryDiscord()
      )
    )
    const unsafe = await Effect.runPromise(
      handleToolRequest(
        { action: "attachFile", target: { guildId: "g1", channelId: "c1" }, args: { path: "../secret.txt" } },
        defaultConfig,
        "/repo",
        makeMemoryDiscord()
      )
    )

    expect(dm.ok).toBe(false)
    expect(unsafe).toEqual({ ok: false, error: "Attachment path must stay inside the project directory" })
  })
})

describe("handleToolRequest action dispatch", () => {
  test("dispatches reactions, history, and safe attachments", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "ocdb-tool-"))
    await mkdir(join(projectDir, "out"), { recursive: true })
    await writeFile(join(projectDir, "out", "report.txt"), "report")
    const discord = makeMemoryDiscord({
      context: [
        {
          id: "m1",
          guildId: "g1",
          channelId: "c1",
          author: { id: "u1", displayName: "Alice", isBot: false },
          content: "hi",
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

    try {
      const add = await Effect.runPromise(
        handleToolRequest(
          { action: "addReaction", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: { emoji: "rocket" } },
          defaultConfig,
          projectDir,
          discord
        )
      )
      const remove = await Effect.runPromise(
        handleToolRequest(
          { action: "removeReaction", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: { emoji: "rocket" } },
          defaultConfig,
          projectDir,
          discord
        )
      )
      const history = await Effect.runPromise(
        handleToolRequest(
          { action: "fetchHistory", target: { guildId: "g1", channelId: "c1" }, args: { limit: 1 } },
          defaultConfig,
          projectDir,
          discord
        )
      )
      const attach = await Effect.runPromise(
        handleToolRequest(
          { action: "attachFile", target: { guildId: "g1", channelId: "c1" }, args: { path: "out/report.txt" } },
          defaultConfig,
          projectDir,
          discord
        )
      )
      const attachmentRealpath = await realpath(join(projectDir, "out", "report.txt"))

      expect(add).toEqual({ ok: true, result: { reacted: true } })
      expect(remove).toEqual({ ok: true, result: { reacted: false } })
      expect(history.ok).toBe(true)
      expect(attach).toEqual({ ok: true, result: { path: attachmentRealpath } })
      expect(discord.reactions.map((item) => item.op)).toEqual(["add", "remove"])
      expect(discord.attachments).toEqual([{ scope: { guildId: "g1", channelId: "c1" }, path: attachmentRealpath }])
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test("rejects oversized attachments", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "ocdb-tool-large-"))
    await writeFile(join(projectDir, "large.txt"), "large")

    try {
      const response = await Effect.runPromise(
        handleToolRequest(
          { action: "attachFile", target: { guildId: "g1", channelId: "c1" }, args: { path: "large.txt" } },
          { ...defaultConfig, context: { ...defaultConfig.context, attachmentMaxBytes: 1 } },
          projectDir,
          makeMemoryDiscord()
        )
      )

      expect(response).toEqual({ ok: false, error: "Attachment exceeds the configured size limit" })
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test("rejects default tool targets outside the active turn scope", async () => {
    const response = await Effect.runPromise(
      handleToolRequest(
        { action: "followUpMessage", target: { guildId: "g1", channelId: "other" }, args: { content: "nope" } },
        defaultConfig,
        "/repo",
        makeMemoryDiscord(),
        { allowedScopes: [{ guildId: "g1", channelId: "c1" }] }
      )
    )

    expect(response).toEqual({ ok: false, error: "Discord target is outside the active turn scope" })
  })

  test("returns validation errors for malformed or unsupported requests", async () => {
    const disabled = await Effect.runPromise(
      handleToolRequest(
        { action: "followUpMessage", target: { guildId: "g1", channelId: "c1" }, args: { content: "x" } },
        withTools({ enabled: false }),
        "/repo",
        makeMemoryDiscord()
      )
    )
    const unknown = await Effect.runPromise(
      handleToolRequest(
        { action: "unknown", target: { guildId: "g1", channelId: "c1" }, args: {} },
        defaultConfig,
        "/repo",
        makeMemoryDiscord()
      )
    )
    const missingContent = await Effect.runPromise(
      handleToolRequest(
        { action: "followUpMessage", target: { guildId: "g1", channelId: "c1" }, args: {} },
        defaultConfig,
        "/repo",
        makeMemoryDiscord()
      )
    )
    const missingReactionFields = await Effect.runPromise(
      handleToolRequest(
        { action: "addReaction", target: { guildId: "g1", channelId: "c1" }, args: {} },
        defaultConfig,
        "/repo",
        makeMemoryDiscord()
      )
    )
    const missingPath = await Effect.runPromise(
      handleToolRequest(
        { action: "attachFile", target: { guildId: "g1", channelId: "c1" }, args: {} },
        defaultConfig,
        "/repo",
        makeMemoryDiscord()
      )
    )

    expect(disabled).toEqual({ ok: false, error: "Discord bridge tools are disabled" })
    expect(unknown).toEqual({ ok: false, error: "Unknown action unknown" })
    expect(missingContent).toEqual({ ok: false, error: "content is required" })
    expect(missingReactionFields).toEqual({ ok: false, error: "messageId and emoji are required" })
    expect(missingPath).toEqual({ ok: false, error: "path is required" })
  })
})
