import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DiscordThreadId } from "@chat-adapter/discord"
import type { AdapterPostableMessage, ChannelInfo, FetchResult, RawMessage } from "chat"
import { Message, parseMarkdown } from "chat"
import { Duration, Effect } from "effect"
import type { DiscordScope } from "../Schema.ts"
import { makeChatSdkDiscord } from "./ChatSdkDiscord.ts"
import { DiscordError } from "./DiscordPort.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1", threadId: "t1" }

class FakeDiscordAdapter {
  readonly calls: Array<readonly [string, unknown]> = []

  encodeThreadId(input: DiscordThreadId): string {
    this.calls.push(["encodeThreadId", input])
    return input.threadId === undefined
      ? `discord:${input.guildId}:${input.channelId}`
      : `discord:${input.guildId}:${input.channelId}:${input.threadId}`
  }

  postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    this.calls.push(["postMessage", { threadId, message }])
    return Promise.resolve({ id: "posted-1", threadId, raw: {} })
  }

  editMessage(threadId: string, messageId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    this.calls.push(["editMessage", { threadId, messageId, message }])
    return Promise.resolve({ id: messageId, threadId, raw: {} })
  }

  deleteMessage(threadId: string, messageId: string): Promise<void> {
    this.calls.push(["deleteMessage", { threadId, messageId }])
    return Promise.resolve()
  }

  postChannelMessage(channelId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    this.calls.push(["postChannelMessage", { channelId, message }])
    return Promise.resolve({ id: "posted-channel-1", threadId: channelId, raw: {} })
  }

  fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    this.calls.push(["fetchChannelInfo", { channelId }])
    return Promise.resolve({ id: channelId, isDM: false, metadata: { raw: { guild_id: "g1" } } })
  }

  startTyping(threadId: string): Promise<void> {
    this.calls.push(["startTyping", { threadId }])
    return Promise.resolve()
  }

  addReaction(threadId: string, messageId: string, emoji: string): Promise<void> {
    this.calls.push(["addReaction", { threadId, messageId, emoji }])
    return Promise.resolve()
  }

  removeReaction(threadId: string, messageId: string, emoji: string): Promise<void> {
    this.calls.push(["removeReaction", { threadId, messageId, emoji }])
    return Promise.resolve()
  }

  fetchMessages(threadId: string): Promise<FetchResult<unknown>> {
    this.calls.push(["fetchMessages", { threadId }])
    return Promise.resolve({
      messages: [
        new Message({
          id: "m1",
          threadId,
          text: "hello <@999>",
          formatted: parseMarkdown("hello <@999>"),
          raw: {},
          author: { userId: "u1", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
          metadata: { dateSent: new Date("2026-06-05T14:03:00.000Z"), edited: false },
          attachments: [{ type: "file", name: "notes.txt", mimeType: "text/plain", size: 42, url: "https://example.test/notes.txt" }]
        })
      ]
    })
  }
}

