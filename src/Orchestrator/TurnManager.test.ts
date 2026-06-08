import { describe, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Ref, Stream } from "effect"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { makeMemoryOpencode } from "../Opencode/MemoryOpencode.ts"
import { OpencodeError, type OpencodeService } from "../Opencode/OpencodePort.ts"
import type { DiscordScope } from "../Schema.ts"
import { createTurnManager } from "./TurnManager.ts"

const channelScope: DiscordScope = { guildId: "g1", channelId: "c1" }
const threadScope: DiscordScope = { guildId: "g1", channelId: "c1", threadId: "t1" }

describe("TurnManager", () => {
  test("serializes work per Discord scope and allows different scopes in parallel", async () => {
    const order = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = createTurnManager(makeMemoryOpencode([]), makeMemoryDiscord())
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const seen = yield* Ref.make<ReadonlyArray<string>>([])

        const first = yield* manager
          .runExclusive(
            channelScope,
            Effect.gen(function* () {
              yield* Ref.update(seen, (values) => [...values, "same-1-start"])
              yield* Deferred.succeed(firstStarted, void 0)
              yield* Deferred.await(releaseFirst)
              yield* Ref.update(seen, (values) => [...values, "same-1-end"])
            })
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(firstStarted)
        const second = yield* manager
          .runExclusive(
            channelScope,
            Ref.update(seen, (values) => [...values, "same-2"])
          )
          .pipe(Effect.forkChild)
        const parallel = yield* manager
          .runExclusive(
            threadScope,
            Ref.update(seen, (values) => [...values, "other-scope"])
          )
          .pipe(Effect.forkChild)

        yield* Fiber.join(parallel)
        expect(yield* Ref.get(seen)).toEqual(["same-1-start", "other-scope"])

        yield* Deferred.succeed(releaseFirst, void 0)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        return yield* Ref.get(seen)
      })
    )

    expect(order).toEqual(["same-1-start", "other-scope", "same-1-end", "same-2"])
  })

  test("/stop interrupts the active turn fiber, calls opencode abort, and clears transient state", async () => {
    const opencode = makeMemoryOpencode([])
    const manager = createTurnManager(opencode, makeMemoryDiscord())

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finalizerRan = yield* Ref.make(false)
        const fiber = yield* manager.startTurn(
          channelScope,
          "session-1",
          Effect.gen(function* () {
            yield* Deferred.succeed(started, void 0)
            yield* Effect.never
          }).pipe(Effect.ensuring(Ref.set(finalizerRan, true)))
        )

        yield* Deferred.await(started)
        expect(yield* manager.isActive(channelScope)).toBe(true)
        const stop = yield* manager.stop(channelScope)
        yield* Fiber.await(fiber)
        return { stop, finalizerRan: yield* Ref.get(finalizerRan), active: yield* manager.isActive(channelScope) }
      })
    )

    expect(result).toEqual({ stop: { stopped: true }, finalizerRan: true, active: false })
    expect(opencode.aborted).toEqual(["c1"])
  })

  test("clears active turns that finish before callers can stop them", async () => {
    const opencode = makeMemoryOpencode([])
    const manager = createTurnManager(opencode, makeMemoryDiscord())

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* manager.startTurn(channelScope, "session-1", Effect.void)
        yield* Fiber.join(fiber)
        expect(yield* manager.isActive(channelScope)).toBe(false)
      })
    )

    expect(opencode.aborted).toEqual([])
  })

  test("honors the optional global active-turn cap across scopes", async () => {
    const order = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = createTurnManager(makeMemoryOpencode([]), makeMemoryDiscord(), { globalMaxActiveTurns: 1 })
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const seen = yield* Ref.make<ReadonlyArray<string>>([])

        const first = yield* manager
          .runExclusive(
            channelScope,
            Effect.gen(function* () {
              yield* Ref.update(seen, (values) => [...values, "first-start"])
              yield* Deferred.succeed(firstStarted, void 0)
              yield* Deferred.await(releaseFirst)
              yield* Ref.update(seen, (values) => [...values, "first-end"])
            })
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(firstStarted)
        const second = yield* manager
          .runExclusive(
            threadScope,
            Ref.update(seen, (values) => [...values, "second"])
          )
          .pipe(Effect.forkChild)
        expect(yield* Ref.get(seen)).toEqual(["first-start"])

        yield* Deferred.succeed(releaseFirst, void 0)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        return yield* Ref.get(seen)
      })
    )

    expect(order).toEqual(["first-start", "first-end", "second"])
  })

  test("aborts and clears turns that exceed the configured max duration", async () => {
    const opencode = makeMemoryOpencode([])
    const manager = createTurnManager(opencode, makeMemoryDiscord(), { maxTurn: Duration.millis(1) })

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* manager.startTurn(channelScope, "session-1", Effect.never)
        yield* Fiber.await(fiber)
        expect(yield* manager.isActive(channelScope)).toBe(false)
      })
    )

    expect(opencode.aborted).toEqual(["c1"])
  })

  test("still clears timed-out turns when opencode abort fails", async () => {
    const opencode: OpencodeService = {
      checkHealth: Effect.void,
      runPrompt: () => Stream.empty,
      abort: () => Stream.fail(new OpencodeError({ message: "abort failed" }))
    }
    const manager = createTurnManager(opencode, makeMemoryDiscord(), { maxTurn: Duration.millis(1) })

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* manager.startTurn(channelScope, "session-1", Effect.never)
        yield* Fiber.await(fiber)
        expect(yield* manager.isActive(channelScope)).toBe(false)
      })
    )
  })

  test("/stop reports when this process has no active turn", async () => {
    const manager = createTurnManager(makeMemoryOpencode([]), makeMemoryDiscord())

    await expect(Effect.runPromise(manager.stop(channelScope))).resolves.toEqual({ stopped: false, reason: "no-active-turn" })
  })
})
