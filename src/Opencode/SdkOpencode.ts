import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { type Cause, Data, Effect, Fiber, Queue, Stream } from "effect"
import type { DiscordScope, OpencodeEvent } from "../Schema.ts"
import { opencodeEventStream } from "./EventMapping.ts"
import { OpencodeError, type OpencodePrompt, type OpencodeService } from "./OpencodePort.ts"
import { preparePromptParts } from "./PromptParts.ts"

type RequestMetadata = {
  readonly request?: Request
  readonly response?: Response | undefined
}

type RequestResult = Promise<
  | ({ readonly data: unknown; readonly error: undefined } & RequestMetadata)
  | ({ readonly data: undefined; readonly error: unknown } & RequestMetadata)
>

type SseResult = Promise<{ readonly stream: AsyncIterable<unknown> }>

type CreateSessionParameters = {
  readonly directory?: string
  readonly agent?: string
  readonly model?: {
    readonly id: string
    readonly providerID: string
    readonly variant?: string
  }
}

type PromptParameters = {
  readonly sessionID: string
  readonly directory?: string
  readonly agent?: string
  readonly model?: {
    readonly providerID: string
    readonly modelID: string
  }
  readonly parts: Array<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "file"; readonly mime: string; readonly filename?: string; readonly url: string }
  >
}

type AbortParameters = {
  readonly sessionID: string
  readonly directory?: string
}

type SubscribeParameters = {
  readonly directory?: string
}

type SdkClient = {
  readonly session: {
    readonly create: (parameters?: CreateSessionParameters) => RequestResult
    readonly promptAsync: (parameters: PromptParameters) => RequestResult
    readonly abort: (parameters: AbortParameters) => RequestResult
  }
  readonly event: {
    readonly subscribe: (parameters?: SubscribeParameters) => SseResult
  }
  readonly global: {
    readonly health: () => RequestResult
  }
}

type SdkOptions = {
  readonly baseUrl: string
  readonly projectDir: string
}

class SdkFailure extends Data.TaggedError("SdkFailure")<{
  readonly message: string
}> {}

const scopeKey = (scope: DiscordScope): string => scope.threadId ?? scope.channelId

const dataId = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("id" in value)) return undefined
  return typeof value.id === "string" ? value.id : undefined
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

const withErrorName = (name: string | undefined, message: string | undefined): string | undefined => {
  if (message === undefined || message.length === 0) return name
  return name === undefined || name.length === 0 ? message : `${name}: ${message}`
}

const recordSdkErrorText = (value: Readonly<Record<string, unknown>>): string | undefined => {
  const name = stringField(value, "name") ?? stringField(value, "_tag")
  const data = value.data
  if (isRecord(data)) {
    const message = stringField(data, "message")
    const text = withErrorName(name, message)
    if (text !== undefined) return text
  }

  const message = stringField(value, "message")
  const text = withErrorName(name, message)
  if (text !== undefined) return text

  const nestedError = sdkErrorText(value.error)
  if (nestedError !== undefined) return nestedError

  if (isRecord(value.cause)) {
    const bodyError = sdkErrorText(value.cause.body)
    if (bodyError !== undefined) return bodyError
  }

  return undefined
}

const sdkErrorText = (value: unknown): string | undefined => {
  if (value instanceof Error) return value.message.length > 0 ? value.message : sdkErrorText(value.cause)
  if (typeof value === "string") return value.length > 0 ? value : undefined
  return isRecord(value) ? recordSdkErrorText(value) : undefined
}

const requestPath = (request: Request): string => {
  try {
    return new URL(request.url).pathname
  } catch {
    return request.url
  }
}

const requestFailureText = (metadata: RequestMetadata): string | undefined => {
  const { request, response } = metadata
  if (request === undefined && response === undefined) return undefined
  const target = request === undefined ? "opencode server request" : `${request.method} ${requestPath(request)}`
  if (response === undefined) return `${target} failed before receiving a response`
  const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : ""
  return `${target} returned ${response.status}${statusText}`
}

const errorText = (value: unknown, metadata: RequestMetadata = {}): string =>
  sdkErrorText(value) ?? requestFailureText(metadata) ?? "opencode SDK request failed"

const modelFromConfig = (value: string | undefined): { readonly providerID: string; readonly modelID: string } | undefined => {
  if (value === undefined) return undefined
  const slash = value.indexOf("/")
  const colon = value.indexOf(":")
  const separator = slash >= 0 ? slash : colon
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}

