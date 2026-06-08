import { describe, expect, test } from "bun:test"
import { splitDiscordMarkdown } from "./Splitting.ts"

describe("splitDiscordMarkdown", () => {
  test("returns no chunks for empty output", () => {
    expect(splitDiscordMarkdown("")).toEqual([])
  })

  test("hard-splits a single oversized line", () => {
    expect(splitDiscordMarkdown("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)])
  })

  test("keeps every chunk within Discord's 2000 character limit", () => {
    const chunks = splitDiscordMarkdown(`${"a".repeat(1990)}\n${"b".repeat(1990)}`)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true)
    expect(chunks.join("\n").replaceAll("\n", "")).toContain("a".repeat(100))
  })

  test("preserves code fences across continuation messages", () => {
    const source = `before\n\`\`\`ts\n${"const value = 1\n".repeat(180)}\`\`\`\nafter`
    const chunks = splitDiscordMarkdown(source)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true)
    expect(chunks.at(0)?.endsWith("\n```")).toBe(true)
    expect(chunks.at(1)?.startsWith("```ts\n")).toBe(true)
  })
})
