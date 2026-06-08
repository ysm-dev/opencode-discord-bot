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
