import { BunHttpServer } from "@effect/platform-bun"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer, type HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import type { RuntimeConfig } from "../Config.ts"
import type { DiscordService } from "../Discord/DiscordPort.ts"
import type { DiscordScope, ToolRequest, ToolResponse } from "../Schema.ts"
import { ToolRequestSchema, ToolResponseSchema } from "../Schema.ts"
import { handleToolRequest } from "./ToolControl.ts"

export type LoopbackServerOptions = {
  readonly port: number
  readonly config: RuntimeConfig
  readonly projectDir: string
  readonly discord: DiscordService
  readonly getAllowedScopes?: (() => ReadonlyArray<DiscordScope>) | undefined
  readonly botId?: string | undefined
}

type LoopbackServer = {
  readonly url: string
  readonly port: number
}

const invalidRequest = (message: string): ToolResponse => ({ ok: false, error: message })

const toolFailure = (error: ToolResponse | { readonly message?: unknown }): ToolResponse => {
  if ("ok" in error) return error
  return invalidRequest(typeof error.message === "string" ? error.message : "Discord bridge tool failed")
}

const parseBody = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<ToolRequest, ToolResponse> =>
  Effect.gen(function* () {
    const body = yield* request.json.pipe(Effect.mapError(() => invalidRequest("Request body must be valid JSON")))
    const decoded = yield* Schema.decodeUnknownEffect(ToolRequestSchema)(body).pipe(
      Effect.mapError(() => invalidRequest("Request body must match the tool contract"))
    )
    return { action: decoded.action, target: decoded.target, args: decoded.args } satisfies ToolRequest
  })

class ToolApiGroup extends HttpApiGroup.make("tool").add(HttpApiEndpoint.post("handleTool", "/tool", { success: ToolResponseSchema })) {}

class ToolApi extends HttpApi.make("opencode-discord-bot-tools").add(ToolApiGroup) {}

const toolApiLayer = (options: LoopbackServerOptions) =>
  HttpApiBuilder.group(ToolApi, "tool", (handlers) =>
    handlers.handleRaw("handleTool", ({ request }) =>
      Effect.gen(function* () {
        const toolRequest = yield* parseBody(request)
        return yield* handleToolRequest(toolRequest, options.config, options.projectDir, options.discord, {
          allowedScopes: options.getAllowedScopes?.() ?? [],
          botId: options.botId
        })
      }).pipe(Effect.catch((error) => Effect.succeed(toolFailure(error))))
    )
  )

const httpLayer = (options: LoopbackServerOptions) =>
  HttpRouter.serve(Layer.provide(HttpApiBuilder.layer(ToolApi), toolApiLayer(options)), {
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