const sessionIdFromRecord = (value: Readonly<Record<string, unknown>>, depth: number): string | undefined => {
  const direct = stringField(value, "sessionID") ?? stringField(value, "sessionId")
  if (direct !== undefined) return direct
  if (depth <= 0) return undefined
  const properties = ["payload", "properties", "session", "message", "part"] as const
  for (const property of properties) {
    const nested = value[property]
    if (!isRecord(nested)) continue
    const nestedId = sessionIdFromRecord(nested, depth - 1)
    if (nestedId !== undefined) return nestedId
  }
  return undefined
}

const sessionIdFromEvent = (value: unknown): string | undefined => (isRecord(value) ? sessionIdFromRecord(value, 3) : undefined)

const belongsToSession =
  (sessionID: string) =>
  (value: unknown): boolean => {
    const eventSessionID = sessionIdFromEvent(value)
    return eventSessionID === undefined || eventSessionID === sessionID
  }

const request = Effect.fn("opencodeSdkRequest")(function* (value: RequestResult) {
  const result = yield* Effect.tryPromise({
    try: () => value,
    catch: (cause) => new SdkFailure({ message: errorText(cause) })
  })
  if (result.error !== undefined) return yield* Effect.fail(new SdkFailure({ message: errorText(result.error, result) }))
  return result.data
})

const createSession = Effect.fn("createOpencodeSession")(function* (client: SdkClient, input: OpencodePrompt) {
  const model = modelFromConfig(input.model)
  const data = yield* request(
    client.session.create({
      directory: input.projectDir,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(model === undefined ? {} : { model: { id: model.modelID, providerID: model.providerID } })
    })
  )
  const id = dataId(data)
  if (id === undefined) return yield* Effect.fail(new SdkFailure({ message: "opencode session create did not return an id" }))
  return id
})

export const makeSdkOpencode = (client: SdkClient, options: SdkOptions): OpencodeService => {
  const activeSessions = new Map<string, string>()

  const runPrompt = (input: OpencodePrompt): Stream.Stream<OpencodeEvent, OpencodeError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const parts = yield* preparePromptParts(input.parts).pipe(Effect.mapError((error) => new SdkFailure({ message: error.message })))
        const key = scopeKey(input.scope)
        const model = modelFromConfig(input.model)
        const sse = yield* Effect.tryPromise({
          try: () => client.event.subscribe({ directory: input.projectDir }),
          catch: (cause) => new SdkFailure({ message: errorText(cause) })
        })
        const queue = yield* Queue.unbounded<unknown, OpencodeError | Cause.Done>()
        const reader = yield* Stream.fromAsyncIterable(sse.stream, (cause) => new OpencodeError({ message: errorText(cause) }))
          .pipe(
            Stream.runForEach((event) => Queue.offer(queue, event).pipe(Effect.asVoid)),
            Effect.catch((error) => Queue.fail(queue, error).pipe(Effect.asVoid)),
            Effect.ensuring(Queue.end(queue).pipe(Effect.asVoid))
          )
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        const sessionID = yield* createSession(client, input)
        activeSessions.set(key, sessionID)
        yield* request(
          client.session.promptAsync({
            sessionID,
            directory: input.projectDir,
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            ...(model === undefined ? {} : { model }),
            parts: [{ type: "text", text: input.prompt }, ...parts]
          })
        )
        return opencodeEventStream(Stream.fromQueue(queue).pipe(Stream.filter(belongsToSession(sessionID)))).pipe(
          Stream.takeUntil((event) => event.type === "idle" || event.type === "error"),
          Stream.ensuring(
            Effect.gen(function* () {
              yield* Fiber.interrupt(reader).pipe(Effect.catch(() => Effect.void))
              yield* Queue.shutdown(queue).pipe(Effect.catch(() => Effect.void))
              yield* Effect.sync(() => activeSessions.delete(key))
            })
          )
        )
      }).pipe(Effect.mapError((error) => new OpencodeError({ message: error.message })))
    )

  const abort = (scope: DiscordScope): Stream.Stream<never, OpencodeError> => {
    const sessionID = activeSessions.get(scopeKey(scope))
    if (sessionID === undefined) return Stream.empty
    activeSessions.delete(scopeKey(scope))
    return Stream.fromEffect(
      request(client.session.abort({ sessionID, directory: options.projectDir })).pipe(
        Effect.mapError((error) => new OpencodeError({ message: error.message })),
        Effect.asVoid
      )
    ).pipe(Stream.drain)
  }

  const checkHealth = Effect.suspend(() =>
    request(client.global.health()).pipe(
      Effect.mapError((error) => new OpencodeError({ message: error.message })),
      Effect.asVoid
    )
  )

  return { runPrompt, abort, checkHealth }
}

export const makeLiveSdkOpencode = (options: SdkOptions): OpencodeService =>
  makeSdkOpencode(createOpencodeClient({ baseUrl: options.baseUrl, directory: options.projectDir }), options)
