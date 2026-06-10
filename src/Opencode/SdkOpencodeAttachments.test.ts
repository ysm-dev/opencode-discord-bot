import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { DiscordScope } from "../Schema.ts"
import { preparePromptParts } from "./PromptParts.ts"
import { makeSdkOpencode } from "./SdkOpencode.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1" }
const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pngSignatureBase64 = "iVBORw0KGgo="

describe("makeSdkOpencode attachments", () => {
  test("encodes image prompt parts as base64 data URLs before sending", async () => {
    const calls: Array<readonly [string, unknown]> = []
    const fetchRequests: Array<string> = []
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(
      (input: URL | RequestInfo) => {
        fetchRequests.push(String(input))
        return Promise.resolve(new Response(new Uint8Array([0, 1, 2, 255]), { status: 200 }))
      },
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = fakeFetch

    try {
      const client = {
        session: {
          create: () => Promise.resolve({ data: { id: "session-1" }, error: undefined }),
          promptAsync: (parameters: unknown) => {
            calls.push(["session.promptAsync", parameters])
            return Promise.resolve({ data: {}, error: undefined })
          },
          abort: () => Promise.resolve({ data: {}, error: undefined })
        },
        event: {
          subscribe: () =>
            Promise.resolve({
              stream: (async function* () {
                yield { type: "session.idle", properties: { sessionID: "session-1" } }
              })()
            })
        },
        global: {
          health: () => Promise.resolve({ data: { ok: true }, error: undefined })
        }
      }

      const opencode = makeSdkOpencode(client, { baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })
      await Effect.runPromise(
        opencode
          .runPrompt({
            prompt: "see image",
            parts: [
              { type: "file", mime: "image/png", filename: "screen.png", url: "https://cdn/screen.png" },
              { type: "file", mime: "application/pdf", filename: "doc.pdf", url: "https://cdn/doc.pdf" }
            ],
            projectDir: "/repo",
            scope
          })
          .pipe(Stream.runDrain)
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchRequests).toEqual(["https://cdn/screen.png"])
    expect(calls).toEqual([
      [
        "session.promptAsync",
        {
          sessionID: "session-1",
          directory: "/repo",
          parts: [
            { type: "text", text: "see image" },
            { type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,AAEC/w==" },
            { type: "file", mime: "application/pdf", filename: "doc.pdf", url: "https://cdn/doc.pdf" }
          ]
        }
      ]
    ])
  })

  test("uses detected image MIME when attachment metadata is stale", async () => {
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response(pngSignature, { status: 200, headers: { "content-type": "image/jpeg" } })),
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = fakeFetch

    try {
      const parts = await Effect.runPromise(
        preparePromptParts([{ type: "file", mime: "image/jpeg", filename: "screen.jpg", url: "https://cdn/screen.jpg" }])
      )

      expect(parts).toEqual([
        { type: "file", mime: "image/png", filename: "screen.jpg", url: `data:image/png;base64,${pngSignatureBase64}` }
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("normalizes pre-encoded image data URL MIME from bytes", async () => {
    const parts = await Effect.runPromise(
      preparePromptParts([
        { type: "file", mime: "image/jpeg", filename: "screen.jpg", url: `data:image/jpeg;base64,${pngSignatureBase64}` }
      ])
    )

    expect(parts).toEqual([{ type: "file", mime: "image/png", filename: "screen.jpg", url: `data:image/png;base64,${pngSignatureBase64}` }])
  })
})
