import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"
import { Effect } from "effect"
import type { RuntimeConfig, ToolConfig } from "../Config.ts"
import type { DiscordService } from "../Discord/DiscordPort.ts"
import { sanitizeDiscordContent } from "../Discord/Safety.ts"
import type { DiscordScope, ToolRequest, ToolResponse } from "../Schema.ts"

type ToolRequestOptions = {
  readonly allowedScopes?: ReadonlyArray<DiscordScope> | undefined
  readonly botId?: string | undefined
}

const actionFlag = (action: string): keyof ToolConfig | undefined => {
  switch (action) {
    case "addReaction":
    case "removeReaction":
      return "reactions"
    case "attachFile":
      return "attachFiles"
    case "fetchHistory":
      return "fetchHistory"
    case "createThread":
      return "createThread"
    case "editOwnMessage":
    case "deleteOwnMessage":
      return "editDeleteOwn"
    case "pin":
    case "unpin":
      return "pin"
    default:
      return undefined
  }
}

const scopeFromRequest = (request: ToolRequest): DiscordScope | string => {
  const { guildId, channelId, threadId } = request.target
  if (guildId === undefined || channelId === undefined) return "Discord target must include guildId and channelId"
  const values = [guildId, channelId, threadId]
  if (values.some((value) => value?.toLowerCase() === "@me" || value?.toLowerCase() === "dm")) {
    return "Discord DMs are not supported"
  }
  return { guildId, channelId, ...(threadId === undefined ? {} : { threadId }) }
}

const scopeKey = (scope: DiscordScope): string => `${scope.guildId}:${scope.channelId}:${scope.threadId ?? ""}`

const isAllowedScope = (scope: DiscordScope, allowedScopes: ReadonlyArray<DiscordScope> | undefined): boolean =>
  allowedScopes === undefined || allowedScopes.some((allowed) => scopeKey(allowed) === scopeKey(scope))

const stringArg = (request: ToolRequest, key: string): string | undefined => {
  const value = request.args[key]
  return typeof value === "string" ? value : undefined
}

