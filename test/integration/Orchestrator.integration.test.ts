import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { defaultConfig } from "../../src/Config.ts"
import { makeMemoryDiscord } from "../../src/Discord/MemoryDiscord.ts"
import { makeMemoryOpencode } from "../../src/Opencode/MemoryOpencode.ts"
import { handleDiscordMessage } from "../../src/Orchestrator/Orchestrator.ts"
import type { DiscordMessage } from "../../src/Schema.ts"

const mention: DiscordMessage = {
  id: "m1",
  guildId: "g1",
  channelId: "c1",
  author: { id: "u1", displayName: "Alice", isBot: false },
  content: "<@999> please help",
  timestamp: "2026-06-05T14:03:00.000Z",
  mentions: ["999"],
  roleMentions: [],
  everyoneMention: false,
  hereMention: false,
  attachments: [],
  reactions: [],
  channelType: "guild"
}

describe("orchestrator integration", () => {
  test("handles a main-channel mention by prompting opencode and replying in place", async () => {
    const discord = makeMemoryDiscord({ context: [mention] })
    const opencode = makeMemoryOpencode([{ type: "text-delta", text: "Hello" }, { type: "text-delta", text: " Alice" }, { type: "idle" }])

    const result = await Effect.runPromise(
      handleDiscordMessage(mention, {
        bot: { userId: "999" },
        config: defaultConfig,
        discord,
        opencode
      })
    )

    expect(result.handled).toBe(true)
    expect(opencode.prompts).toHaveLength(1)
    expect(opencode.prompts[0]?.prompt).toContain("please help")
    expect(discord.typingScopes).toEqual([{ guildId: "g1", channelId: "c1" }])
    expect(discord.messages).toEqual([{ scope: { guildId: "g1", channelId: "c1" }, content: "Hello" }])
    expect(discord.edits).toEqual([{ scope: { guildId: "g1", channelId: "c1" }, messageId: "posted-1", content: "Hello Alice" }])
  })

  test("reports concise opencode failures without stack traces", async () => {
    const discord = makeMemoryDiscord({ context: [mention] })
    const opencode = makeMemoryOpencode([{ type: "error", message: "ECONNREFUSED secret-token stack" }])

    await Effect.runPromise(
      handleDiscordMessage(mention, {
        bot: { userId: "999" },
        config: defaultConfig,
        discord,
        opencode
      })
    )

    expect(discord.messages[0]?.content).toBe("opencode is unavailable or returned an error: ECONNREFUSED [redacted] stack")
  })

  test("derives active thread follow-ups from fetched context without stored state", async () => {
    const followUp: DiscordMessage = { ...mention, id: "m2", content: "continue", mentions: [], threadId: "t1" }
    const botReply: DiscordMessage = {
      ...mention,
      id: "m0",
      content: "previous bot answer",
      threadId: "t1",
      mentions: [],
      author: { id: "999", displayName: "Bridge", isBot: true }
    }
    const discord = makeMemoryDiscord({ context: [botReply, followUp] })
    const opencode = makeMemoryOpencode([{ type: "text-delta", text: "continuing" }, { type: "idle" }])

    const result = await Effect.runPromise(
      handleDiscordMessage(followUp, {
        bot: { userId: "999" },
        config: defaultConfig,
        discord,
        opencode
      })
    )

    expect(result.handled).toBe(true)
    expect(opencode.prompts[0]?.scope).toEqual({ guildId: "g1", channelId: "c1", threadId: "t1" })
    expect(discord.messages).toEqual([{ scope: { guildId: "g1", channelId: "c1", threadId: "t1" }, content: "continuing" }])
  })

  test("ignores non-triggering main-channel messages", async () => {
    const plain: DiscordMessage = { ...mention, content: "hello", mentions: [] }
    const discord = makeMemoryDiscord({ context: [plain] })
    const opencode = makeMemoryOpencode([{ type: "text-delta", text: "unused" }])

    const result = await Effect.runPromise(
      handleDiscordMessage(plain, {
        bot: { userId: "999" },
        config: defaultConfig,
        discord,
        opencode
      })
    )

    expect(result.handled).toBe(false)
    expect(opencode.prompts).toEqual([])
    expect(discord.messages).toEqual([])
  })
})
