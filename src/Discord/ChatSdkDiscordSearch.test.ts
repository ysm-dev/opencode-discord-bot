import { describe, expect, test } from "bun:test"
import type { DiscordThreadId } from "@chat-adapter/discord"
import type { AdapterPostableMessage, FetchResult, RawMessage } from "chat"
import { Effect } from "effect"
import type { DiscordScope } from "../Schema.ts"
import { makeChatSdkDiscord } from "./ChatSdkDiscord.ts"
import { parseDiscordSearchQuery } from "./SearchQuery.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1", threadId: "t1" }

class FakeDiscordAdapter {
  encodeThreadId(input: DiscordThreadId): string {
    return input.threadId === undefined
      ? `discord:${input.guildId}:${input.channelId}`
      : `discord:${input.guildId}:${input.channelId}:${input.threadId}`
  }

  postMessage(threadId: string, _message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    return Promise.resolve({ id: "posted-1", threadId, raw: {} })
  }

  editMessage(threadId: string, messageId: string, _message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    return Promise.resolve({ id: messageId, threadId, raw: {} })
  }

  deleteMessage(): Promise<void> {
    return Promise.resolve()
  }

  startTyping(): Promise<void> {
    return Promise.resolve()
  }

  addReaction(): Promise<void> {
    return Promise.resolve()
  }

  fetchMessages(): Promise<FetchResult<unknown>> {
    return Promise.resolve({ messages: [] })
  }
}

describe("makeChatSdkDiscord search", () => {
  test("searches guild messages through Discord REST search", async () => {
    const requests: Array<string> = []
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(
      (input: URL | RequestInfo) => {
        const url = String(input)
        requests.push(url)
        return Promise.resolve(url.includes("/messages/search") ? searchResponse() : memberResponse())
      },
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = fakeFetch

    try {
      const parsed = parseDiscordSearchQuery("hello from:<@123> in:<#789> has:link before:2026-06-06")
      if (!parsed.ok) throw new Error(parsed.error)
      const discord = makeChatSdkDiscord(new FakeDiscordAdapter(), { botToken: "token", apiUrl: "https://discord.test/api" })
      const result = await Effect.runPromise(discord.searchMessages(scope, parsed.query, { limit: 25, offset: 0 }))

      expect(result.totalResults).toBe(3)
      expect(result.hasMore).toBe(true)
      expect(result.messages).toEqual([
        {
          id: "m-search",
          guildId: "g1",
          channelId: "c1",
          threadId: "789",
          author: { id: "123", displayName: "Alice", nickname: "Ali the Great", isBot: false },
          content: "hello link https://example.test",
          timestamp: "2026-06-05T14:03:00.000Z",
          mentions: ["456"],
          roleMentions: ["111"],
          everyoneMention: false,
          hereMention: false,
          attachments: [{ id: "a1", filename: "notes.txt", contentType: "text/plain", size: 42, url: "https://example.test/notes.txt" }],
          reactions: [],
          channelType: "guild"
        }
      ])
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests[0]).toContain("/guilds/g1/messages/search?")
    expect(requests[0]).toContain("content=hello")
    expect(requests[0]).toContain("author_id=123")
    expect(requests[0]).toContain("channel_id=789")
    expect(requests[0]).toContain("has=link")
    expect(requests[1]).toBe("https://discord.test/api/guilds/g1/members/123")
  })

  test("resolves Discord search user and channel names", async () => {
    const requests: Array<string> = []
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(
      (input: URL | RequestInfo) => {
        const url = String(input)
        requests.push(url)
        if (url.includes("/members/search")) return Promise.resolve(memberSearchResponse(url))
        if (url.endsWith("/guilds/g1/channels")) return Promise.resolve(channelsResponse())
        return Promise.resolve(url.includes("/messages/search") ? searchResponse() : memberResponse())
      },
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = fakeFetch

    try {
      const parsed = parseDiscordSearchQuery("from:Alice in:general mentions:Bob reply_to:Carol")
      if (!parsed.ok) throw new Error(parsed.error)
      const discord = makeChatSdkDiscord(new FakeDiscordAdapter(), { botToken: "token", apiUrl: "https://discord.test/api" })
      const result = await Effect.runPromise(discord.searchMessages(scope, parsed.query, { limit: 25, offset: 0 }))

      expect(result.messages).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }

    const searchUrl = requests.find((url) => url.includes("/messages/search")) ?? ""
    expect(searchUrl).toContain("author_id=123")
    expect(searchUrl).toContain("channel_id=789")
    expect(searchUrl).toContain("mentions=456")
    expect(searchUrl).toContain("replied_to_user_id=777")
  })

  test("fails when search names cannot be resolved", async () => {
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })),
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = fakeFetch

    try {
      const parsed = parseDiscordSearchQuery("from:Missing")
      if (!parsed.ok) throw new Error(parsed.error)
      const discord = makeChatSdkDiscord(new FakeDiscordAdapter(), { botToken: "token", apiUrl: "https://discord.test/api" })

      await expect(Effect.runPromise(discord.searchMessages(scope, parsed.query, { limit: 25, offset: 0 }))).rejects.toMatchObject({
        _tag: "DiscordError",
        message: "Unable to resolve Discord user Missing; use an ID or mention"
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

const memberResponse = (): Response =>
  new Response(JSON.stringify({ nick: "Ali the Great" }), { status: 200, headers: { "content-type": "application/json" } })

const memberSearchResponse = (url: string): Response => {
  const query = new URL(url).searchParams.get("query")
  const id = query === "Carol" ? "777" : query === "Bob" ? "456" : "123"
  return new Response(JSON.stringify([{ user: { id } }]), { status: 200, headers: { "content-type": "application/json" } })
}

const channelsResponse = (): Response =>
  new Response(JSON.stringify([{ id: "789", name: "general" }]), { status: 200, headers: { "content-type": "application/json" } })

const searchResponse = (): Response =>
  new Response(
    JSON.stringify({
      total_results: 3,
      messages: [
        [
          {
            id: "m-search",
            channel_id: "789",
            author: { id: "123", username: "alice", global_name: "Alice", bot: false },
            content: "hello link https://example.test",
            timestamp: "2026-06-05T14:03:00.000Z",
            mentions: [{ id: "456" }],
            mention_roles: ["111"],
            mention_everyone: false,
            attachments: [{ id: "a1", filename: "notes.txt", content_type: "text/plain", size: 42, url: "https://example.test/notes.txt" }],
            type: 0
          }
        ]
      ],
      threads: [{ id: "789", parent_id: "c1" }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
