import { describe, expect, test } from "bun:test"
import type { BotIdentity, DiscordMessage } from "../Schema.ts"
import { isThreadActiveFromContext, shouldTriggerTurn, toDiscordScope } from "./Triggering.ts"

const bot: BotIdentity = { userId: "999" }

const message = (overrides: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id: "m1",
  guildId: "g1",
  channelId: "c1",
  author: { id: "123", displayName: "Alice", isBot: false },
  content: "hello <@999>",
  timestamp: "2026-06-05T14:03:00.000Z",
  mentions: ["999"],
  roleMentions: [],
  everyoneMention: false,
  hereMention: false,
  attachments: [],
  reactions: [],
  channelType: "guild",
  ...overrides
})

describe("shouldTriggerTurn", () => {
  test("direct guild mention triggers in the same channel scope", () => {
    const input = message()

    expect(shouldTriggerTurn(input, bot, false)).toBe(true)
    expect(toDiscordScope(input)).toEqual({ guildId: "g1", channelId: "c1" })
  })

  test("thread mention triggers in the thread scope", () => {
    const input = message({ threadId: "t1" })

    expect(shouldTriggerTurn(input, bot, false)).toBe(true)
    expect(toDiscordScope(input)).toEqual({ guildId: "g1", channelId: "c1", threadId: "t1" })
  })

  test("ignores DMs, bots, self, system messages, and mass mentions", () => {
    expect(shouldTriggerTurn(message({ channelType: "dm" }), bot, false)).toBe(false)
    expect(shouldTriggerTurn(message({ author: { id: "321", displayName: "Bot", isBot: true } }), bot, false)).toBe(false)
    expect(shouldTriggerTurn(message({ author: { id: "999", displayName: "Self", isBot: true } }), bot, false)).toBe(false)
    expect(shouldTriggerTurn(message({ isSystem: true }), bot, false)).toBe(false)
    expect(
      shouldTriggerTurn(message({ content: "@everyone", mentions: [], everyoneMention: true, roleMentions: ["role1"] }), bot, false)
    ).toBe(false)
  })

  test("active thread follow-ups can trigger without a repeated mention", () => {
    const followUp = message({ content: "continue", mentions: [], threadId: "t1" })
    const context = [message({ id: "m0", author: { id: "999", displayName: "Bridge", isBot: true }, threadId: "t1" })]

    expect(isThreadActiveFromContext(context, bot)).toBe(true)
    expect(shouldTriggerTurn(followUp, bot, true)).toBe(true)
  })
})
