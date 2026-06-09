import type { DiscordAttachment, DiscordMessage, DiscordScope, DiscordSearchQuery, DiscordSearchResult } from "../Schema.ts"
import { DiscordError } from "./DiscordPort.ts"
import { type RawDiscordOptions, rawDiscordRequest, rawDiscordSearchRequest } from "./DiscordRest.ts"

type NicknameResolver = (scope: DiscordScope, userId: string) => Promise<string | undefined>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

const userIdFromMemberSearch = (data: unknown): string | undefined => {
  if (!Array.isArray(data)) return undefined
  const first = data[0]
  if (!isRecord(first)) return undefined
  return stringField(first.user, "id")
}

const channelIdFromGuildChannels = (data: unknown, name: string): string | undefined => {
  if (!Array.isArray(data)) return undefined
  const normalized = name.toLowerCase().replace(/^#/, "")
  for (const channel of data) {
    if (!isRecord(channel)) continue
    const channelName = stringField(channel, "name")
    if (channelName?.toLowerCase() === normalized) return stringField(channel, "id")
  }
  return undefined
}

const resolveUserName = async (raw: RawDiscordOptions | undefined, scope: DiscordScope, name: string): Promise<string> => {
  const params = new URLSearchParams({ query: name, limit: "1" })
  const result = await rawDiscordRequest(raw, `/guilds/${scope.guildId}/members/search?${params}`, { method: "GET" })
  const id = userIdFromMemberSearch(result)
  if (id === undefined) throw new DiscordError({ message: `Unable to resolve Discord user ${name}; use an ID or mention` })
  return id
}

const resolveChannelName = async (raw: RawDiscordOptions | undefined, scope: DiscordScope, name: string): Promise<string> => {
  const result = await rawDiscordRequest(raw, `/guilds/${scope.guildId}/channels`, { method: "GET" })
  const id = channelIdFromGuildChannels(result, name)
  if (id === undefined) throw new DiscordError({ message: `Unable to resolve Discord channel ${name}; use an ID or channel mention` })
  return id
}

const resolveSearchQuery = async (
  raw: RawDiscordOptions | undefined,
  scope: DiscordScope,
  query: DiscordSearchQuery
): Promise<DiscordSearchQuery> => {
  const [authors, channels, mentions, repliedToUsers] = await Promise.all([
    Promise.all(query.authorNames.map((name) => resolveUserName(raw, scope, name))),
    Promise.all(query.channelNames.map((name) => resolveChannelName(raw, scope, name))),
    Promise.all(query.mentionNames.map((name) => resolveUserName(raw, scope, name))),
    Promise.all(query.repliedToUserNames.map((name) => resolveUserName(raw, scope, name)))
  ])
  return {
    ...query,
    authors: [...query.authors, ...authors],
    authorNames: [],
    channels: [...query.channels, ...channels],
    channelNames: [],
    mentions: [...query.mentions, ...mentions],
    mentionNames: [],
    repliedToUsers: [...query.repliedToUsers, ...repliedToUsers],
    repliedToUserNames: []
  }
}

const rawAttachment = (item: unknown): DiscordAttachment | undefined => {
  if (!isRecord(item)) return undefined
  const id = stringField(item, "id")
  const filename = stringField(item, "filename")
  const url = stringField(item, "url") ?? ""
  const size = typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0 ? item.size : 0
  const contentType = stringField(item, "content_type")
  if (id === undefined || filename === undefined) return undefined
  return { id, filename, ...(contentType === undefined ? {} : { contentType }), size, url }
}

const rawUserIds = (items: unknown): ReadonlyArray<string> =>
  Array.isArray(items)
    ? items.flatMap((item) => {
        const id = stringField(item, "id")
        return id === undefined ? [] : [id]
      })
    : []

const rawStringArray = (items: unknown): ReadonlyArray<string> =>
  Array.isArray(items) ? items.flatMap((item) => (typeof item === "string" ? [item] : [])) : []

const threadParents = (items: unknown): ReadonlyMap<string, string> => {
  const result = new Map<string, string>()
  if (!Array.isArray(items)) return result
  for (const thread of items) {
    const id = stringField(thread, "id")
    const parentId = stringField(thread, "parent_id")
    if (id !== undefined && parentId !== undefined) result.set(id, parentId)
  }
  return result
}

const fromRawDiscordMessage = (
  scope: DiscordScope,
  data: unknown,
  threadParentById: ReadonlyMap<string, string>
): DiscordMessage | undefined => {
  if (!isRecord(data)) return undefined
  const id = stringField(data, "id")
  const channelId = stringField(data, "channel_id")
  const timestamp = stringField(data, "timestamp")
  const author = data.author
  const authorId = stringField(author, "id")
  if (id === undefined || channelId === undefined || timestamp === undefined || authorId === undefined) return undefined
  const parentId = threadParentById.get(channelId)
  const content = typeof data.content === "string" ? data.content : ""
  const attachments = Array.isArray(data.attachments) ? data.attachments : []
  return {
    id,
    guildId: scope.guildId,
    channelId: parentId ?? channelId,
    ...(parentId === undefined ? {} : { threadId: channelId }),
    author: {
      id: authorId,
      displayName: stringField(author, "global_name") ?? stringField(author, "username") ?? authorId,
      isBot: isRecord(author) && author.bot === true
    },
    content,
    timestamp,
    mentions: rawUserIds(data.mentions),
    roleMentions: rawStringArray(data.mention_roles),
    everyoneMention: data.mention_everyone === true,
    hereMention: content.includes("@here"),
    attachments: attachments.flatMap((item) => {
      const attachment = rawAttachment(item)
      return attachment === undefined ? [] : [attachment]
    }),
    reactions: [],
    channelType: "guild",
    ...(typeof data.type === "number" && data.type !== 0 ? { isSystem: true } : {})
  }
}

const flatSearchMessages = (data: unknown): ReadonlyArray<unknown> => {
  if (!isRecord(data) || !Array.isArray(data.messages)) return []
  return data.messages.flatMap((group) => (Array.isArray(group) ? group : []))
}

const searchTotalResults = (data: unknown): number =>
  isRecord(data) && typeof data.total_results === "number" && Number.isFinite(data.total_results) && data.total_results >= 0
    ? data.total_results
    : 0

const appendAll = (params: URLSearchParams, key: string, values: ReadonlyArray<string>): void => {
  for (const value of values) params.append(key, value)
}

const searchParams = (query: DiscordSearchQuery, limit: number, offset: number): URLSearchParams => {
  const params = new URLSearchParams()
  params.set("limit", String(Math.max(1, Math.min(25, limit))))
  params.set("offset", String(Math.max(0, Math.min(9975, offset))))
  if (query.content !== undefined) params.set("content", query.content)
  if (query.maxId !== undefined) params.set("max_id", query.maxId)
  if (query.minId !== undefined) params.set("min_id", query.minId)
  if (query.slop !== undefined) params.set("slop", String(query.slop))
  if (query.pinned !== undefined) params.set("pinned", String(query.pinned))
  if (query.mentionEveryone !== undefined) params.set("mention_everyone", String(query.mentionEveryone))
  if (query.sortBy !== undefined) params.set("sort_by", query.sortBy)
  if (query.sortOrder !== undefined) params.set("sort_order", query.sortOrder)
  if (query.includeNsfw !== undefined) params.set("include_nsfw", String(query.includeNsfw))
  appendAll(params, "channel_id", query.channels)
  appendAll(params, "author_id", query.authors)
  appendAll(params, "author_type", query.authorTypes)
  appendAll(params, "mentions", query.mentions)
  appendAll(params, "mentions_role_id", query.roleMentions)
  appendAll(params, "replied_to_user_id", query.repliedToUsers)
  appendAll(params, "replied_to_message_id", query.repliedToMessages)
  appendAll(params, "has", query.has)
  appendAll(params, "embed_type", query.embedTypes)
  appendAll(params, "embed_provider", query.embedProviders)
  appendAll(params, "link_hostname", query.linkHostnames)
  appendAll(params, "attachment_filename", query.attachmentFilenames)
  appendAll(params, "attachment_extension", query.attachmentExtensions)
  return params
}

const enrichNicknames = async (
  scope: DiscordScope,
  messages: ReadonlyArray<DiscordMessage>,
  resolveNickname: NicknameResolver
): Promise<ReadonlyArray<DiscordMessage>> => {
  const nicknames = new Map<string, string | undefined>()
  for (const userId of [...new Set(messages.map((message) => message.author.id))]) {
    nicknames.set(userId, await resolveNickname(scope, userId))
  }
  return messages.map((message) => {
    const nickname = nicknames.get(message.author.id)
    return nickname === undefined ? message : { ...message, author: { ...message.author, nickname } }
  })
}

const collectMessages = (scope: DiscordScope, data: unknown): ReadonlyArray<DiscordMessage> => {
  const parents = isRecord(data) ? threadParents(data.threads) : new Map<string, string>()
  const seen = new Set<string>()
  const messages: Array<DiscordMessage> = []
  for (const rawMessage of flatSearchMessages(data)) {
    const message = fromRawDiscordMessage(scope, rawMessage, parents)
    if (message === undefined || seen.has(message.id)) continue
    seen.add(message.id)
    messages.push(message)
  }
  return messages
}

export const searchDiscordMessages = async (
  raw: RawDiscordOptions | undefined,
  scope: DiscordScope,
  query: DiscordSearchQuery,
  paging: { readonly limit: number; readonly offset: number },
  resolveNickname: NicknameResolver
): Promise<DiscordSearchResult> => {
  const resolvedQuery = await resolveSearchQuery(raw, scope, query)
  const params = searchParams(resolvedQuery, paging.limit, paging.offset)
  const data = await rawDiscordSearchRequest(raw, `/guilds/${scope.guildId}/messages/search?${params}`)
  const messages = await enrichNicknames(scope, collectMessages(scope, data), resolveNickname)
  const totalResults = searchTotalResults(data)
  const offset = Math.max(0, Math.min(9975, paging.offset))
  return { totalResults, offset, hasMore: offset + messages.length < totalResults, messages }
}
