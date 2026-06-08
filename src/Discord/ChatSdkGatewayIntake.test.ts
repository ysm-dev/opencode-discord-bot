import { expect, test } from "bun:test"
import { Message, parseMarkdown } from "chat"
import { Effect } from "effect"
import type { DiscordMessage } from "../Schema.ts"
import { collectDiscordMessages, makeChatGatewayIntake, makeGatewayAdapter, makeTransientChatState } from "./ChatSdkGatewayIntake.ts"

const message = {
  id: "m1",
  guildId: "g1",
  channelId: "c1",
  author: { id: "u1", displayName: "Alice", isBot: false },
  content: "hello <@self>",
  timestamp: "2026-06-05T14:03:00.000Z",
  mentions: ["self"],
  roleMentions: [],
  everyoneMention: false,
  hereMention: false,
  attachments: [],
  reactions: [],
  channelType: "guild"
} satisfies DiscordMessage

test("processes gateway messages through chat-sdk intake and dedupes retries", async () => {
  const seen: Array<readonly [string, number]> = []
  const intake = makeChatGatewayIntake({
    bot: { userId: "self" },
    onMessage: (next, skipped) => Effect.sync(() => seen.push([next.id, skipped.length]))
  })

  await Effect.runPromise(intake.processMessage(message))
  await Effect.runPromise(intake.processMessage(message))

  expect(seen).toEqual([["m1", 0]])
})

test("maps Discord messages through the chat-sdk adapter facade", async () => {
  const adapter = makeGatewayAdapter({ userId: "self" })
  const withAttachment = {
    ...message,
    attachments: [{ id: "a1", filename: "screen.png", contentType: "image/png", size: 10, url: "https://cdn/screen.png" }]
  } satisfies DiscordMessage
  const parsed = adapter.parseMessage(withAttachment)

  expect(adapter.encodeThreadId({ guildId: "g1", channelId: "c1", threadId: "t1" })).toBe("discord:g1:c1:t1")
  expect(adapter.userName).toBe("self")
  expect(adapter.decodeThreadId("discord:g1:c1:t1")).toEqual({ guildId: "g1", channelId: "c1", threadId: "t1" })
  expect(adapter.channelIdFromThreadId("discord:g1:c1:t1")).toBe("c1")
  expect(parsed.threadId).toBe("discord:g1:c1")
  expect(parsed.attachments).toEqual([
    { type: "image", name: "screen.png", mimeType: "image/png", size: 10, url: "https://cdn/screen.png" }
  ])
  expect(adapter.renderFormatted(parsed.formatted)).toContain("hello")
  expect(await adapter.fetchMessages("discord:g1:c1")).toEqual({ messages: [] })
  expect(await adapter.fetchThread("discord:g1:c1:t1")).toEqual({ id: "discord:g1:c1:t1", channelId: "c1", isDM: false, metadata: {} })
  expect(adapter.isDM?.("discord:g1:c1")).toBe(false)
  expect(await adapter.handleWebhook(new Request("http://localhost"))).toHaveProperty("status", 404)
})

test("rejects output operations on the gateway intake adapter facade", async () => {
  const adapter = makeGatewayAdapter({ userId: "self" })

  await expect(adapter.postMessage("discord:g1:c1", "hello")).rejects.toThrow("cannot post messages")
  if (adapter.postChannelMessage === undefined) throw new Error("missing postChannelMessage")
  await expect(adapter.postChannelMessage("discord:g1:c1", "hello")).rejects.toThrow("cannot post channel messages")
  await expect(adapter.editMessage("discord:g1:c1", "m1", "hello")).rejects.toThrow("cannot edit messages")
  await expect(adapter.deleteMessage("discord:g1:c1", "m1")).rejects.toThrow("cannot delete messages")
  await expect(adapter.addReaction("discord:g1:c1", "m1", "rocket")).rejects.toThrow("cannot add reactions")
  await expect(adapter.removeReaction("discord:g1:c1", "m1", "rocket")).rejects.toThrow("cannot remove reactions")
  await expect(adapter.startTyping("discord:g1:c1")).rejects.toThrow("cannot start typing")
})

test("provides transient in-memory chat-sdk state", async () => {
  const state = makeTransientChatState()
  const adapter = makeGatewayAdapter({ userId: "self" })
  const parsed = adapter.parseMessage(message)

  await state.connect()
  expect(await state.setIfNotExists("dedupe", true, 1000)).toBe(true)
  expect(await state.setIfNotExists("dedupe", true, 1000)).toBe(false)
  await state.set("expired", true, -1)
  expect(await state.setIfNotExists("expired", true, 1000)).toBe(true)
  await state.delete("dedupe")
  await state.appendToList("list", "a", { maxLength: 1 })
  expect(await state.getList("list")).toEqual([])

  const lock = await state.acquireLock("thread", 1000)
  if (lock === null) throw new Error("expected lock")
  expect(await state.acquireLock("thread", 1000)).toBeNull()
  expect(await state.extendLock(lock, 1000)).toBe(true)
  await state.releaseLock(lock)
  expect(await state.extendLock(lock, 1000)).toBe(false)
  await state.forceReleaseLock("thread")

  expect(await state.enqueue("thread", { message: parsed, enqueuedAt: 0, expiresAt: Date.now() - 1 }, 10)).toBe(1)
  expect(await state.enqueue("thread", { message: parsed, enqueuedAt: 0, expiresAt: Date.now() + 1000 }, 1)).toBe(1)
  expect(await state.queueDepth("thread")).toBe(1)
  expect(await state.dequeue("thread")).toMatchObject({ message: parsed })
  expect(await state.dequeue("thread")).toBeNull()

  await state.subscribe("thread")
  expect(await state.isSubscribed("thread")).toBe(true)
  await state.unsubscribe("thread")
  expect(await state.isSubscribed("thread")).toBe(false)
  await state.disconnect()
})

test("filters non-Discord raw messages from skipped chat context", () => {
  const adapter = makeGatewayAdapter({ userId: "self" })
  const valid = adapter.parseMessage(message)
  const invalid = new Message({
    id: "invalid",
    threadId: "discord:g1:c1",
    text: "invalid",
    formatted: parseMarkdown("invalid"),
    raw: {},
    author: { userId: "u1", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    metadata: { dateSent: new Date("2026-06-05T14:03:00.000Z"), edited: false },
    attachments: []
  })

  expect(collectDiscordMessages([invalid, valid])).toEqual([message])
})
