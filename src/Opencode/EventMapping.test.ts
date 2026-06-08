import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { decodeOpencodeEvent, opencodeEventStream } from "./EventMapping.ts"

describe("opencode event mapping", () => {
  test("maps lifecycle, text delta, snapshot, tool, changed-file, and error events", async () => {
    const events = await Effect.runPromise(
      opencodeEventStream(
        Stream.fromIterable([
          { id: "e1", type: "session.idle", properties: { sessionID: "s1" } },
          { id: "e2", type: "session.next.reasoning.delta", properties: { delta: "thinking" } },
          { id: "e3", type: "session.next.text.delta", properties: { delta: "hello" } },
          { id: "e4", type: "session.next.text.ended", properties: { text: "snapshot" } },
          {
            id: "e5-role",
            type: "message.updated",
            properties: { sessionID: "s1", info: { id: "assistant-message", role: "assistant" } }
          },
          {
            id: "e5",
            type: "message.part.delta",
            properties: { messageID: "assistant-message", part: { messageID: "assistant-message", type: "text" }, delta: " fallback" }
          },
          {
            id: "e6",
            type: "message.part.updated",
            properties: { part: { messageID: "assistant-message", type: "text", text: "updated" } }
          },
          { id: "e7", type: "session.next.tool.called", properties: { tool: "Running tests" } },
          { id: "e8", type: "session.next.tool.success", properties: {} },
          { id: "e9", type: "session.next.tool.failed", properties: { error: { message: "tool failed" } } },
          { id: "e10", type: "session.next.step.started", properties: { step: { type: "tool", title: "Editing file" } } },
          { id: "e11", type: "session.next.step.ended", properties: {} },
          { id: "e12", type: "session.diff", properties: { diff: [{ path: "a.ts" }, { path: "b.ts" }] } },
          { id: "e13", type: "session.error", properties: { error: { message: "boom" } } }
        ])
      ).pipe(Stream.runCollect)
    )

    expect(events).toEqual([
      { type: "idle" },
      { type: "text-delta", text: "hello" },
      { type: "text-snapshot", text: "snapshot" },
      { type: "text-delta", text: " fallback" },
      { type: "text-snapshot", text: "updated" },
      { type: "tool-start", title: "Running tests" },
      { type: "tool-end" },
      { type: "error", message: "tool failed" },
      { type: "tool-start", title: "Editing file" },
      { type: "tool-end" },
      { type: "changed-files", files: 2, insertions: 0, deletions: 0 },
      { type: "error", message: "boom" }
    ])
  })

  test("ignores unknown or non-text event payloads", () => {
    expect(decodeOpencodeEvent({ type: "unknown" })).toBeUndefined()
    expect(decodeOpencodeEvent({ type: "session.next.reasoning.delta", properties: { delta: "hidden" } })).toBeUndefined()
    expect(decodeOpencodeEvent({ type: "message.part.delta", part: { type: "reasoning" }, delta: "hidden" })).toBeUndefined()
  })

  test("maps wrapped SDK events and delta-bearing part updates", () => {
    expect(
      decodeOpencodeEvent({
        directory: "/repo",
        payload: { id: "e1", type: "session.next.text.delta", properties: { sessionID: "s1", delta: "wrapped" } }
      })
    ).toEqual({ type: "text-delta", text: "wrapped" })
    expect(
      decodeOpencodeEvent({
        type: "message.part.updated",
        properties: { sessionID: "s1", part: { type: "text", text: "hello" }, delta: "lo" }
      })
    ).toBeUndefined()
    expect(
      decodeOpencodeEvent(
        {
          type: "message.part.updated",
          properties: { sessionID: "s1", part: { type: "text", text: "hello" }, delta: "lo" }
        },
        { includeGenericMessageParts: true }
      )
    ).toEqual({ type: "text-delta", text: "lo" })
    expect(
      decodeOpencodeEvent({ type: "message.part.delta", properties: { sessionID: "s1", field: "reasoning", delta: "hidden" } })
    ).toBeUndefined()
    expect(
      decodeOpencodeEvent(
        { type: "message.part.delta", properties: { sessionID: "s1", field: "text", delta: "ambiguous" } },
        { includeGenericMessageParts: true }
      )
    ).toBeUndefined()
  })

  test("does not render reasoning part text deltas as assistant output", async () => {
    const events = await Effect.runPromise(
      opencodeEventStream(
        Stream.fromIterable([
          {
            type: "message.updated",
            properties: { sessionID: "s1", info: { id: "assistant-message", role: "assistant" } }
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID: "s1",
              part: { id: "reasoning-part", sessionID: "s1", messageID: "assistant-message", type: "reasoning", text: "thinking" }
            }
          },
          {
            type: "message.part.delta",
            properties: { sessionID: "s1", messageID: "assistant-message", partID: "reasoning-part", field: "text", delta: " hidden" }
          },
          { type: "session.next.text.delta", properties: { sessionID: "s1", delta: "answer" } },
          { type: "session.idle", properties: { sessionID: "s1" } }
        ])
      ).pipe(Stream.runCollect)
    )

    expect(events).toEqual([{ type: "text-delta", text: "answer" }, { type: "idle" }])
  })

  test("maps numeric diff and legacy failed-step event shapes", () => {
    expect(
      decodeOpencodeEvent({
        type: "session.diff",
        properties: {
          diff: [
            { additions: 2, deletions: 1 },
            { additions: 3, deletions: 0 }
          ]
        }
      })
    ).toEqual({
      type: "changed-files",
      files: 2,
      insertions: 5,
      deletions: 1
    })
    expect(decodeOpencodeEvent({ type: "session.diff", properties: { diff: [] } })).toBeUndefined()
    expect(decodeOpencodeEvent({ type: "session.diff", properties: { files: 0, insertions: 0, deletions: 0 } })).toBeUndefined()
    expect(decodeOpencodeEvent({ type: "session.diff", properties: { files: 2, insertions: 5, deletions: 1 } })).toEqual({
      type: "changed-files",
      files: 2,
      insertions: 5,
      deletions: 1
    })
    expect(decodeOpencodeEvent({ type: "session.next.step.finished" })).toEqual({ type: "tool-end" })
    expect(decodeOpencodeEvent({ type: "session.step.failed", message: "legacy failed" })).toEqual({
      type: "error",
      message: "legacy failed"
    })
    expect(decodeOpencodeEvent(undefined)).toBeUndefined()
    expect(decodeOpencodeEvent({ type: "session.diff", files: 1, insertions: 2, deletions: 3 })).toEqual({
      type: "changed-files",
      files: 1,
      insertions: 2,
      deletions: 3
    })
  })

  test("does not render user prompt message parts as assistant output", async () => {
    const events = await Effect.runPromise(
      opencodeEventStream(
        Stream.fromIterable([
          {
            type: "message.updated",
            properties: { sessionID: "s1", info: { id: "user-message", role: "user" } }
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID: "s1",
              part: { id: "user-text", sessionID: "s1", messageID: "user-message", type: "text", text: "Discord bridge context" }
            }
          },
          {
            type: "session.next.text.ended",
            properties: { sessionID: "s1", assistantMessageID: "assistant-message", textID: "assistant-text", text: "Normal answer" }
          },
          { type: "session.idle", properties: { sessionID: "s1" } }
        ])
      ).pipe(Stream.runCollect)
    )

    expect(events).toEqual([{ type: "text-snapshot", text: "Normal answer" }, { type: "idle" }])
  })
})