describe("makeChatSdkDiscord", () => {
  test("routes Discord port operations through chat-sdk adapter primitives", async () => {
    const adapter = new FakeDiscordAdapter()
    const discord = makeChatSdkDiscord(adapter)

    const context = await Effect.runPromise(discord.fetchContext(scope, 30))
    const history = await Effect.runPromise(discord.fetchHistory(scope, 2))
    const posted = await Effect.runPromise(discord.postMessage(scope, "reply"))
    await Effect.runPromise(discord.editMessage(scope, posted.id, "edited"))
    await Effect.runPromise(discord.sendTyping(scope))
    await Effect.runPromise(discord.addReaction(scope, "m1", "rocket"))
    await Effect.runPromise(discord.removeReaction(scope, "m1", "rocket"))
    const directory = await mkdtemp(join(tmpdir(), "ocdb-chat-"))

    try {
      const path = join(directory, "upload.txt")
      await writeFile(path, "uploaded")
      expect(await Effect.runPromise(discord.attachFile(scope, path))).toEqual({ path: "posted-1" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    expect(context).toEqual([
      {
        id: "m1",
        guildId: "g1",
        channelId: "c1",
        threadId: "t1",
        author: { id: "u1", displayName: "Alice", nickname: "alice", isBot: false },
        content: "hello <@999>",
        timestamp: "2026-06-05T14:03:00.000Z",
        mentions: ["999"],
        roleMentions: [],
        everyoneMention: false,
        hereMention: false,
        attachments: [{ id: "m1-0", filename: "notes.txt", contentType: "text/plain", size: 42, url: "https://example.test/notes.txt" }],
        reactions: [],
        channelType: "guild"
      }
    ])
    expect(history).toEqual(context)
    expect(adapter.calls.map((item) => item[0])).toEqual([
      "encodeThreadId",
      "fetchMessages",
      "encodeThreadId",
      "fetchMessages",
      "encodeThreadId",
      "postMessage",
      "encodeThreadId",
      "editMessage",
      "encodeThreadId",
      "startTyping",
      "encodeThreadId",
      "addReaction",
      "encodeThreadId",
      "removeReaction",
      "encodeThreadId",
      "postMessage"
    ])
  })

  test("normalizes Discord user mention wrappers before chat-sdk output conversion", async () => {
    const adapter = new FakeDiscordAdapter()
    const discord = makeChatSdkDiscord(adapter)

    const posted = await Effect.runPromise(discord.postMessage(scope, "hello <@999> and <@!888>"))
    await Effect.runPromise(discord.editMessage(scope, posted.id, "edited <@777>"))
    await Effect.runPromise(discord.postChannelMessage("g1", "c2", "channel <@666>"))

    expect(adapter.calls).toEqual([
      ["encodeThreadId", { guildId: "g1", channelId: "c1", threadId: "t1" }],
      ["postMessage", { threadId: "discord:g1:c1:t1", message: "hello @999 and @888" }],
      ["encodeThreadId", { guildId: "g1", channelId: "c1", threadId: "t1" }],
      ["editMessage", { threadId: "discord:g1:c1:t1", messageId: "posted-1", message: "edited @777" }],
      ["encodeThreadId", { guildId: "g1", channelId: "c2" }],
      ["fetchChannelInfo", { channelId: "discord:g1:c2" }],
      ["postChannelMessage", { channelId: "discord:g1:c2", message: "channel @666" }]
    ])
  })
})

describe("makeChatSdkDiscord REST operations", () => {
  test("routes channel posts, deletes, and raw REST adapter gaps", async () => {
    const adapter = new FakeDiscordAdapter()
    const requests: Array<readonly [string, RequestInit]> = []
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(
      (input: URL | RequestInfo, init?: BunFetchRequestInit | RequestInit) => {
        requests.push([String(input), init ?? {}])
        return Promise.resolve(
          new Response(input.toString().includes("/threads") ? JSON.stringify({ id: "thread-1" }) : undefined, {
            status: input.toString().includes("/threads") ? 200 : 204,
            headers: { "content-type": "application/json" }
          })
        )
      },
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = fakeFetch

    try {
      const discord = makeChatSdkDiscord(adapter, { botToken: "token", apiUrl: "https://discord.test/api" })

      await Effect.runPromise(discord.deleteMessage(scope, "m1"))
      expect(await Effect.runPromise(discord.postChannelMessage("g1", "c2", "hello"))).toEqual({ id: "posted-channel-1" })
      expect(await Effect.runPromise(discord.createThread(scope, "work"))).toEqual({ id: "thread-1" })
      await Effect.runPromise(discord.pinMessage(scope, "m1"))
      await Effect.runPromise(discord.unpinMessage(scope, "m1"))
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(adapter.calls.map((item) => item[0])).toEqual([
      "encodeThreadId",
      "deleteMessage",
      "encodeThreadId",
      "fetchChannelInfo",
      "postChannelMessage"
    ])
    expect(requests.map((request) => [request[0], request[1].method])).toEqual([
      ["https://discord.test/api/channels/c1/threads", "POST"],
      ["https://discord.test/api/channels/t1/pins/m1", "PUT"],
      ["https://discord.test/api/channels/t1/pins/m1", "DELETE"]
    ])
  })

  test("fails raw REST operations when no raw Discord client is configured", async () => {
    const discord = makeChatSdkDiscord(new FakeDiscordAdapter())

    await expect(Effect.runPromise(discord.createThread(scope, "work"))).rejects.toMatchObject({
      _tag: "DiscordError",
      message: "Discord adapter does not expose this operation"
    })
  })

  test("preserves chat-sdk adapter retry metadata", async () => {
    const adapter = new FakeDiscordAdapter()
    adapter.postMessage = () => Promise.reject(Object.assign(new Error("limited"), { retryAfterMs: 123 }))
    const discord = makeChatSdkDiscord(adapter)
    let error: unknown

    try {
      await Effect.runPromise(discord.postMessage(scope, "hello"))
    } catch (cause) {
      error = cause
    }

    if (!(error instanceof DiscordError)) throw new Error("expected DiscordError")
    if (error.retryAfter === undefined) throw new Error("expected retryAfter")
    expect(error.message).toBe("limited")
    expect(Duration.toMillis(error.retryAfter)).toBe(123)
  })

  test("rejects DM channel info before cross-channel posting", async () => {
    const adapter = new FakeDiscordAdapter()
    adapter.fetchChannelInfo = (channelId: string) => {
      adapter.calls.push(["fetchChannelInfo", { channelId }])
      return Promise.resolve({ id: channelId, isDM: true, metadata: {} })
    }
    const discord = makeChatSdkDiscord(adapter)

    await expect(Effect.runPromise(discord.postChannelMessage("g1", "dm1", "hello"))).rejects.toMatchObject({
      _tag: "DiscordError",
      message: "Discord DMs are not supported"
    })
    expect(adapter.calls.map((item) => item[0])).toEqual(["encodeThreadId", "fetchChannelInfo"])
  })

  test("preserves raw Discord REST retry-after metadata", async () => {
    const originalFetch = globalThis.fetch
    const fakeFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response("limited", { status: 429, headers: { "retry-after": "2" } })),
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = fakeFetch

    try {
      const discord = makeChatSdkDiscord(new FakeDiscordAdapter(), { botToken: "token", apiUrl: "https://discord.test/api" })
      let error: unknown

      try {
        await Effect.runPromise(discord.createThread(scope, "work"))
      } catch (cause) {
        error = cause
      }

      if (!(error instanceof DiscordError)) throw new Error("expected DiscordError")
      if (error.retryAfter === undefined) throw new Error("expected retryAfter")
      expect(error.message).toBe("Discord REST 429: limited")
      expect(Duration.toMillis(error.retryAfter)).toBe(2000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
