import { describe, expect, test } from "bun:test"
import { parseDiscordSearchQuery, timestampMsToDiscordSnowflake } from "./SearchQuery.ts"

describe("parseDiscordSearchQuery", () => {
  test("parses Discord-style search operators", () => {
    const result = parseDiscordSearchQuery(
      '"release notes" from:<@123> mentions:<@!456> in:<#789> has:link pinned:true sort:relevance order:asc'
    )
    if (!result.ok) throw new Error(result.error)

    expect(result.query).toMatchObject({
      content: "release notes",
      authors: ["123"],
      mentions: ["456"],
      channels: ["789"],
      has: ["link"],
      pinned: true,
      sortBy: "relevance",
      sortOrder: "asc"
    })
  })

  test("supports name references and raw API filter aliases", () => {
    const result = parseDiscordSearchQuery(
      "from:Alice in:#general author_type:bot attachment_extension:ts link_hostname:example.com embed_type:image mention_everyone:false"
    )
    if (!result.ok) throw new Error(result.error)

    expect(result.query.authorNames).toEqual(["Alice"])
    expect(result.query.channelNames).toEqual(["general"])
    expect(result.query.authorTypes).toEqual(["bot"])
    expect(result.query.attachmentExtensions).toEqual(["ts"])
    expect(result.query.linkHostnames).toEqual(["example.com"])
    expect(result.query.embedTypes).toEqual(["image"])
    expect(result.query.mentionEveryone).toBe(false)
  })

  test("converts date filters to Discord snowflake IDs", () => {
    const result = parseDiscordSearchQuery("after:2026-06-05 during:2026-06-06")
    if (!result.ok) throw new Error(result.error)

    expect(result.query.minId).toBe(timestampMsToDiscordSnowflake(Date.UTC(2026, 5, 6)))
    expect(result.query.maxId).toBe(timestampMsToDiscordSnowflake(Date.UTC(2026, 5, 7)))
  })

  test("rejects invalid operators", () => {
    expect(parseDiscordSearchQuery("pinned:maybe")).toEqual({ ok: false, error: "Invalid pinned: value maybe" })
    expect(parseDiscordSearchQuery("role:moderators")).toEqual({
      ok: false,
      error: "Role search requires a role ID or role mention: moderators"
    })
  })
})
