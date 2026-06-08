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
  let answer = ""
  let changed: string | undefined
  const posted: Array<PostedChunk> = []
  const updateIntervalMs = Math.max(0, Duration.toMillis(config.streaming.updateInterval))
  let lastFlushAt = Number.NEGATIVE_INFINITY
  let typingFiber: Fiber.Fiber<void, never> | undefined
  let status: PostedChunk | undefined
  let finished = false

  const visibleContent = () => sanitizeDiscordContent(changed === undefined ? answer : `${answer}\n\n${changed}`.trim(), config.guards)
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
  const writeChunk = Effect.fn("writeDiscordRenderChunk")(function* (index: number, chunk: string, forceEdit = false) {
    const existing = posted[index]
    if (existing === undefined) {
      const created = yield* retryDiscord(discord.postMessage(scope, chunk))
      posted.push({ id: created.id, content: chunk })
    } else if (forceEdit || existing.content !== chunk) {
      yield* retryDiscord(discord.editMessage(scope, existing.id, chunk))
      existing.content = chunk
    }
  })
  const flush = Effect.fn("flushDiscordRender")(function* (force = false, forceEdit = false) {
    const chunks = splitDiscordMarkdown(visibleContent())
    if (chunks.length === 0) return
    const now = yield* Clock.currentTimeMillis
    if (!force && posted.length > 0 && now - lastFlushAt < updateIntervalMs) return
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      if (chunk === undefined) continue
      yield* writeChunk(index, chunk, forceEdit)
    }
    for (let index = posted.length - 1; index >= chunks.length; index -= 1) {
      const stale = posted[index]
      if (stale === undefined) continue
      yield* retryDiscord(discord.deleteMessage(scope, stale.id))
      posted.splice(index, 1)
    }
    lastFlushAt = now
  })
  const finish = Effect.fn("finishDiscordRender")(function* () {
    if (finished) return
    finished = true
    const wasTyping = yield* stopTyping()
    yield* flush(true, wasTyping)
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
            case "idle": {
              yield* finish()
              break
            }
            case "text-delta": {
              yield* stopTyping()
              answer += event.text
              yield* flush(posted.length === 0)
              break
            }
            case "text-snapshot": {
              yield* stopTyping()
              answer = event.text
              yield* flush(true)
              break
            }
            case "changed-files": {
              if (config.streaming.changedFilesSummary && hasChangedFiles(event)) {
                changed = changedSummary(event)
                yield* flush(true)
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
