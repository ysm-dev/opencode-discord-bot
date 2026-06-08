import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { DiscordMessage, DiscordScope } from "../Schema.ts"
import { makeMemoryDiscord } from "./MemoryDiscord.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1" }

const message = (id: string): DiscordMessage => ({
  id,
  guildId: "g1",
  channelId: "c1",
  author: { id: "u1", displayName: "Alice", isBot: false },
  content: id,
  timestamp: "2026-06-05T14:03:00.000Z",
  mentions: [],
  roleMentions: [],
  everyoneMention: false,
  hereMention: false,
  attachments: [],
  reactions: [],
  channelType: "guild"
})

describe("makeMemoryDiscord", () => {
  test("records every Discord port operation", async () => {
    const discord = makeMemoryDiscord({ context: [message("1"), message("2")] })

    const context = await Effect.runPromise(discord.fetchContext(scope, 1))
    const history = await Effect.runPromise(discord.fetchHistory(scope, 2))
    const posted = await Effect.runPromise(discord.postMessage(scope, "hello"))
    await Effect.runPromise(discord.editMessage(scope, posted.id, "updated"))
    await Effect.runPromise(discord.addReaction(scope, "m1", "rocket"))
    await Effect.runPromise(discord.removeReaction(scope, "m1", "rocket"))
    const attached = await Effect.runPromise(discord.attachFile(scope, "/repo/out.txt"))

    expect(context.map((item) => item.id)).toEqual(["2"])
    expect(history.map((item) => item.id)).toEqual(["1", "2"])
    expect(posted).toEqual({ id: "posted-1" })
    expect(discord.messages).toEqual([{ scope, content: "hello" }])
    expect(discord.edits).toEqual([{ scope, messageId: "posted-1", content: "updated" }])
    expect(discord.reactions.map((item) => item.op)).toEqual(["add", "remove"])
    expect(attached).toEqual({ path: "/repo/out.txt" })
  })
})
