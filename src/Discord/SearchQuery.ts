import type { DiscordSearchQuery } from "../Schema.ts"
import { type DiscordSearchDateKey, discordSearchDateFilter, timestampMsToDiscordSnowflake } from "./SearchQueryDates.ts"
import { splitKeyValue, splitValues, tokenizeDiscordSearch, unique } from "./SearchQueryTokens.ts"

export { hasDiscordSearchCriteria } from "./SearchQueryCriteria.ts"
export { timestampMsToDiscordSnowflake }

export type DiscordSearchParseResult =
  | { readonly ok: true; readonly query: DiscordSearchQuery }
  | { readonly ok: false; readonly error: string }

type MutableSearchQueryFields = { -readonly [K in keyof DiscordSearchQuery]?: DiscordSearchQuery[K] }

type SearchState = {
  readonly content: Array<string>
  readonly authors: Array<string>
  readonly authorNames: Array<string>
  readonly authorTypes: Array<string>
  readonly channels: Array<string>
  readonly channelNames: Array<string>
  readonly mentions: Array<string>
  readonly mentionNames: Array<string>
  readonly roleMentions: Array<string>
  readonly repliedToUsers: Array<string>
  readonly repliedToUserNames: Array<string>
  readonly repliedToMessages: Array<string>
  readonly has: Array<string>
  readonly embedTypes: Array<string>
  readonly embedProviders: Array<string>
  readonly linkHostnames: Array<string>
  readonly attachmentFilenames: Array<string>
  readonly attachmentExtensions: Array<string>
  readonly next: MutableSearchQueryFields
}

type SearchHandler = (state: SearchState, value: string, key: string) => DiscordSearchParseResult | undefined

const snowflakePattern = /^\d{5,32}$/

const createState = (): SearchState => ({
  content: [],
  authors: [],
  authorNames: [],
  authorTypes: [],
  channels: [],
  channelNames: [],
  mentions: [],
  mentionNames: [],
  roleMentions: [],
  repliedToUsers: [],
  repliedToUserNames: [],
  repliedToMessages: [],
  has: [],
  embedTypes: [],
  embedProviders: [],
  linkHostnames: [],
  attachmentFilenames: [],
  attachmentExtensions: [],
  next: {}
})

const extractId = (input: string, pattern: RegExp): string | undefined => pattern.exec(input.trim())?.[1]
const isSnowflake = (input: string): boolean => snowflakePattern.test(input.trim())
const lower = (items: ReadonlyArray<string>): ReadonlyArray<string> => items.map((item) => item.toLowerCase())

const pushUserReference = (input: string, ids: Array<string>, names: Array<string>): void => {
  const id = extractId(input, /^<@!?(\d+)>$/)
  if (id !== undefined || isSnowflake(input)) ids.push(id ?? input.trim())
  else names.push(input.trim().replace(/^@/, ""))
}

