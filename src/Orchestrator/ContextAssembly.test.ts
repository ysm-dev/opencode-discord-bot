import { describe, expect, test } from "bun:test"
import type { DiscordMessage } from "../Schema.ts"
import { assembleContextPrompt, formatDiscordMessage } from "./ContextAssembly.ts"

const makeMessage = (id: string, content: string, extra: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id,
  guildId: "g1",
  channelId: "c1",
  author: { id: `u-${id}`, displayName: `User ${id}`, nickname: `Nick ${id}`, isBot: false },
  content,
  timestamp: "2026-06-05T14:03:00.000Z",
  mentions: [],
  roleMentions: [],
  everyoneMention: false,
  hereMention: false,
  attachments: [],
  reactions: [],
  channelType: "guild",
  ...extra
})

describe("context assembly", () => {
  test("renders the structured Discord envelope", () => {
    const rendered = formatDiscordMessage(
      makeMessage("1", "Can you refactor this?", {
        attachments: [{ id: "a1", filename: "screenshot.png", contentType: "image/png", size: 12, url: "https://cdn/a1" }],
        reactions: [
          { emoji: "thumbs_up", count: 2 },
          { emoji: "tada", count: 1 }
        ]
      })
    )

    expect(rendered).toContain("[Nick 1 | <@u-1> | 2026-06-05 14:03 UTC]")
    expect(rendered).toContain("Can you refactor this?")
    expect(rendered).toContain("(discord target: guildId=g1 channelId=c1 messageId=1)")
    expect(rendered).toContain("(attachments: screenshot.png [image/png; 12 bytes; https://cdn/a1])")
    expect(rendered).toContain("(reactions: thumbs_up x2, tada x1)")
  })

  test("dedupes context and includes the triggering message exactly once at the end", () => {
    const trigger = makeMessage("3", "latest <@999>", { mentions: ["999"] })
    const prompt = assembleContextPrompt({
      botUserId: "999",
      contextMessages: [makeMessage("1", "older"), trigger, makeMessage("2", "middle"), trigger],
      triggerMessage: trigger,
      maxMessages: 30,
      maxChars: 10_000,
      maxAttachmentBytes: 10_000
    })

    expect(prompt.messages.map((item) => item.id)).toEqual(["1", "2", "3"])
    expect(prompt.text.match(/latest <@999>/g)).toHaveLength(1)
    expect(prompt.text).toContain("<@id> pings that user in Discord")
    expect(prompt.text).toContain("Use discord target metadata when calling bridge tools")
    expect(prompt.text).toContain("Do not emit @everyone, @here, or role pings")
  })

  test("applies top-N and character budgets without dropping the trigger", () => {
    const trigger = makeMessage("5", "trigger")
    const prompt = assembleContextPrompt({
      botUserId: "999",
      contextMessages: [makeMessage("1", "one"), makeMessage("2", "two"), makeMessage("3", "three"), makeMessage("4", "four")],
      triggerMessage: trigger,
      maxMessages: 3,
      maxChars: 250,
      maxAttachmentBytes: 10_000
    })

    expect(prompt.messages.at(-1)?.id).toBe("5")
    expect(prompt.messages.length).toBeLessThanOrEqual(3)
    expect(prompt.text.length).toBeLessThanOrEqual(250)
  })

  test("surfaces queued intermediate messages before the latest trigger", () => {
    const skipped = makeMessage("2", "intermediate <@999>", { mentions: ["999"] })
    const trigger = makeMessage("3", "latest <@999>", { mentions: ["999"] })
    const prompt = assembleContextPrompt({
      botUserId: "999",
      contextMessages: [makeMessage("1", "older"), skipped, trigger],
      skippedMessages: [skipped],
      triggerMessage: trigger,
      maxMessages: 3,
      maxChars: 10_000,
      maxAttachmentBytes: 10_000
    })

    expect(prompt.messages.map((item) => item.id)).toEqual(["1", "2", "3"])
    expect(prompt.text).toContain("(queued intermediate message)")
    expect(prompt.text.indexOf("intermediate <@999>")).toBeLessThan(prompt.text.indexOf("latest <@999>"))
  })

  test("creates opencode file parts for supported attachments under the configured cap", () => {
    const trigger = makeMessage("1", "see files", {
      attachments: [
        { id: "a1", filename: "screenshot.png", contentType: "image/png", size: 12, url: "https://cdn/screenshot.png" },
        { id: "a2", filename: "movie.mp4", contentType: "video/mp4", size: 12, url: "https://cdn/movie.mp4" },
        { id: "a3", filename: "large.pdf", contentType: "application/pdf", size: 100, url: "https://cdn/large.pdf" }
      ]
    })

    const prompt = assembleContextPrompt({
      botUserId: "999",
      contextMessages: [trigger],
      triggerMessage: trigger,
      maxMessages: 30,
      maxChars: 10_000,
      maxAttachmentBytes: 50
    })

    expect(prompt.parts).toEqual([{ type: "file", mime: "image/png", filename: "screenshot.png", url: "https://cdn/screenshot.png" }])
    expect(prompt.text).toContain("movie.mp4 [video/mp4; 12 bytes; https://cdn/movie.mp4]")
    expect(prompt.text).toContain("large.pdf [application/pdf; 100 bytes; https://cdn/large.pdf]")
  })
})
