import { Buffer } from "node:buffer"
import { Data, Effect } from "effect"
import type { OpencodePromptFilePart } from "./OpencodePort.ts"

class PromptPartError extends Data.TaggedError("PromptPartError")<{
  readonly message: string
}> {}

const causeText = (value: unknown): string => {
  if (value instanceof Error) return value.message.length === 0 ? causeText(value.cause) : value.message
  return typeof value === "string" && value.length > 0 ? value : "unknown error"
}

const isBase64DataUrl = (value: string): boolean => value.startsWith("data:") && /;base64,/i.test(value)

const partLabel = (part: OpencodePromptFilePart): string => part.filename ?? part.url

const imageError = (action: "fetch" | "read", part: OpencodePromptFilePart, detail: string) =>
  new PromptPartError({ message: `failed to ${action} image attachment ${partLabel(part)}: ${detail}` })

const fetchImagePart = Effect.fn("fetchImagePartDataUrl")(function* (part: OpencodePromptFilePart) {
  if (!part.mime.startsWith("image/") || isBase64DataUrl(part.url)) return part

  const response = yield* Effect.tryPromise({
    try: () => fetch(part.url),
    catch: (cause) => imageError("fetch", part, causeText(cause))
  })
  if (!response.ok) {
    const statusText = response.statusText.length === 0 ? "" : ` ${response.statusText}`
    return yield* Effect.fail(imageError("fetch", part, `${response.status}${statusText}`))
  }
  const buffer = yield* Effect.tryPromise({
    try: () => response.arrayBuffer(),
    catch: (cause) => imageError("read", part, causeText(cause))
  })
  return { ...part, url: `data:${part.mime};base64,${Buffer.from(buffer).toString("base64")}` }
})

export const preparePromptParts = Effect.fn("prepareOpencodePromptParts")(function* (
  parts: ReadonlyArray<OpencodePromptFilePart> | undefined
) {
  const prepared: Array<OpencodePromptFilePart> = []
  for (const part of parts ?? []) {
    prepared.push(yield* fetchImagePart(part))
  }
  return prepared
})
