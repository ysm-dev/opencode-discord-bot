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

const normalizeMime = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined
  const mime = value.split(";", 1)[0]?.trim().toLowerCase()
  return mime === undefined || mime.length === 0 ? undefined : mime
}

const imageMime = (value: string | null | undefined): string | undefined => {
  const mime = normalizeMime(value)
  return mime?.startsWith("image/") ? mime : undefined
}

const hasSignature = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value)

const detectedImageMime = (bytes: Uint8Array): string | undefined => {
  if (hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (hasSignature(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (hasSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || hasSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif"
  }
  if (hasSignature(bytes, [0x52, 0x49, 0x46, 0x46]) && hasSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"
  return undefined
}

type Base64DataUrl = {
  readonly mime?: string
  readonly data: string
}

const base64DataUrl = (value: string): Base64DataUrl | undefined => {
  if (!isBase64DataUrl(value)) return undefined
  const comma = value.indexOf(",")
  if (comma < 0) return undefined
  const metadata = value.slice(5, comma)
  const mime = imageMime(metadata.split(";", 1)[0])
  return { ...(mime === undefined ? {} : { mime }), data: value.slice(comma + 1) }
}

const imageDataUrl = (mime: string, bytes: Uint8Array | Buffer): string => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`

const normalizeImageDataUrlPart = (part: OpencodePromptFilePart, declaredMime: string): OpencodePromptFilePart => {
  const dataUrl = base64DataUrl(part.url)
  if (dataUrl === undefined) return part
  const bytes = Buffer.from(dataUrl.data, "base64")
  const mime = detectedImageMime(bytes) ?? dataUrl.mime ?? declaredMime
  return { ...part, mime, url: imageDataUrl(mime, bytes) }
}

const imageError = (action: "fetch" | "read", part: OpencodePromptFilePart, detail: string) =>
  new PromptPartError({ message: `failed to ${action} image attachment ${partLabel(part)}: ${detail}` })

const fetchImagePart = Effect.fn("fetchImagePartDataUrl")(function* (part: OpencodePromptFilePart) {
  const declaredMime = imageMime(part.mime)
  if (declaredMime === undefined) return part
  if (isBase64DataUrl(part.url)) return normalizeImageDataUrlPart(part, declaredMime)

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
  const bytes = new Uint8Array(buffer)
  const mime = detectedImageMime(bytes) ?? imageMime(response.headers.get("content-type")) ?? declaredMime
  return { ...part, mime, url: imageDataUrl(mime, bytes) }
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
