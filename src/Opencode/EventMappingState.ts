type MessageRole = "assistant" | "user"

export type DecodeOptions = {
  readonly includeGenericMessageParts?: boolean
  readonly includeGenericPartDeltas?: boolean
}

type DecodeState = {
  readonly assistantMessageIds: Set<string>
  readonly textPartIds: Set<string>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

const eventPayload = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (!isRecord(value)) return undefined
  const payload = value.payload
  return isRecord(payload) && stringField(payload, "type") !== undefined ? payload : value
}

const payloadProperties = (record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const properties = record.properties
  return isRecord(properties) ? properties : record
}

const genericMessagePartType = (type: string | undefined): boolean => type === "message.part.delta" || type === "message.part.updated"

const messagePart = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  const event = eventPayload(value)
  if (event === undefined || !genericMessagePartType(stringField(event, "type"))) return undefined
  const properties = payloadProperties(event)
  const part = properties.part ?? event.part
  return isRecord(part) ? part : undefined
}

const partId = (part: Readonly<Record<string, unknown>> | undefined): string | undefined =>
  part === undefined ? undefined : (stringField(part, "id") ?? stringField(part, "partID") ?? stringField(part, "partId"))

const messagePartField = (value: unknown, primary: string, secondary: string): string | undefined => {
  const event = eventPayload(value)
  if (event === undefined || !genericMessagePartType(stringField(event, "type"))) return undefined
  const properties = payloadProperties(event)
  const part = properties.part ?? event.part
  if (isRecord(part)) {
    const partValue = stringField(part, primary) ?? stringField(part, secondary)
    if (partValue !== undefined) return partValue
  }
  return stringField(properties, primary) ?? stringField(properties, secondary)
}

const messagePartPartId = (value: unknown): string | undefined => partId(messagePart(value)) ?? messagePartField(value, "partID", "partId")

const messagePartMessageId = (value: unknown): string | undefined => messagePartField(value, "messageID", "messageId")

const messageRole = (value: unknown): MessageRole | undefined => (value === "assistant" || value === "user" ? value : undefined)

const messageRoleUpdate = (value: unknown): { readonly id: string; readonly role: MessageRole } | undefined => {
  const event = eventPayload(value)
  if (event === undefined || stringField(event, "type") !== "message.updated") return undefined
  const info = payloadProperties(event).info
  if (!isRecord(info)) return undefined
  const id = stringField(info, "id")
  const role = messageRole(info.role)
  return id === undefined || role === undefined ? undefined : { id, role }
}

export const initialDecodeState = (): DecodeState => ({ assistantMessageIds: new Set(), textPartIds: new Set() })

export const updateDecodeState = (state: DecodeState, value: unknown): DecodeState => {
  const update = messageRoleUpdate(value)
  if (update !== undefined) state.assistantMessageIds[update.role === "assistant" ? "add" : "delete"](update.id)

  const part = messagePart(value)
  const id = partId(part)
  if (part !== undefined && id !== undefined) state.textPartIds[stringField(part, "type") === "text" ? "add" : "delete"](id)
  return state
}

export const includeGenericMessageParts = (state: DecodeState, value: unknown): boolean => {
  const messageId = messagePartMessageId(value)
  return messageId !== undefined && state.assistantMessageIds.has(messageId)
}

export const includeGenericPartDeltas = (state: DecodeState, value: unknown): boolean => {
  const event = eventPayload(value)
  if (event === undefined || stringField(event, "type") !== "message.part.delta") return false
  const part = messagePart(value)
  if (part !== undefined) return stringField(part, "type") === "text"
  const id = messagePartPartId(value)
  return id !== undefined && state.textPartIds.has(id)
}
