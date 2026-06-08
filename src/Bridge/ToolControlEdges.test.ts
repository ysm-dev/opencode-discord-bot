import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { defaultConfig } from "../Config.ts"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { handleToolRequest } from "./ToolControl.ts"

test("rejects missing attachment files inside the project", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "ocdb-tool-edge-"))
  try {
    const result = await Effect.runPromise(
      handleToolRequest(
        { action: "attachFile", target: { guildId: "g1", channelId: "c1" }, args: { path: "missing.txt" } },
        defaultConfig,
        projectDir,
        makeMemoryDiscord()
      )
    )

    expect(result).toEqual({ ok: false, error: "Attachment path must stay inside the project directory" })
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test("rejects incomplete high-risk tool payloads before dispatch", async () => {
  const config = {
    ...defaultConfig,
    tools: { ...defaultConfig.tools, editDeleteOwn: true, postOtherChannels: true }
  }
  const discord = makeMemoryDiscord()

  const edit = await Effect.runPromise(
    handleToolRequest(
      { action: "editOwnMessage", target: { guildId: "g1", channelId: "c1", messageId: "m1" }, args: {} },
      config,
      "/repo",
      discord
    )
  )
  const post = await Effect.runPromise(
    handleToolRequest({ action: "postOtherChannel", target: { guildId: "g1", channelId: "c2" }, args: {} }, config, "/repo", discord)
  )

  expect(edit).toEqual({ ok: false, error: "messageId and content are required" })
  expect(post).toEqual({ ok: false, error: "guildId, channelId, and content are required" })
})
