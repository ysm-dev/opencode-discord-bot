import { describe, expect, test } from "bun:test"
import type { DiscordThreadId } from "@chat-adapter/discord"
import type { AdapterPostableMessage, FetchOptions, FetchResult, RawMessage } from "chat"
import { Message, parseMarkdown } from "chat"
import { Effect } from "effect"
import type { DiscordScope } from "../Schema.ts"
import { makeChatSdkDiscord } from "./ChatSdkDiscord.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1" }

const makeMessage = (threadId: string, raw: unknown): Message<unknown> =>
  new Message({
    id: "m1",
    threadId,
    text: "hello",
    formatted: parseMarkdown("hello"),
    raw,
    author: { userId: "u1", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    metadata: { dateSent: new Date("2026-06-05T14:03:00.000Z"), edited: false },
    attachments: []
  })

class ReactionAdapter {
  encodeThreadId(input: DiscordThreadId): string {
    return `discord:${input.guildId}:${input.channelId}`
  }

  fetchMessages(threadId: string, _options?: FetchOptions): Promise<FetchResult<unknown>> {
    return Promise.resolve({
      messages: [
        makeMessage(threadId, {
          reactions: [
            { count: 3, emoji: { id: null, name: "\u{1F680}" } },
            { count: 2, emoji: { id: "custom1", name: "party_blob", animated: false } },
            { count: 1, emoji: { id: "anim1", name: "dance", animated: true } },
            { count: "bad", emoji: { id: null, name: "ignored" } },
            { count: -1, emoji: { id: null, name: "ignored" } }
          ]
        })
      ]
    })
  }

  postMessage(threadId: string, _message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    return Promise.resolve({ id: "posted", raw: {}, threadId })
  }

  editMessage(threadId: string, messageId: string, _message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    return Promise.resolve({ id: messageId, raw: {}, threadId })
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    return Promise.resolve()
  }

  startTyping(_threadId: string, _status?: string): Promise<void> {
    return Promise.resolve()
  }

  addReaction(_threadId: string, _messageId: string, _emoji: string): Promise<void> {
    return Promise.resolve()
  }
}

describe("makeChatSdkDiscord reactions", () => {
  test("maps aggregate reactions from raw Discord messages", async () => {
    const discord = makeChatSdkDiscord(new ReactionAdapter())

    const context = await Effect.runPromise(discord.fetchContext(scope, 30))

    expect(context[0]?.reactions).toEqual([
      { emoji: "\u{1F680}", count: 3 },
      { emoji: "party_blob:custom1", count: 2 },
      { emoji: "a:dance:anim1", count: 1 }
    ])
  })
})
