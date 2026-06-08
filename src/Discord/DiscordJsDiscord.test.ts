import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { DiscordScope } from "../Schema.ts"
import { type DiscordJsChannelLike, fromDiscordJsMessage, makeDiscordJsDiscord } from "./DiscordJsDiscord.ts"

const collection = <A>(items: ReadonlyArray<A>) => ({ values: () => items[Symbol.iterator]() })
const scope: DiscordScope = { guildId: "g1", channelId: "c1" }

const baseMessage = (
  overrides: { readonly guildId?: string | null; readonly channelId?: string; readonly channel?: DiscordJsChannelLike } = {}
) => ({
  id: "m1",
  guildId: overrides.guildId ?? "g1",
  channelId: overrides.channelId ?? "c1",
  channel: overrides.channel ?? { id: "c1", isDMBased: () => false, isThread: () => false },
  author: { id: "u1", username: "alice", globalName: null, displayName: "Alice", bot: false },
  member: { nickname: null },
  content: "hello @here",
  createdAt: new Date("2026-06-05T14:03:00.000Z"),
  mentions: { users: collection([{ id: "u2" }]), roles: collection([{ id: "r1" }]), everyone: true },
  attachments: collection([{ id: "a1", name: "a.txt", contentType: null, size: 4, url: "https://example.test/a.txt" }]),
  reactions: { cache: collection([{ emoji: { name: null }, count: 1 }]) },
  system: false,
  inGuild: () => overrides.guildId !== null
})

describe("fromDiscordJsMessage", () => {
  test("maps guild and thread messages and ignores non-guild messages", () => {
    expect(fromDiscordJsMessage(baseMessage())).toEqual({
      id: "m1",
      guildId: "g1",
      channelId: "c1",
      author: { id: "u1", displayName: "Alice", isBot: false },
      content: "hello @here",
      timestamp: "2026-06-05T14:03:00.000Z",
      mentions: ["u2"],
      roleMentions: ["r1"],
      everyoneMention: true,
      hereMention: true,
      attachments: [{ id: "a1", filename: "a.txt", size: 4, url: "https://example.test/a.txt" }],
      reactions: [{ emoji: "unknown", count: 1 }],
      channelType: "guild",
      isSystem: false
    })
    expect(
      fromDiscordJsMessage(baseMessage({ channelId: "t1", channel: { id: "t1", parentId: "c1", isThread: () => true } }))
    ).toMatchObject({
      channelId: "c1",
      threadId: "t1"
    })
    expect(fromDiscordJsMessage(baseMessage({ guildId: null, channel: { id: "dm1", isDMBased: () => true } }))).toBeUndefined()
  })
})

