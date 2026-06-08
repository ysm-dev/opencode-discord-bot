import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { DiscordScope } from "../Schema.ts"
import { makeMemoryOpencode } from "./MemoryOpencode.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1", threadId: "t1" }

describe("makeMemoryOpencode", () => {
  test("records prompts and aborts by Discord scope", async () => {
    const opencode = makeMemoryOpencode([{ type: "text-delta", text: "ok" }, { type: "idle" }])
    const events = await Effect.runPromise(opencode.runPrompt({ prompt: "hello", projectDir: "/repo", scope }).pipe(Stream.runCollect))
    await Effect.runPromise(opencode.abort(scope).pipe(Stream.runCollect))

    expect(events).toEqual([{ type: "text-delta", text: "ok" }, { type: "idle" }])
    expect(opencode.prompts.map((item) => item.prompt)).toEqual(["hello"])
    expect(opencode.aborted).toEqual(["t1"])
  })
})
