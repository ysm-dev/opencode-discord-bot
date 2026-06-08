import { Cause, Clock, Duration, Effect, Fiber, Schedule, Stream } from "effect"
import type { RuntimeConfig } from "../Config.ts"
import type { DiscordError, DiscordService } from "../Discord/DiscordPort.ts"
import { sanitizeDiscordContent } from "../Discord/Safety.ts"
import { OpencodeError } from "../Opencode/OpencodePort.ts"
import type { DiscordScope, OpencodeEvent } from "../Schema.ts"
import { splitDiscordMarkdown } from "./Splitting.ts"

const changedSummary = (event: Extract<OpencodeEvent, { readonly type: "changed-files" }>) =>
  `Changed: ${event.files} files (+${event.insertions}/-${event.deletions})`

const hasChangedFiles = (event: Extract<OpencodeEvent, { readonly type: "changed-files" }>): boolean =>
  event.files > 0 || event.insertions > 0 || event.deletions > 0

type PostedChunk = {
  readonly id: string
  content: string
}

type RenderSegment = {
  readonly id: string | undefined
  text: string
  readonly posted: Array<PostedChunk>
}

const discordRetrySchedule = Schedule.fromStepWithMetadata(
  Effect.succeed((metadata: Schedule.InputMetadata<DiscordError>) => {
    if (metadata.attempt > 2) return Cause.done(metadata.attempt)
    const fallback = Duration.millis(250 * 2 ** (metadata.attempt - 1))
    return Effect.succeed([metadata.attempt, metadata.input.retryAfter ?? fallback] as [number, Duration.Duration])
  })
)

const retryDiscord = <A, R>(effect: Effect.Effect<A, DiscordError, R>): Effect.Effect<A, DiscordError, R> =>
  effect.pipe(Effect.retry(discordRetrySchedule))

