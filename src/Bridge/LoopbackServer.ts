import { BunHttpServer } from "@effect/platform-bun"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import type { RuntimeConfig } from "../Config.ts"
import type { DiscordService } from "../Discord/DiscordPort.ts"
import type { DiscordScope, ToolRequest, ToolResponse, TriggerRequest, TriggerResponse } from "../Schema.ts"
import { ToolRequestSchema, ToolResponseSchema, TriggerRequestSchema, TriggerResponseSchema } from "../Schema.ts"
import { handleToolRequest } from "./ToolControl.ts"

export type LoopbackServerOptions = {
  readonly port: number
  readonly config: RuntimeConfig
  readonly projectDir: string
  readonly discord: DiscordService
  readonly getAllowedScopes?: (() => ReadonlyArray<DiscordScope>) | undefined
  readonly startTriggeredTurn?: ((request: TriggerRequest) => Effect.Effect<void, unknown>) | undefined
}

type LoopbackServer = {
  readonly url: string
  readonly port: number
}

type ErrorResponse = { readonly ok: false; readonly error: string }

const invalidRequest = (message: string): ErrorResponse => ({ ok: false, error: message })

const toolFailure = (error: ToolResponse | { readonly message?: unknown }): ToolResponse => {
  if ("ok" in error) return error
  return invalidRequest(typeof error.message === "string" ? error.message : "Discord bridge tool failed")
}

const isTriggerResponse = (value: unknown): value is TriggerResponse =>
  typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean"

const errorMessage = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("message" in value)) return undefined
  return typeof value.message === "string" ? value.message : undefined
}

const triggerFailure = (error: unknown): TriggerResponse => {
  if (isTriggerResponse(error)) return error
  return invalidRequest(errorMessage(error) ?? "Discord trigger failed")
}

const parseJson = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<unknown, ErrorResponse> =>
  request.json.pipe(Effect.mapError(() => invalidRequest("Request body must be valid JSON")))

const parseToolBody = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<ToolRequest, ErrorResponse> =>
  Effect.gen(function* () {
    const body = yield* parseJson(request)
    const decoded = yield* Schema.decodeUnknownEffect(ToolRequestSchema)(body).pipe(
      Effect.mapError(() => invalidRequest("Request body must match the tool contract"))
    )
    return { action: decoded.action, target: decoded.target, args: decoded.args } satisfies ToolRequest
  })

const isDmTarget = (value: string | undefined): boolean => value?.toLowerCase() === "@me" || value?.toLowerCase() === "dm"

const parseTriggerBody = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<TriggerRequest, ErrorResponse> =>
  Effect.gen(function* () {
    const body = yield* parseJson(request)
    const decoded = yield* Schema.decodeUnknownEffect(TriggerRequestSchema)(body).pipe(
      Effect.mapError(() => invalidRequest("Request body must match the trigger contract"))
    )
    if (decoded.guildId.trim() === "" || decoded.channelId.trim() === "") {
      return yield* Effect.fail(invalidRequest("Discord target must include guildId and channelId"))
    }
    if ([decoded.guildId, decoded.channelId, decoded.threadId].some(isDmTarget)) {
      return yield* Effect.fail(invalidRequest("Discord DMs are not supported"))
    }
    if (decoded.prompt.trim() === "") return yield* Effect.fail(invalidRequest("Trigger prompt must not be empty"))

    return {
      guildId: decoded.guildId,
      channelId: decoded.channelId,
      prompt: decoded.prompt,
      ...(decoded.threadId === undefined ? {} : { threadId: decoded.threadId }),
      ...(decoded.model === undefined ? {} : { model: decoded.model }),
      ...(decoded.agent === undefined ? {} : { agent: decoded.agent }),
      ...(decoded.name === undefined ? {} : { name: decoded.name })
    } satisfies TriggerRequest
  })

class ToolApiGroup extends HttpApiGroup.make("tool").add(HttpApiEndpoint.post("handleTool", "/tool", { success: ToolResponseSchema })) {}

class TriggerApiGroup extends HttpApiGroup.make("trigger").add(
  HttpApiEndpoint.post("handleTrigger", "/trigger", { success: TriggerResponseSchema })
) {}

class BridgeApi extends HttpApi.make("opencode-discord-bot-bridge").add(ToolApiGroup).add(TriggerApiGroup) {}

const toolApiLayer = (options: LoopbackServerOptions) =>
  HttpApiBuilder.group(BridgeApi, "tool", (handlers) =>
    handlers.handleRaw("handleTool", ({ request }) =>
      Effect.gen(function* () {
        const toolRequest = yield* parseToolBody(request)
        return yield* handleToolRequest(toolRequest, options.config, options.projectDir, options.discord, {
          allowedScopes: options.getAllowedScopes?.() ?? []
        })
      }).pipe(Effect.catch((error) => Effect.succeed(toolFailure(error))))
    )
  )

const triggerApiLayer = (options: LoopbackServerOptions) =>
  HttpApiBuilder.group(BridgeApi, "trigger", (handlers) =>
    handlers.handleRaw("handleTrigger", ({ request }) =>
      Effect.gen(function* () {
        const triggerRequest = yield* parseTriggerBody(request)
        if (options.startTriggeredTurn === undefined) return HttpServerResponse.jsonUnsafe(invalidRequest("Triggers are not enabled"))
        yield* options.startTriggeredTurn(triggerRequest)
        return HttpServerResponse.jsonUnsafe({ ok: true, accepted: true } satisfies TriggerResponse, { status: 202 })
      }).pipe(Effect.catch((error) => Effect.succeed(HttpServerResponse.jsonUnsafe(triggerFailure(error)))))
    )
  )

const httpLayer = (options: LoopbackServerOptions) =>
  HttpRouter.serve(Layer.provide(HttpApiBuilder.layer(BridgeApi), [toolApiLayer(options), triggerApiLayer(options)]), {
    disableListenLog: true,
    disableLogger: true
  }).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({
        hostname: "127.0.0.1",
        port: options.port
      })
    )
  )

export const startLoopbackServer = Effect.fn("startLoopbackServer")(function* (options: LoopbackServerOptions) {
  const context = yield* Layer.build(httpLayer(options))
  const server = Context.get(context, HttpServer.HttpServer)

  const port = server.address._tag === "TcpAddress" ? server.address.port : options.port
  return { url: `http://127.0.0.1:${port}`, port } satisfies LoopbackServer
})
