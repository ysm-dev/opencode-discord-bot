import { Stream } from "effect"
import type { OpencodeEvent } from "../Schema.ts"
import {
  type DecodeOptions,
  includeGenericMessageParts,
  includeGenericPartDeltas,
  initialDecodeState,
  updateDecodeState
} from "./EventMappingState.ts"
import type { OpencodeError } from "./OpencodePort.ts"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

const numberField = (record: Readonly<Record<string, unknown>>, key: string): number | undefined => {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

const payloadProperties = (record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const properties = record.properties
  return isRecord(properties) ? properties : record
}

const eventPayload = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (!isRecord(value)) return undefined
  const payload = value.payload
  return isRecord(payload) && stringField(payload, "type") !== undefined ? payload : value
}

const textPart = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (!isRecord(value)) return undefined
  return stringField(value, "type") === "text" ? value : undefined
}

const textId = (record: Readonly<Record<string, unknown>>): string | undefined =>
  stringField(record, "textID") ?? stringField(record, "textId")

const partId = (record: Readonly<Record<string, unknown>>): string | undefined =>
  stringField(record, "id") ?? stringField(record, "partID") ?? stringField(record, "partId")

const messagePartId = (
  payload: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>>,
  part: Readonly<Record<string, unknown>> | undefined
): string | undefined =>
  (part === undefined ? undefined : partId(part)) ??
  textId(properties) ??
  stringField(properties, "partID") ??
  stringField(properties, "partId") ??
  stringField(payload, "partID") ??
  stringField(payload, "partId")

const errorMessage = (value: unknown): string => {
  if (!isRecord(value)) return "Unknown opencode error"
  const properties = payloadProperties(value)
  const nested = properties.error
  if (isRecord(nested)) {
    const data = nested.data
    if (isRecord(data)) return stringField(data, "message") ?? stringField(nested, "message") ?? "Unknown opencode error"
    return stringField(nested, "message") ?? "Unknown opencode error"
  }
  return stringField(properties, "message") ?? stringField(value, "message") ?? "Unknown opencode error"
}

const toolTitle = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined
  const properties = payloadProperties(value)
  const step = properties.step
  if (!isRecord(step)) return undefined
  return stringField(step, "type") === "tool" ? stringField(step, "title") : undefined
}

const toolName = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined
  const properties = payloadProperties(value)
  return stringField(properties, "tool") ?? stringField(properties, "title")
}

const changedFilesFromCounts = (files: number, insertions: number, deletions: number): OpencodeEvent | undefined => {
  if (files <= 0 && insertions <= 0 && deletions <= 0) return undefined
  return { type: "changed-files", files, insertions, deletions }
}

const changedFiles = (value: unknown): OpencodeEvent | undefined => {
  if (!isRecord(value)) return undefined
  const properties = payloadProperties(value)
  const diff = properties.diff
  if (Array.isArray(diff)) {
    let insertions = 0
    let deletions = 0
    for (const item of diff) {
      if (!isRecord(item)) continue
      insertions += numberField(item, "additions") ?? numberField(item, "insertions") ?? 0
      deletions += numberField(item, "deletions") ?? 0
    }
    return changedFilesFromCounts(diff.length, insertions, deletions)
  }
  return changedFilesFromCounts(
    numberField(properties, "files") ?? numberField(value, "files") ?? 0,
    numberField(properties, "insertions") ?? numberField(properties, "additions") ?? numberField(value, "insertions") ?? 0,
    numberField(properties, "deletions") ?? numberField(value, "deletions") ?? 0
  )
}

const decodeLifecycle = (payload: Readonly<Record<string, unknown>>, type: string | undefined): OpencodeEvent | undefined => {
  switch (type) {
    case "session.idle":
      return { type: "idle" }
    case "session.error":
      return { type: "error", message: errorMessage(payload) }
    case "session.diff":
      return changedFiles(payload)
    default:
      return undefined
  }
}

const decodeText = (properties: Readonly<Record<string, unknown>>, type: string | undefined): OpencodeEvent | undefined => {
  switch (type) {
    case "session.next.text.delta": {
      const delta = stringField(properties, "delta")
      if (delta === undefined) return undefined
      const id = textId(properties)
      return id === undefined ? { type: "text-delta", text: delta } : { type: "text-delta", id, text: delta }
    }
    case "session.next.text.ended": {
      const text = stringField(properties, "text")
      if (text === undefined) return undefined
      const id = textId(properties)
      return id === undefined ? { type: "text-snapshot", text } : { type: "text-snapshot", id, text }
    }
    default:
      return undefined
  }
}

