import { describe, expect, test } from "bun:test"
import { Duration, Effect, Stream } from "effect"
import { defaultConfig } from "../Config.ts"
import { DiscordError, type DiscordService } from "../Discord/DiscordPort.ts"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { opencodeEventStream } from "../Opencode/EventMapping.ts"
import { OpencodeError } from "../Opencode/OpencodePort.ts"
import type { DiscordScope } from "../Schema.ts"
import { renderOpencodeEvents } from "./Renderer.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1" }

describe("renderOpencodeEvents", () => {
  test("renders snapshots, tool typing, and changed-file summaries", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      renderOpencodeEvents(
        Stream.fromIterable([
          { type: "tool-start", title: "Running tests" },
          { type: "text-snapshot", text: "Done" },
          { type: "changed-files", files: 3, insertions: 42, deletions: 7 },
          { type: "tool-end" },
          { type: "idle" }
        ]),
        scope,
        defaultConfig,
        discord
      )
    )

    expect(discord.typingScopes).toEqual([scope])
    expect(discord.messages).toEqual([
      { scope, content: "Running tests..." },
      { scope, content: "Done" }
    ])
    expect(discord.edits).toEqual([
      { scope, messageId: "posted-2", content: "Done\n\nChanged: 3 files (+42/-7)" },
      { scope, messageId: "posted-1", content: "Tool finished." }
    ])
  })

  test("streams text by posting once and editing as deltas arrive", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      renderOpencodeEvents(
        Stream.fromIterable([{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }, { type: "idle" }]),
        scope,
        defaultConfig,
        discord
      )
    )

    expect(discord.typingScopes).toEqual([scope])
    expect(discord.messages).toEqual([{ scope, content: "Hel" }])
    expect(discord.edits).toEqual([{ scope, messageId: "posted-1", content: "Hello" }])
  })

  test("refreshes the final answer when completion stops an active typing phase", async () => {
    const discord = makeMemoryDiscord()
    const config = { ...defaultConfig, streaming: { ...defaultConfig.streaming, showToolStatus: false } }

    await Effect.runPromise(
      renderOpencodeEvents(
        Stream.fromIterable([{ type: "text-delta", text: "Done" }, { type: "tool-start", title: "Checking" }, { type: "idle" }]),
        scope,
        config,
        discord
      )
    )

    expect(discord.typingScopes).toEqual([scope, scope])
    expect(discord.messages).toEqual([{ scope, content: "Done" }])
    expect(discord.edits).toEqual([{ scope, messageId: "posted-1", content: "Done" }])
  })

  test("starts typing before the first stream event arrives", async () => {
    const discord = makeMemoryDiscord()
    let releaseStream: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      releaseStream = resolve
    })

    const running = Effect.runPromise(
      renderOpencodeEvents(
        Stream.fromAsyncIterable(
          (async function* () {
            await waiting
            yield { type: "text-delta" as const, text: "Hello" }
            yield { type: "idle" as const }
          })(),
          () => new OpencodeError({ message: "stream failed" })
        ),
        scope,
        defaultConfig,
        discord
      )
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(discord.typingScopes).toEqual([scope])
    expect(discord.messages).toEqual([])

    releaseStream?.()
    await running

    expect(discord.messages).toEqual([{ scope, content: "Hello" }])
  })

  test("posts continuation messages when streamed content exceeds the Discord limit", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      renderOpencodeEvents(Stream.fromIterable([{ type: "text-delta", text: "a".repeat(2001) }]), scope, defaultConfig, discord)
    )

    expect(discord.messages.map((item) => item.content.length)).toEqual([2000, 1])
  })

  test("deletes stale continuation messages when a later snapshot is shorter", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      renderOpencodeEvents(
        Stream.fromIterable([
          { type: "text-delta", text: "a".repeat(2001) },
          { type: "text-snapshot", text: "short" }
        ]),
        scope,
        defaultConfig,
        discord
      )
    )

    expect(discord.messages.map((item) => item.content.length)).toEqual([2000, 1])
    expect(discord.edits).toEqual([{ scope, messageId: "posted-1", content: "short" }])
    expect(discord.deletes).toEqual([{ scope, messageId: "posted-2" }])
  })

  test("does not post the Discord context prompt from user message part events", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      renderOpencodeEvents(
        opencodeEventStream(
          Stream.fromIterable([
            { type: "message.updated", properties: { sessionID: "s1", info: { id: "user-message", role: "user" } } },
            {
              type: "message.part.updated",
              properties: {
                sessionID: "s1",
                part: { sessionID: "s1", messageID: "user-message", type: "text", text: "Discord bridge context" }
              }
            },
            { type: "session.next.text.ended", properties: { sessionID: "s1", text: "Normal answer" } },
            { type: "session.idle", properties: { sessionID: "s1" } }
          ])
        ),
        scope,
        defaultConfig,
        discord
      )
    )

    expect(discord.messages).toEqual([{ scope, content: "Normal answer" }])
    expect(discord.edits).toEqual([])
  })
})

describe("renderOpencodeEvents guards", () => {
  test("can suppress changed-file summaries", async () => {
    const discord = makeMemoryDiscord()
    const config = { ...defaultConfig, streaming: { ...defaultConfig.streaming, changedFilesSummary: false } }

    await Effect.runPromise(
      renderOpencodeEvents(
        Stream.fromIterable([
          { type: "text-delta", text: "Done" },
          { type: "changed-files", files: 1, insertions: 1, deletions: 0 }
        ]),
        scope,
        config,
        discord
      )
    )

    expect(discord.messages).toEqual([{ scope, content: "Done" }])
  })

  test("omits changed-file summaries when nothing changed", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      renderOpencodeEvents(
        Stream.fromIterable([
          { type: "text-delta", text: "Done" },
          { type: "changed-files", files: 0, insertions: 0, deletions: 0 },
          { type: "idle" }
        ]),
        scope,
        defaultConfig,
        discord
      )
    )

    expect(discord.messages).toEqual([{ scope, content: "Done" }])
    expect(discord.edits).toEqual([])
  })

  test("neutralizes mass mentions by default", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      renderOpencodeEvents(Stream.fromIterable([{ type: "text-delta", text: "@everyone @here <@&123>" }]), scope, defaultConfig, discord)
    )

    expect(discord.messages).toEqual([{ scope, content: "@ everyone @ here <@& 123>" }])
  })

  test("honors Discord retry-after metadata when retrying output", async () => {
    const memory = makeMemoryDiscord()
    let attempts = 0
    const discord: DiscordService = {
      ...memory,
      postMessage: (target, content) =>
        Effect.gen(function* () {
          attempts += 1
          if (attempts === 1) return yield* Effect.fail(new DiscordError({ message: "rate limited", retryAfter: Duration.millis(0) }))
          return yield* memory.postMessage(target, content)
        })
    }

    await Effect.runPromise(
      renderOpencodeEvents(Stream.fromIterable([{ type: "text-delta", text: "hello" }]), scope, defaultConfig, discord)
    )

    expect(attempts).toBe(2)
    expect(memory.messages).toEqual([{ scope, content: "hello" }])
  })

  test("fails on opencode error events", async () => {
    await expect(
      renderOpencodeEvents(Stream.fromIterable([{ type: "error", message: "boom" }]), scope, defaultConfig, makeMemoryDiscord()).pipe(
        Effect.runPromise
      )
    ).rejects.toMatchObject({ _tag: "OpencodeError", message: "boom" })
  })
})