describe("makeDiscordJsDiscord", () => {
  test("routes port operations through a discord.js-like client", async () => {
    const calls: Array<readonly [string, unknown]> = []
    const fetchedMessage = {
      ...baseMessage(),
      edit: (content: string) => {
        calls.push(["edit", content])
        return Promise.resolve({})
      },
      delete: () => {
        calls.push(["delete", {}])
        return Promise.resolve({})
      },
      pin: () => {
        calls.push(["pin", {}])
        return Promise.resolve({})
      },
      unpin: () => {
        calls.push(["unpin", {}])
        return Promise.resolve({})
      },
      react: (emoji: string) => {
        calls.push(["react", emoji])
        return Promise.resolve({})
      },
      reactions: {
        cache: collection([{ emoji: { name: "rocket" }, count: 2 }]),
        resolve: (emoji: string) => ({
          users: { remove: (userId: string) => Promise.resolve(calls.push(["removeReaction", { emoji, userId }])) }
        })
      }
    }
    const channel = {
      send: (content: unknown) => {
        calls.push(["send", content])
        return Promise.resolve({ id: "posted-1" })
      },
      sendTyping: () => {
        calls.push(["typing", {}])
        return Promise.resolve()
      },
      messages: {
        fetch: (query: string | { readonly limit: number }) => {
          calls.push(["fetchMessages", query])
          return Promise.resolve(typeof query === "string" ? fetchedMessage : collection([baseMessage()]))
        }
      },
      threads: {
        create: (options: { readonly name: string }) => {
          calls.push(["createThread", options])
          return Promise.resolve({ id: "thread-1" })
        }
      }
    }
    const client = {
      user: { id: "bot-1" },
      channels: {
        fetch: (id: string) => {
          calls.push(["fetchChannel", id])
          return Promise.resolve(channel)
        }
      }
    }
    const discord = makeDiscordJsDiscord(client)
    const directory = await mkdtemp(join(tmpdir(), "ocdb-discordjs-"))

    try {
      const file = join(directory, "upload.txt")
      await writeFile(file, "upload")
      const context = await Effect.runPromise(discord.fetchContext(scope, 1))
      const history = await Effect.runPromise(discord.fetchHistory(scope, 1))
      await Effect.runPromise(discord.sendTyping(scope))
      const posted = await Effect.runPromise(discord.postMessage(scope, "hello"))
      await Effect.runPromise(discord.editMessage(scope, "m1", "edited"))
      await Effect.runPromise(discord.deleteMessage(scope, "m1"))
      await Effect.runPromise(discord.addReaction(scope, "m1", "rocket"))
      await Effect.runPromise(discord.removeReaction(scope, "m1", "rocket"))
      const attached = await Effect.runPromise(discord.attachFile(scope, file))
      expect(await Effect.runPromise(discord.createThread(scope, "work"))).toEqual({ id: "thread-1" })
      expect(await Effect.runPromise(discord.postChannelMessage("g1", "c2", "hello"))).toEqual({ id: "posted-1" })
      await Effect.runPromise(discord.pinMessage(scope, "m1"))
      await Effect.runPromise(discord.unpinMessage(scope, "m1"))

      expect(context).toHaveLength(1)
      expect(history).toHaveLength(1)
      expect(posted).toEqual({ id: "posted-1" })
      expect(attached).toEqual({ path: "posted-1" })
      expect(calls.map((call) => call[0])).toContain("removeReaction")
      expect(calls.map((call) => call[0])).toContain("delete")
      expect(calls.map((call) => call[0])).toContain("createThread")
      expect(calls.map((call) => call[0])).toContain("pin")
      expect(calls.map((call) => call[0])).toContain("unpin")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("fails when a fetched channel is not text-capable", async () => {
    const discord = makeDiscordJsDiscord({ user: { id: "bot-1" }, channels: { fetch: () => Promise.resolve({}) } })

    await expect(Effect.runPromise(discord.postMessage(scope, "hello"))).rejects.toMatchObject({
      _tag: "DiscordError",
      message: "Discord channel is not text-capable"
    })
  })

  test("rejects DM-based output targets", async () => {
    const channel = {
      isDMBased: () => true,
      send: () => Promise.resolve({ id: "posted-1" }),
      messages: { fetch: () => Promise.resolve(collection([])) }
    }
    const discord = makeDiscordJsDiscord({ user: { id: "bot-1" }, channels: { fetch: () => Promise.resolve(channel) } })

    await expect(Effect.runPromise(discord.postMessage(scope, "hello"))).rejects.toMatchObject({
      _tag: "DiscordError",
      message: "Discord DMs are not supported"
    })
  })

  test("fails high-risk operations on unsupported channels and messages", async () => {
    const fetchedMessage = {
      ...baseMessage(),
      edit: () => Promise.resolve({}),
      react: () => Promise.resolve({}),
      reactions: { resolve: () => null }
    }
    const channel = {
      send: () => Promise.resolve({ id: "posted-1" }),
      messages: { fetch: () => Promise.resolve(fetchedMessage) }
    }
    const discord = makeDiscordJsDiscord({ user: { id: "bot-1" }, channels: { fetch: () => Promise.resolve(channel) } })

    await expect(Effect.runPromise(discord.createThread(scope, "work"))).rejects.toMatchObject({
      _tag: "DiscordError",
      message: "Discord channel cannot create threads"
    })
    await expect(Effect.runPromise(discord.pinMessage(scope, "m1"))).rejects.toMatchObject({
      _tag: "DiscordError",
      message: "Discord message is not pinnable"
    })
    await expect(Effect.runPromise(discord.unpinMessage(scope, "m1"))).rejects.toMatchObject({
      _tag: "DiscordError",
      message: "Discord message is not unpinnable"
    })
    await expect(Effect.runPromise(discord.deleteMessage(scope, "m1"))).rejects.toMatchObject({
      _tag: "DiscordError",
      message: "Discord message is not deletable"
    })
  })
})