export const renderOpencodeEvents = Effect.fn("renderOpencodeEvents")(function* (
  events: Stream.Stream<OpencodeEvent, OpencodeError>,
  scope: DiscordScope,
  config: RuntimeConfig,
  discord: DiscordService
) {
  let changed: string | undefined
  const segments: Array<RenderSegment> = []
  const segmentsById = new Map<string, RenderSegment>()
  const updateIntervalMs = Math.max(0, Duration.toMillis(config.streaming.updateInterval))
  let lastFlushAt = Number.NEGATIVE_INFINITY
  let typingFiber: Fiber.Fiber<void, never> | undefined
  let status: PostedChunk | undefined
  let finished = false

  const lastSegment = (): RenderSegment | undefined => segments[segments.length - 1]
  const createSegment = (id: string | undefined): RenderSegment => {
    const segment: RenderSegment = { id, text: "", posted: [] }
    segments.push(segment)
    if (id !== undefined) segmentsById.set(id, segment)
    return segment
  }
  const getSegment = (id: string | undefined): RenderSegment => {
    if (id !== undefined) return segmentsById.get(id) ?? createSegment(id)
    const last = lastSegment()
    return last !== undefined && last.id === undefined ? last : createSegment(undefined)
  }
  const visibleContent = (segment: RenderSegment) => {
    const text = changed === undefined || lastSegment() !== segment ? segment.text : `${segment.text}\n\n${changed}`.trim()
    return sanitizeDiscordContent(text, config.guards)
  }
  const startTyping = Effect.fn("startDiscordTyping")(function* () {
    if (typingFiber !== undefined) return
    yield* retryDiscord(discord.sendTyping(scope)).pipe(Effect.catch(() => Effect.void))
    typingFiber = yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.seconds(8))
        yield* retryDiscord(discord.sendTyping(scope)).pipe(Effect.catch(() => Effect.void))
      })
    ).pipe(Effect.forkChild({ startImmediately: true }))
  })
  const stopTyping = Effect.fn("stopDiscordTyping")(function* () {
    const fiber = typingFiber
    typingFiber = undefined
    if (fiber === undefined) return false
    yield* Fiber.interrupt(fiber).pipe(Effect.catch(() => Effect.void))
    return true
  })
  const renderStatus = Effect.fn("renderDiscordToolStatus")(function* (content: string) {
    if (!config.streaming.showToolStatus) return
    const safe = sanitizeDiscordContent(content, config.guards)
    if (status === undefined) {
      const created = yield* retryDiscord(discord.postMessage(scope, safe))
      status = { id: created.id, content: safe }
    } else if (status.content !== safe) {
      yield* retryDiscord(discord.editMessage(scope, status.id, safe))
      status.content = safe
    }
  })
  const writeChunk = Effect.fn("writeDiscordRenderChunk")(function* (
    segment: RenderSegment,
    index: number,
    chunk: string,
    forceEdit = false
  ) {
    const existing = segment.posted[index]
    if (existing === undefined) {
      const created = yield* retryDiscord(discord.postMessage(scope, chunk))
      segment.posted.push({ id: created.id, content: chunk })
    } else if (forceEdit || existing.content !== chunk) {
      yield* retryDiscord(discord.editMessage(scope, existing.id, chunk))
      existing.content = chunk
    }
  })
  const flushSegment = Effect.fn("flushDiscordRenderSegment")(function* (segment: RenderSegment, force = false, forceEdit = false) {
    const chunks = splitDiscordMarkdown(visibleContent(segment))
    if (chunks.length === 0) return
    const now = yield* Clock.currentTimeMillis
    if (!force && segment.posted.length > 0 && now - lastFlushAt < updateIntervalMs) return
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      if (chunk === undefined) continue
      yield* writeChunk(segment, index, chunk, forceEdit)
    }
    for (let index = segment.posted.length - 1; index >= chunks.length; index -= 1) {
      const stale = segment.posted[index]
      if (stale === undefined) continue
      yield* retryDiscord(discord.deleteMessage(scope, stale.id))
      segment.posted.splice(index, 1)
    }
    lastFlushAt = now
  })
  const prepareSegment = Effect.fn("prepareDiscordTextSegment")(function* (id: string | undefined) {
    const previousLast = lastSegment()
    const segment = getSegment(id)
    if (changed !== undefined && previousLast !== undefined && previousLast !== segment) yield* flushSegment(previousLast, true)
    return segment
  })
  const flushLastSegment = Effect.fn("flushLastDiscordRenderSegment")(function* (force = false, forceEdit = false) {
    const segment = lastSegment()
    if (segment === undefined) return
    yield* flushSegment(segment, force, forceEdit)
  })
  const finish = Effect.fn("finishDiscordRender")(function* () {
    if (finished) return
    finished = true
    const wasTyping = yield* stopTyping()
    yield* flushLastSegment(true, wasTyping)
  })

  yield* startTyping()
  yield* events
    .pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          switch (event.type) {
            case "tool-start": {
              yield* startTyping()
              yield* renderStatus(`${event.title}...`)
              break
            }
            case "tool-end": {
              yield* renderStatus("Tool finished.")
              break
            }
            case "reasoning-start": {
              yield* startTyping()
              break
            }
            case "idle": {
              yield* finish()
              break
            }
            case "text-delta": {
              yield* stopTyping()
              const segment = yield* prepareSegment(event.id)
              segment.text += event.text
              yield* flushSegment(segment, segment.posted.length === 0)
              break
            }
            case "text-snapshot": {
              yield* stopTyping()
              const segment = yield* prepareSegment(event.id)
              segment.text = event.text
              yield* flushSegment(segment, true)
              break
            }
            case "changed-files": {
              if (config.streaming.changedFilesSummary && hasChangedFiles(event)) {
                changed = changedSummary(event)
                yield* flushSegment(lastSegment() ?? createSegment(undefined), true)
              }
              break
            }
            case "error": {
              yield* stopTyping()
              return yield* Effect.fail(new OpencodeError({ message: event.message }))
            }
          }
        })
      )
    )
    .pipe(Effect.ensuring(stopTyping()))

  yield* finish()
})