const textDelta = (
  payload: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>>,
  id: string | undefined
): OpencodeEvent | undefined => {
  const delta = stringField(properties, "delta") ?? stringField(payload, "delta")
  if (delta === undefined) return undefined
  return id === undefined ? { type: "text-delta", text: delta } : { type: "text-delta", id, text: delta }
}

const decodePartDelta = (
  payload: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>>,
  options: DecodeOptions
): OpencodeEvent | undefined => {
  const part = properties.part ?? payload.part
  if (part !== undefined) {
    const text = textPart(part)
    return text === undefined ? undefined : textDelta(payload, properties, messagePartId(payload, properties, text))
  }
  if (options.includeGenericPartDeltas !== true) return undefined
  const id = messagePartId(payload, properties, undefined)
  return stringField(properties, "field") === "text" ? textDelta(payload, properties, id) : undefined
}

const decodePartUpdated = (
  payload: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>>
): OpencodeEvent | undefined => {
  const part = textPart(properties.part ?? payload.part)
  if (part === undefined) return undefined
  const id = messagePartId(payload, properties, part)
  const delta = textDelta(payload, properties, id)
  if (delta !== undefined) return delta
  const text = stringField(part, "text")
  if (text === undefined) return undefined
  return id === undefined ? { type: "text-snapshot", text } : { type: "text-snapshot", id, text }
}

const decodeReasoning = (type: string | undefined): OpencodeEvent | undefined =>
  type === "session.next.reasoning.started" ? { type: "reasoning-start" } : undefined

const decodePart = (
  payload: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>>,
  type: string | undefined,
  options: DecodeOptions
): OpencodeEvent | undefined => {
  switch (type) {
    case "message.part.delta": {
      if (options.includeGenericMessageParts !== true) return undefined
      return decodePartDelta(payload, properties, options)
    }
    case "session.next.message.part.delta":
      return decodePartDelta(payload, properties, { ...options, includeGenericPartDeltas: true })
    case "message.part.updated": {
      if (options.includeGenericMessageParts !== true) return undefined
      return decodePartUpdated(payload, properties)
    }
    case "session.next.message.part.updated":
      return decodePartUpdated(payload, properties)
    default:
      return undefined
  }
}

const decodeTool = (payload: Readonly<Record<string, unknown>>, type: string | undefined): OpencodeEvent | undefined => {
  switch (type) {
    case "session.next.tool.called": {
      const title = toolName(payload)
      return title === undefined ? undefined : { type: "tool-start", title }
    }
    case "session.next.tool.success":
      return { type: "tool-end" }
    case "session.next.tool.failed":
      return { type: "error", message: errorMessage(payload) }
    default:
      return undefined
  }
}

const decodeStep = (payload: Readonly<Record<string, unknown>>, type: string | undefined): OpencodeEvent | undefined => {
  switch (type) {
    case "session.next.step.started": {
      const title = toolTitle(payload)
      return title === undefined ? undefined : { type: "tool-start", title }
    }
    case "session.next.step.finished":
    case "session.next.step.ended":
      return { type: "tool-end" }
    case "session.step.failed":
    case "session.next.step.failed":
      return { type: "error", message: errorMessage(payload) }
    default:
      return undefined
  }
}

export const decodeOpencodeEvent = (payload: unknown, options: DecodeOptions = {}): OpencodeEvent | undefined => {
  const event = eventPayload(payload)
  if (event === undefined) return undefined
  const type = stringField(event, "type")
  const properties = payloadProperties(event)
  return (
    decodeLifecycle(event, type) ??
    decodeText(properties, type) ??
    decodeReasoning(type) ??
    decodePart(event, properties, type, options) ??
    decodeTool(event, type) ??
    decodeStep(event, type)
  )
}

export const opencodeEventStream = (events: Stream.Stream<unknown, OpencodeError>) =>
  events.pipe(
    Stream.mapAccum(initialDecodeState, (state, event) => {
      const nextState = updateDecodeState(state, event)
      const decoded = decodeOpencodeEvent(event, {
        includeGenericMessageParts: includeGenericMessageParts(nextState, event),
        includeGenericPartDeltas: includeGenericPartDeltas(nextState, event)
      })
      return [nextState, decoded === undefined ? [] : [decoded]]
    })
  )