const attachmentPath = Effect.fn("attachmentPath")(function* (projectDir: string, input: string, maxBytes: number) {
  if (isAbsolute(input) || input.includes(".."))
    return { ok: false, error: "Attachment path must stay inside the project directory" } satisfies ToolResponse
  const project = yield* Effect.tryPromise(() => realpath(projectDir)).pipe(Effect.catch(() => Effect.succeed(resolve(projectDir))))
  const target = resolve(project, input)
  const actual = yield* Effect.tryPromise(() => realpath(target)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (actual === undefined || !(actual === project || actual.startsWith(`${project}${sep}`))) {
    return { ok: false, error: "Attachment path must stay inside the project directory" } satisfies ToolResponse
  }
  const stat = yield* Effect.tryPromise(() => lstat(actual)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (stat === undefined || !stat.isFile()) return { ok: false, error: "Attachment path must be a readable file" } satisfies ToolResponse
  if (stat.size > maxBytes) return { ok: false, error: "Attachment exceeds the configured size limit" } satisfies ToolResponse
  return actual
})

const disabled = (action: string): ToolResponse => ({ ok: false, error: `Action ${action} is disabled` })

const reaction = Effect.fn("toolReaction")(function* (
  request: ToolRequest,
  scope: DiscordScope,
  discord: DiscordService,
  operation: "add" | "remove"
) {
  const messageId = request.target.messageId
  const emoji = stringArg(request, "emoji")
  if (messageId === undefined || emoji === undefined) return { ok: false, error: "messageId and emoji are required" } satisfies ToolResponse
  if (operation === "add") {
    yield* discord.addReaction(scope, messageId, emoji)
    return { ok: true, result: { reacted: true } } satisfies ToolResponse
  }
  yield* discord.removeReaction(scope, messageId, emoji)
  return { ok: true, result: { reacted: false } } satisfies ToolResponse
})

const fetchHistory = Effect.fn("toolFetchHistory")(function* (
  request: ToolRequest,
  scope: DiscordScope,
  config: RuntimeConfig,
  discord: DiscordService
) {
  const limit = typeof request.args.limit === "number" ? request.args.limit : config.context.messages
  const result = yield* discord.fetchHistory(scope, limit)
  return { ok: true, result } satisfies ToolResponse
})

const attachFile = Effect.fn("toolAttachFile")(function* (
  request: ToolRequest,
  scope: DiscordScope,
  config: RuntimeConfig,
  projectDir: string,
  discord: DiscordService
) {
  const path = stringArg(request, "path")
  if (path === undefined) return { ok: false, error: "path is required" } satisfies ToolResponse
  const safePath = yield* attachmentPath(projectDir, path, config.context.attachmentMaxBytes)
  if (typeof safePath !== "string") return safePath
  const result = yield* discord.attachFile(scope, safePath)
  return { ok: true, result } satisfies ToolResponse
})

const createThread = Effect.fn("toolCreateThread")(function* (request: ToolRequest, scope: DiscordScope, discord: DiscordService) {
  const name = stringArg(request, "name")
  if (name === undefined || name.trim() === "") return { ok: false, error: "name is required" } satisfies ToolResponse
  const result = yield* discord.createThread(scope, name)
  return { ok: true, result } satisfies ToolResponse
})

const ensureOwnMessage = Effect.fn("ensureOwnDiscordMessage")(function* (
  messageId: string,
  scope: DiscordScope,
  config: RuntimeConfig,
  discord: DiscordService,
  options: ToolRequestOptions
) {
  if (options.botId === undefined) return "Bot identity is required to edit or delete bot-authored messages"
  const history = yield* discord.fetchHistory(scope, config.context.messages)
  const message = history.find((item) => item.id === messageId)
  if (message?.author.id !== options.botId) return "messageId must refer to a bot-authored message"
  return undefined
})

const editOwnMessage = Effect.fn("toolEditOwnMessage")(function* (
  request: ToolRequest,
  scope: DiscordScope,
  config: RuntimeConfig,
  discord: DiscordService,
  options: ToolRequestOptions
) {
  const messageId = request.target.messageId
  const content = stringArg(request, "content")
  if (messageId === undefined || content === undefined || content.trim() === "") {
    return { ok: false, error: "messageId and content are required" } satisfies ToolResponse
  }
  const ownMessageError = yield* ensureOwnMessage(messageId, scope, config, discord, options)
  if (ownMessageError !== undefined) return { ok: false, error: ownMessageError } satisfies ToolResponse
  yield* discord.editMessage(scope, messageId, sanitizeDiscordContent(content, config.guards))
  return { ok: true, result: { edited: true } } satisfies ToolResponse
})

const deleteOwnMessage = Effect.fn("toolDeleteOwnMessage")(function* (
  request: ToolRequest,
  scope: DiscordScope,
  config: RuntimeConfig,
  discord: DiscordService,
  options: ToolRequestOptions
) {
  const messageId = request.target.messageId
  if (messageId === undefined) return { ok: false, error: "messageId is required" } satisfies ToolResponse
  const ownMessageError = yield* ensureOwnMessage(messageId, scope, config, discord, options)
  if (ownMessageError !== undefined) return { ok: false, error: ownMessageError } satisfies ToolResponse
  yield* discord.deleteMessage(scope, messageId)
  return { ok: true, result: { deleted: true } } satisfies ToolResponse
})

const pin = Effect.fn("toolPin")(function* (
  request: ToolRequest,
  scope: DiscordScope,
  discord: DiscordService,
  operation: "pin" | "unpin"
) {
  const messageId = request.target.messageId
  if (messageId === undefined) return { ok: false, error: "messageId is required" } satisfies ToolResponse
  if (operation === "pin") {
    yield* discord.pinMessage(scope, messageId)
    return { ok: true, result: { pinned: true } } satisfies ToolResponse
  }
  yield* discord.unpinMessage(scope, messageId)
  return { ok: true, result: { pinned: false } } satisfies ToolResponse
})

export const handleToolRequest = Effect.fn("handleToolRequest")(function* (
  request: ToolRequest,
  config: RuntimeConfig,
  projectDir: string,
  discord: DiscordService,
  options: ToolRequestOptions = {}
) {
  if (!config.tools.enabled) return { ok: false, error: "Discord bridge tools are disabled" } satisfies ToolResponse
  const flag = actionFlag(request.action)
  if (flag === undefined) return { ok: false, error: `Unknown action ${request.action}` } satisfies ToolResponse
  if (!config.tools[flag]) return disabled(request.action)

  const scope = scopeFromRequest(request)
  if (typeof scope === "string") return { ok: false, error: scope } satisfies ToolResponse
  if (!isAllowedScope(scope, options.allowedScopes)) {
    return { ok: false, error: "Discord target is outside the active turn scope" } satisfies ToolResponse
  }

  switch (request.action) {
    case "addReaction":
      return yield* reaction(request, scope, discord, "add")
    case "removeReaction":
      return yield* reaction(request, scope, discord, "remove")
    case "fetchHistory":
      return yield* fetchHistory(request, scope, config, discord)
    case "attachFile":
      return yield* attachFile(request, scope, config, projectDir, discord)
    case "createThread":
      return yield* createThread(request, scope, discord)
    case "editOwnMessage":
      return yield* editOwnMessage(request, scope, config, discord, options)
    case "deleteOwnMessage":
      return yield* deleteOwnMessage(request, scope, config, discord, options)
    case "pin":
      return yield* pin(request, scope, discord, "pin")
    case "unpin":
      return yield* pin(request, scope, discord, "unpin")
  }
  return { ok: false, error: `Unknown action ${request.action}` } satisfies ToolResponse
})
