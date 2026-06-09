export type DiscordSearchDateKey = "before" | "after" | "during"

export type DiscordSearchDateResult =
  | { readonly ok: true; readonly minId?: string; readonly maxId?: string }
  | { readonly ok: false; readonly error: string }

const discordEpochMs = 1_420_070_400_000n
const dayMs = 24 * 60 * 60 * 1000
const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/

const parseTimestampMs = (input: string): number | undefined => {
  const dateOnly = dateOnlyPattern.exec(input.trim())
  if (dateOnly !== null) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    const value = Date.UTC(year, month - 1, day)
    return Number.isFinite(value) ? value : undefined
  }
  const value = Date.parse(input)
  return Number.isFinite(value) ? value : undefined
}

const startOfUtcDay = (ms: number): number => {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export const timestampMsToDiscordSnowflake = (ms: number): string => {
  const timestamp = BigInt(Math.max(0, Math.trunc(ms)))
  const value = (timestamp - discordEpochMs) << 22n
  return (value > 0n ? value : 0n).toString()
}

export const discordSearchDateFilter = (key: DiscordSearchDateKey, value: string): DiscordSearchDateResult => {
  const ms = parseTimestampMs(value)
  if (ms === undefined) return { ok: false, error: `Invalid ${key}: date ${value}` }
  if (key === "during") {
    const start = startOfUtcDay(ms)
    return { ok: true, minId: timestampMsToDiscordSnowflake(start), maxId: timestampMsToDiscordSnowflake(start + dayMs) }
  }
  return key === "before" ? { ok: true, maxId: timestampMsToDiscordSnowflake(ms) } : { ok: true, minId: timestampMsToDiscordSnowflake(ms) }
}
