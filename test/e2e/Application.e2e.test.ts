import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import { loadConfigFromSources } from "../../src/Config.ts"
import { makeMemoryDiscord } from "../../src/Discord/MemoryDiscord.ts"
import { makeApplication } from "../../src/Main.ts"
import { OpencodeError, type OpencodePrompt, type OpencodeService } from "../../src/Opencode/OpencodePort.ts"
import type { DiscordMessage } from "../../src/Schema.ts"

const message = (projectDir: string): DiscordMessage => ({
  id: "m1",
  guildId: "g1",
  channelId: "c1",
  author: { id: "u1", displayName: "Alice", isBot: false },
  content: "<@999> ship it",
  timestamp: "2026-06-05T14:03:00.000Z",
  mentions: ["999"],
  roleMentions: [],
  everyoneMention: false,
  hereMention: false,
  attachments: [{ id: "a1", filename: "plan.txt", contentType: "text/plain", size: 10, url: `file://${projectDir}/plan.txt` }],
  reactions: [{ emoji: "rocket", count: 3 }],
  channelType: "guild"
})

describe("application e2e", () => {
  test("starts, scaffolds tools, handles a Discord turn, and serves a tool request", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "ocdb-e2e-"))

    try {
      const config = await Effect.runPromise(
        loadConfigFromSources({
          cwd: projectDir,
          env: { DISCORD_TOKEN: "token", OPENCODE_PROJECT_DIR: projectDir, DISCORD_BRIDGE_PORT: "8787" }
        })
      )
      const input = message(projectDir)
      const discord = makeMemoryDiscord({ context: [input] })
      const prompts: Array<OpencodePrompt> = []
      let releaseTurn: (() => void) | undefined
      const waiting = new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      const opencode: OpencodeService = {
        checkHealth: Effect.void,
        abort: () => Stream.empty,
        runPrompt: (prompt) => {
          prompts.push(prompt)
          return Stream.fromAsyncIterable(
            (async function* () {
              yield { type: "text-delta" as const, text: "Released" }
              await waiting
              yield { type: "idle" as const }
            })(),
            () => new OpencodeError({ message: "stream failed" })
          )
        }
      }
      const app = makeApplication({ bot: { userId: "999" }, config, discord, opencode })

      await Effect.runPromise(app.start)
      const running = Effect.runPromise(app.handleMessage(input))
      await new Promise((resolve) => setTimeout(resolve, 0))
      const toolResponse = await Effect.runPromise(
        app.handleTool({ action: "followUpMessage", target: { guildId: "g1", channelId: "c1" }, args: { content: "extra" } })
      )
      releaseTurn?.()
      await running

      const toolFile = await readFile(join(projectDir, ".opencode", "tools", "discord-bridge.ts"), "utf8")
      expect(toolFile).toContain("http://127.0.0.1:8787/tool")
      expect(prompts[0]?.prompt).toContain("plan.txt [text/plain; 10 bytes; file://")
      expect(prompts[0]?.prompt).toContain("(discord target: guildId=g1 channelId=c1 messageId=m1)")
      expect(prompts[0]?.parts).toEqual([{ type: "file", mime: "text/plain", filename: "plan.txt", url: `file://${projectDir}/plan.txt` }])
      expect(discord.messages.map((item) => item.content)).toEqual(["Released", "extra"])
      expect(toolResponse.ok).toBe(true)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})
