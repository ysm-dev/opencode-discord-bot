import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { defaultConfig } from "../Config.ts"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { opencodeEventStream } from "../Opencode/EventMapping.ts"
import type { DiscordScope } from "../Schema.ts"
import { renderOpencodeEvents } from "./Renderer.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1" }

describe("renderOpencodeEvents text segments", () => {
  test("preserves separate text parts around hidden reasoning", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      renderOpencodeEvents(
        opencodeEventStream(
          Stream.fromIterable([
            { type: "session.next.reasoning.started", properties: { sessionID: "s1", reasoningID: "r1" } },
            { type: "session.next.text.delta", properties: { sessionID: "s1", textID: "text-1", delta: "First response" } },
            { type: "session.next.text.ended", properties: { sessionID: "s1", textID: "text-1", text: "First response" } },
            { type: "session.next.reasoning.started", properties: { sessionID: "s1", reasoningID: "r2" } },
            { type: "session.next.text.delta", properties: { sessionID: "s1", textID: "text-2", delta: "Second response" } },
            { type: "session.next.text.ended", properties: { sessionID: "s1", textID: "text-2", text: "Second response" } },
            { type: "session.idle", properties: { sessionID: "s1" } }
          ])
        ),
        scope,
        defaultConfig,
        discord
      )
    )

    expect(discord.typingScopes).toEqual([scope, scope])
    expect(discord.messages).toEqual([
      { scope, content: "First response" },
      { scope, content: "Second response" }
    ])
    expect(discord.edits).toEqual([])
    expect(discord.deletes).toEqual([])
  })

  test("does not delete earlier text-part continuation messages when a later part is shorter", async () => {
    const discord = makeMemoryDiscord()
    const long = "a".repeat(2001)

    await Effect.runPromise(
      renderOpencodeEvents(
        Stream.fromIterable([
          { type: "text-delta", id: "text-1", text: long },
          { type: "text-snapshot", id: "text-1", text: long },
          { type: "text-delta", id: "text-2", text: "short" },
          { type: "text-snapshot", id: "text-2", text: "short" }
        ]),
        scope,
        defaultConfig,
        discord
      )
    )

    expect(discord.messages.map((item) => item.content.length)).toEqual([2000, 1, 5])
    expect(discord.deletes).toEqual([])
  })
})
