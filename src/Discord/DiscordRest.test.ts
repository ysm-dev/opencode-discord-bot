import { describe, expect, test } from "bun:test"
import { Duration } from "effect"
import { DiscordError } from "./DiscordPort.ts"
import { rawDiscordSearchRequest } from "./DiscordRest.ts"

describe("Discord REST helpers", () => {
  test("reports Discord search index-not-ready retry metadata", async () => {
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ retry_after: 0.25 }), { status: 202, headers: { "content-type": "application/json" } })
        ),
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = fakeFetch

    try {
      let error: unknown
      try {
        await rawDiscordSearchRequest({ botToken: "token", apiUrl: "https://discord.test/api" }, "/guilds/g1/messages/search")
      } catch (cause) {
        error = cause
      }

      if (!(error instanceof DiscordError)) throw new Error("expected DiscordError")
      expect(error.message).toBe("Discord search index is not ready yet; retry the search later")
      expect(error.retryAfter === undefined ? undefined : Duration.toMillis(error.retryAfter)).toBe(250)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("reports Discord search REST errors", async () => {
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(() => Promise.resolve(new Response("nope", { status: 500 })), {
      preconnect: originalFetch.preconnect
    })
    globalThis.fetch = fakeFetch

    try {
      await expect(
        rawDiscordSearchRequest({ botToken: "token", apiUrl: "https://discord.test/api" }, "/guilds/g1/messages/search")
      ).rejects.toMatchObject({
        _tag: "DiscordError",
        message: "Discord REST 500: nope"
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
