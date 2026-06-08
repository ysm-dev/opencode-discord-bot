import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { DiscordScope } from "../Schema.ts"
import { makeLiveSdkOpencode, makeSdkOpencode } from "./SdkOpencode.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1" }

describe("makeSdkOpencode", () => {
  test("creates a session, sends a prompt, filters SSE events, and cleans up after idle", async () => {
    const calls: Array<readonly [string, unknown]> = []
    const client = {
      session: {
        create: (parameters: unknown) => {
          calls.push(["session.create", parameters])
          return Promise.resolve({ data: { id: "session-1" }, error: undefined })
        },
        promptAsync: (parameters: unknown) => {
          calls.push(["session.promptAsync", parameters])
          return Promise.resolve({ data: {}, error: undefined })
        },
        abort: (parameters: unknown) => {
          calls.push(["session.abort", parameters])
          return Promise.resolve({ data: {}, error: undefined })
        }
      },
      event: {
        subscribe: (parameters: unknown) => {
          calls.push(["event.subscribe", parameters])
          return Promise.resolve({
            stream: (async function* () {
              calls.push(["stream.start", {}])
              yield { type: "session.next.text.delta", properties: { sessionID: "other-session", delta: "ignore" } }
              yield {
                directory: "/repo",
                payload: { type: "session.next.text.delta", properties: { sessionID: "other-session", delta: "ignore-wrapped" } }
              }
              yield {
                type: "message.part.delta",
                properties: { part: { type: "text", sessionID: "other-session" }, delta: "ignore-nested" }
              }
              yield { type: "session.next.text.delta", properties: { sessionID: "session-1", delta: "ok" } }
              yield {
                directory: "/repo",
                payload: { type: "session.next.text.delta", properties: { sessionID: "session-1", delta: "wrapped" } }
              }
              yield {
                type: "message.updated",
                properties: { sessionID: "session-1", info: { id: "assistant-message", role: "assistant" } }
              }
              yield {
                type: "message.part.delta",
                properties: { messageID: "assistant-message", part: { type: "text", sessionID: "session-1" }, delta: "nested" }
              }
              yield { type: "session.idle", properties: { sessionID: "session-1" } }
              yield { type: "session.next.text.delta", properties: { sessionID: "session-1", delta: "after-idle" } }
            })()
          })
        }
      },
      global: {
        health: () => {
          calls.push(["global.health", {}])
          return Promise.resolve({ data: { ok: true }, error: undefined })
        }
      }
    }

    const opencode = makeSdkOpencode(client, { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })
    const events = await Effect.runPromise(
      opencode
        .runPrompt({
          prompt: "hello",
          parts: [{ type: "file", mime: "text/plain", filename: "notes.txt", url: "https://cdn/notes.txt" }],
          projectDir: "/repo",
          scope,
          agent: "build",
          model: "anthropic/claude"
        })
        .pipe(Stream.runCollect)
    )
    await Effect.runPromise(opencode.abort(scope).pipe(Stream.runCollect))
    await Effect.runPromise(opencode.checkHealth)

    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "text-delta", text: "wrapped" },
      { type: "text-delta", text: "nested" },
      { type: "idle" }
    ])
    expect(calls).toEqual([
      ["event.subscribe", { directory: "/repo" }],
      ["stream.start", {}],
      ["session.create", { directory: "/repo", agent: "build", model: { id: "claude", providerID: "anthropic" } }],
      [
        "session.promptAsync",
        {
          sessionID: "session-1",
          directory: "/repo",
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
          parts: [
            { type: "text", text: "hello" },
            { type: "file", mime: "text/plain", filename: "notes.txt", url: "https://cdn/notes.txt" }
          ]
        }
      ],
      ["global.health", {}]
    ])
  })

  test("aborts an active session before the event stream finishes", async () => {
    const calls: Array<readonly [string, unknown]> = []
    let releaseStream: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const client = {
      session: {
        create: (parameters: unknown) => {
          calls.push(["session.create", parameters])
          return Promise.resolve({ data: { id: "session-1" }, error: undefined })
        },
        promptAsync: (parameters: unknown) => {
          calls.push(["session.promptAsync", parameters])
          return Promise.resolve({ data: {}, error: undefined })
        },
        abort: (parameters: unknown) => {
          calls.push(["session.abort", parameters])
          return Promise.resolve({ data: {}, error: undefined })
        }
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

    const opencode = makeSdkOpencode(client, { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })
    const running = Effect.runPromise(opencode.runPrompt({ prompt: "hello", projectDir: "/repo", scope }).pipe(Stream.runDrain))
    await new Promise((resolve) => setTimeout(resolve, 0))

    await Effect.runPromise(opencode.abort(scope).pipe(Stream.runDrain))
    releaseStream?.()
    await running

    expect(calls).toContainEqual(["session.abort", { sessionID: "session-1", directory: "/repo" }])
  })
})

describe("makeSdkOpencode errors", () => {
  test("maps thrown SDK errors to opencode errors", async () => {
    const client = {
      session: {
        create: () => Promise.resolve({ data: { id: "session-1" }, error: undefined }),
        promptAsync: () => Promise.resolve({ data: {}, error: undefined }),
        abort: () => Promise.resolve({ data: {}, error: undefined })
      },
      event: {
        subscribe: () => Promise.reject(new Error("subscribe failed"))
      },
      global: {
        health: () => Promise.resolve({ data: { ok: true }, error: undefined })
      }
    }

    const opencode = makeSdkOpencode(client, { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })

    await expect(
      opencode.runPrompt({ prompt: "hello", projectDir: "/repo", scope }).pipe(Stream.runCollect, Effect.runPromise)
    ).rejects.toMatchObject({
      _tag: "OpencodeError",
      message: "subscribe failed"
    })
  })

  test("maps SDK result errors and constructs the live client wrapper", async () => {
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
        health: () => Promise.resolve({ data: undefined, error: "health failed" })
      }
    }

    const opencode = makeSdkOpencode(client, { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })

    await expect(Effect.runPromise(opencode.checkHealth)).rejects.toMatchObject({ _tag: "OpencodeError", message: "health failed" })
    expect(makeLiveSdkOpencode({ baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })).toBeDefined()
  })

  test("extracts structured SDK result error messages", async () => {
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
        health: () =>
          Promise.resolve({
            data: undefined,
            error: { name: "BadRequest", data: { message: "invalid project directory", kind: "Query" } }
          })
      }
    }

    const opencode = makeSdkOpencode(client, { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })

    await expect(Effect.runPromise(opencode.checkHealth)).rejects.toMatchObject({
      _tag: "OpencodeError",
      message: "BadRequest: invalid project directory"
    })
  })

  test("uses HTTP response details when SDK errors have no message", async () => {
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
        health: () =>
          Promise.resolve({
            data: undefined,
            error: {},
            request: new Request("http://127.0.0.1:4096/global/health?directory=%2Fsecret"),
            response: new Response("", { status: 500, statusText: "Internal Server Error" })
          })
      }
    }

    const opencode = makeSdkOpencode(client, { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })

    await expect(Effect.runPromise(opencode.checkHealth)).rejects.toMatchObject({
      _tag: "OpencodeError",
      message: "GET /global/health returned 500 Internal Server Error"
    })
  })

  test("maps rejected SDK requests", async () => {
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
        health: () => Promise.reject(new Error("health rejected"))
      }
    }

    const opencode = makeSdkOpencode(client, { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })

    await expect(Effect.runPromise(opencode.checkHealth)).rejects.toMatchObject({ _tag: "OpencodeError", message: "health rejected" })
  })
})
