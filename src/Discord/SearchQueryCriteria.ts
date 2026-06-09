import type { DiscordSearchQuery } from "../Schema.ts"

export const hasDiscordSearchCriteria = (query: DiscordSearchQuery): boolean => {
  const arrays = [
    query.authors,
    query.authorNames,
    query.authorTypes,
    query.channels,
    query.channelNames,
    query.mentions,
    query.mentionNames,
    query.roleMentions,
    query.repliedToUsers,
    query.repliedToUserNames,
    query.repliedToMessages,
    query.has,
    query.embedTypes,
    query.embedProviders,
    query.linkHostnames,
    query.attachmentFilenames,
    query.attachmentExtensions
  ]
  const scalars = [
    query.content,
    query.maxId,
    query.minId,
    query.slop,
    query.pinned,
    query.mentionEveryone,
    query.includeNsfw,
    query.sortBy,
    query.sortOrder
  ]
  return arrays.some((items) => items.length > 0) || scalars.some((value) => value !== undefined)
}