const pushChannelReference = (input: string, ids: Array<string>, names: Array<string>): void => {
  const id = extractId(input, /^<#(\d+)>$/)
  if (id !== undefined || isSnowflake(input)) ids.push(id ?? input.trim())
  else names.push(input.trim().replace(/^#/, ""))
}

const pushRoleReference = (input: string, ids: Array<string>): DiscordSearchParseResult | undefined => {
  const id = extractId(input, /^<@&(\d+)>$/)
  if (id !== undefined || isSnowflake(input)) {
    ids.push(id ?? input.trim())
    return undefined
  }
  return { ok: false, error: `Role search requires a role ID or role mention: ${input}` }
}

const parseBoolean = (input: string): boolean | undefined => {
  switch (input.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "1":
      return true
    case "false":
    case "no":
    case "0":
      return false
    default:
      return undefined
  }
}

const contentHandler: SearchHandler = (state, value) => {
  state.content.push(value)
}

const authorHandler: SearchHandler = (state, value) => {
  for (const item of splitValues(value)) pushUserReference(item, state.authors, state.authorNames)
}

const channelHandler: SearchHandler = (state, value) => {
  for (const item of splitValues(value)) pushChannelReference(item, state.channels, state.channelNames)
}

const mentionHandler: SearchHandler = (state, value) => {
  for (const item of splitValues(value)) pushUserReference(item, state.mentions, state.mentionNames)
}

const roleHandler: SearchHandler = (state, value) => {
  for (const item of splitValues(value)) {
    const failed = pushRoleReference(item, state.roleMentions)
    if (failed !== undefined) return failed
  }
}

const repliedUserHandler: SearchHandler = (state, value) => {
  for (const item of splitValues(value)) pushUserReference(item, state.repliedToUsers, state.repliedToUserNames)
}

const dateHandler: SearchHandler = (state, value, key) => {
  const result = discordSearchDateFilter(key as DiscordSearchDateKey, value)
  if (!result.ok) return result
  if (result.minId !== undefined) state.next.minId = result.minId
  if (result.maxId !== undefined) state.next.maxId = result.maxId
}

const slopHandler: SearchHandler = (state, value) => {
  const slop = Number(value)
  if (!Number.isInteger(slop) || slop < 0 || slop > 100) return { ok: false, error: `Invalid slop: ${value}` }
  state.next.slop = slop
}

const booleanHandler =
  (field: "pinned" | "mentionEveryone" | "includeNsfw", label: string): SearchHandler =>
  (state, value) => {
    const parsed = parseBoolean(value)
    if (parsed === undefined) return { ok: false, error: `Invalid ${label}: value ${value}` }
    state.next[field] = parsed
  }

const sortHandler: SearchHandler = (state, value) => {
  const sortBy = value.toLowerCase()
  if (sortBy !== "timestamp" && sortBy !== "relevance") return { ok: false, error: `Invalid sort: value ${value}` }
  state.next.sortBy = sortBy
}

const orderHandler: SearchHandler = (state, value) => {
  const sortOrder = value.toLowerCase()
  if (sortOrder !== "asc" && sortOrder !== "desc") return { ok: false, error: `Invalid order: value ${value}` }
  state.next.sortOrder = sortOrder
}

const handlerByKey: Record<string, SearchHandler> = {}
const register = (aliases: ReadonlyArray<string>, handler: SearchHandler): void => {
  for (const alias of aliases) handlerByKey[alias] = handler
}

register(["content"], contentHandler)
register(["from", "author", "author_id"], authorHandler)
register(["author_type"], (state, value) => {
  state.authorTypes.push(...lower(splitValues(value)))
})
register(["in", "channel", "channel_id"], channelHandler)
register(["mentions", "mention", "mentions_user_id"], mentionHandler)
register(["mentions_role", "mentions_role_id", "mention_role", "role"], roleHandler)
register(["replied_to_user", "replied_to_user_id", "reply_to_user", "reply_to"], repliedUserHandler)
register(["replied_to_message", "replied_to_message_id", "reply_to_message"], (state, value) => {
  state.repliedToMessages.push(...splitValues(value))
})
register(["has"], (state, value) => {
  state.has.push(...lower(splitValues(value)))
})
register(["embed", "embed_type"], (state, value) => {
  state.embedTypes.push(...lower(splitValues(value)))
})
register(["embed_provider"], (state, value) => {
  state.embedProviders.push(...splitValues(value))
})
register(["link_hostname", "hostname", "domain"], (state, value) => {
  state.linkHostnames.push(...lower(splitValues(value)))
})
register(["attachment_filename", "filename"], (state, value) => {
  state.attachmentFilenames.push(...splitValues(value))
})
register(["attachment_extension", "extension", "ext"], (state, value) => {
  state.attachmentExtensions.push(...lower(splitValues(value).map((item) => item.replace(/^\./, ""))))
})
register(["before", "after", "during"], dateHandler)
register(["max_id"], (state, value) => {
  state.next.maxId = value
})
register(["min_id"], (state, value) => {
  state.next.minId = value
})
register(["slop"], slopHandler)
register(["pinned"], booleanHandler("pinned", "pinned"))
register(["mention_everyone", "everyone"], booleanHandler("mentionEveryone", "mention_everyone"))
register(["include_nsfw", "nsfw"], booleanHandler("includeNsfw", "include_nsfw"))
register(["sort", "sort_by"], sortHandler)
register(["order", "sort_order"], orderHandler)

const buildQuery = (state: SearchState): DiscordSearchQuery => {
  const content = state.content.join(" ").trim()
  return {
    ...(content.length === 0 ? {} : { content }),
    authors: unique(state.authors),
    authorNames: unique(state.authorNames),
    authorTypes: unique(state.authorTypes),
    channels: unique(state.channels),
    channelNames: unique(state.channelNames),
    mentions: unique(state.mentions),
    mentionNames: unique(state.mentionNames),
    roleMentions: unique(state.roleMentions),
    repliedToUsers: unique(state.repliedToUsers),
    repliedToUserNames: unique(state.repliedToUserNames),
    repliedToMessages: unique(state.repliedToMessages),
    has: unique(state.has),
    embedTypes: unique(state.embedTypes),
    embedProviders: unique(state.embedProviders),
    linkHostnames: unique(state.linkHostnames),
    attachmentFilenames: unique(state.attachmentFilenames),
    attachmentExtensions: unique(state.attachmentExtensions),
    ...state.next
  }
}

export const parseDiscordSearchQuery = (input: string): DiscordSearchParseResult => {
  const state = createState()
  for (const token of tokenizeDiscordSearch(input)) {
    const pair = splitKeyValue(token)
    const handler = pair === undefined ? undefined : handlerByKey[pair[0]]
    if (pair === undefined || handler === undefined) state.content.push(token)
    else {
      const failed = handler(state, pair[1], pair[0])
      if (failed !== undefined) return failed
    }
  }
  return { ok: true, query: buildQuery(state) }
}
