import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { DiscordScope } from "../Schema.ts"
import { makeSdkOpencode } from "./SdkOpencode.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1" }
const options = { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" }

describe("makeSdkOpencode failure paths", () => {
  test("maps prompt attachment preparation failures", async () => {
    const originalFetch = globalThis.fetch
    const failingFetch: typeof fetch = Object.assign(() => Promise.reject(new Error("network down")), {
      preconnect: () => {}
    })
    globalThis.fetch = failingFetch
    const client = {
      session: {
        create: () => Promise.resolve({ data: { id: "session-1" }, error: undefined }),
        promptAsync: () => Promise.resolve({ data: {}, error: undefined }),
        abort: () => Promise.resolve({ data: {}, error: undefined })
      },
      event: {
        subscribe: () => Promise.resolve({ stream: (async function* () {})() })
      },
      global: {
        health: () => Promise.resolve({ data: { ok: true }, error: undefined })
      }
    }

    const opencode = makeSdkOpencode(client, options)

    try {
      await expect(
        opencode
          .runPrompt({
            prompt: "hello",
            projectDir: "/repo",
            scope,
            parts: [{ type: "file", mime: "image/png", filename: "shot.png", url: "https://cdn/shot.png" }]
          })
          .pipe(Stream.runCollect, Effect.runPromise)
      ).rejects.toMatchObject({ _tag: "OpencodeError", message: "failed to fetch image attachment shot.png: network down" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("propagates SSE stream failures", async () => {
    const client = {
      session: {
        create: () => Promise.resolve({ data: { id: "session-1" }, error: undefined }),
        promptAsync: () => Promise.resolve({ data: {}, error: undefined }),
        abort: () => Promise.resolve({ data: {}, error: undefined })
      },
      event: {
        subscribe: () =>
          Promise.resolve({
            stream: (async function* () {
              yield { type: "session.next.text.delta", properties: { sessionID: "session-1", delta: "ok" } }
              throw new Error("stream blew up")
            })()
          })
      },
      global: {
        health: () => Promise.resolve({ data: { ok: true }, error: undefined })
      }
    }

    const opencode = makeSdkOpencode(client, options)

    await expect(
      opencode.runPrompt({ prompt: "hello", projectDir: "/repo", scope }).pipe(Stream.runCollect, Effect.runPromise)
    ).rejects.toMatchObject({ _tag: "OpencodeError", message: "stream blew up" })
  })

  test("maps abort failures on an active session", async () => {
    let releaseStream: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const client = {
      session: {
        create: () => Promise.resolve({ data: { id: "session-1" }, error: undefined }),
        promptAsync: () => Promise.resolve({ data: {}, error: undefined }),
        abort: () => Promise.resolve({ data: undefined, error: "abort failed" })
      },
      event: {
        subscribe: () =>
          Promise.resolve({
            stream: (async function* () {
              yield { type: "session.next.text.delta", properties: { sessionID: "session-1", delta: "ok" } }
              await waiting
            })()
          })
      },
      global: {
        health: () => Promise.resolve({ data: { ok: true }, error: undefined })
      }
    }

    const opencode = makeSdkOpencode(client, options)
    const running = Effect.runPromise(opencode.runPrompt({ prompt: "hello", projectDir: "/repo", scope }).pipe(Stream.runDrain))
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(opencode.abort(scope).pipe(Stream.runDrain, Effect.runPromise)).rejects.toMatchObject({
      _tag: "OpencodeError",
      message: "abort failed"
    })

    releaseStream?.()
    await running.catch(() => {})
  })
})
