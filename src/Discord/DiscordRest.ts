import { Duration, Effect } from "effect"
import { DiscordError } from "./DiscordPort.ts"

export type RawDiscordOptions = {
  readonly botToken: string
  readonly apiUrl?: string | undefined
  readonly nicknameCacheTtlMs?: number | undefined
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const retryAfterHeader = (response: Response) => {
  const value = response.headers.get("retry-after")
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Duration.millis(seconds * 1000) : undefined
}

const retryAfterBody = (body: unknown) => {
  if (!isRecord(body)) return undefined
  const retryAfter = body.retry_after
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0 ? Duration.millis(retryAfter * 1000) : undefined
}

export const rawDiscordRequest = async (options: RawDiscordOptions | undefined, path: string, init: RequestInit): Promise<unknown> => {
  if (options === undefined) throw new Error("Discord adapter does not expose this operation")
  const response = await fetch(`${options.apiUrl ?? "https://discord.com/api/v10"}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${options.botToken}`,
      "content-type": "application/json",
      ...init.headers
    }
  })
  if (!response.ok) {
    throw new DiscordError({
      message: `Discord REST ${response.status}: ${await response.text()}`,
      retryAfter: retryAfterHeader(response)
    })
  }
  if (response.status === 204) return {}
  return await response.json()
}

export const rawDiscordSearchRequest = async (options: RawDiscordOptions | undefined, path: string): Promise<unknown> => {
  if (options === undefined) throw new Error("Discord adapter does not expose this operation")
  const response = await fetch(`${options.apiUrl ?? "https://discord.com/api/v10"}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bot ${options.botToken}`,
      "content-type": "application/json"
    }
  })
  if (response.status === 202) {
    const body = await response.json().catch(() => ({}))
    throw new DiscordError({
      message: "Discord search index is not ready yet; retry the search later",
      retryAfter: retryAfterBody(body) ?? retryAfterHeader(response)
    })
  }
  if (!response.ok) {
    throw new DiscordError({
      message: `Discord REST ${response.status}: ${await response.text()}`,
      retryAfter: retryAfterHeader(response)
    })
  }
  return await response.json()
}

export const rawDiscord = (options: RawDiscordOptions | undefined, path: string, init: RequestInit): Effect.Effect<unknown, DiscordError> =>
  Effect.tryPromise({
    try: () => rawDiscordRequest(options, path, init),
    catch: (cause) =>
      cause instanceof DiscordError
        ? cause
        : new DiscordError({ message: cause instanceof Error ? cause.message : "Discord REST operation failed" })
  })
