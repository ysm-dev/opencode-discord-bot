import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { makeMemoryOpencode } from "../Opencode/MemoryOpencode.ts"
import type { DiscordScope } from "../Schema.ts"
import { createTurnManager } from "./TurnManager.ts"

const channelScope: DiscordScope = { guildId: "g1", channelId: "c1" }

test("queue strategy keeps only the latest pending turn per Discord scope", async () => {
  const order = await Effect.runPromise(
    Effect.gen(function* () {
      const manager = createTurnManager(makeMemoryOpencode([]), makeMemoryDiscord(), { strategy: "queue" })
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const thirdRan = yield* Deferred.make<void>()
      const seen = yield* Ref.make<ReadonlyArray<string>>([])

      const first = yield* manager.startTurn(
        channelScope,
        "session-1",
        Effect.gen(function* () {
          yield* Ref.update(seen, (values) => [...values, "first"])
          yield* Deferred.succeed(firstStarted, void 0)
          yield* Deferred.await(releaseFirst)
        })
      )
      yield* Deferred.await(firstStarted)

      const second = yield* manager.startTurn(
        channelScope,
        "session-2",
        Ref.update(seen, (values) => [...values, "second"])
      )
      const third = yield* manager.startTurn(
        channelScope,
        "session-3",
        Effect.gen(function* () {
          yield* Ref.update(seen, (values) => [...values, "third"])
          yield* Deferred.succeed(thirdRan, void 0)
        })
      )

      expect(second).toBe(first)
      expect(third).toBe(first)

      yield* Deferred.succeed(releaseFirst, void 0)
      yield* Fiber.join(first)
      yield* Deferred.await(thirdRan)
      return yield* Ref.get(seen)
    })
  )

  expect(order).toEqual(["first", "third"])
})

test("burst strategy serializes every started turn for a busy scope", async () => {
  const order = await Effect.runPromise(
    Effect.gen(function* () {
      const manager = createTurnManager(makeMemoryOpencode([]), makeMemoryDiscord(), { strategy: "burst" })
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const seen = yield* Ref.make<ReadonlyArray<string>>([])

      const first = yield* manager.startTurn(
        channelScope,
        "session-1",
        Effect.gen(function* () {
          yield* Ref.update(seen, (values) => [...values, "first"])
          yield* Deferred.succeed(firstStarted, void 0)
          yield* Deferred.await(releaseFirst)
        })
      )
      yield* Deferred.await(firstStarted)

      const second = yield* manager.startTurn(
        channelScope,
        "session-2",
        Ref.update(seen, (values) => [...values, "second"])
      )
      const third = yield* manager.startTurn(
        channelScope,
        "session-3",
        Ref.update(seen, (values) => [...values, "third"])
      )

      expect(second).not.toBe(first)
      expect(third).not.toBe(first)

      yield* Deferred.succeed(releaseFirst, void 0)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      yield* Fiber.join(third)
      return yield* Ref.get(seen)
    })
  )

  expect(order).toEqual(["first", "second", "third"])
})

test("stop cancels active and waiting burst turns for the same scope", async () => {
  const opencode = makeMemoryOpencode([])
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const manager = createTurnManager(opencode, makeMemoryDiscord(), { strategy: "burst" })
      const firstStarted = yield* Deferred.make<void>()
      const firstFinalized = yield* Ref.make(false)
      const secondStarted = yield* Ref.make(false)

      const first = yield* manager.startTurn(
        channelScope,
        "session-1",
        Effect.gen(function* () {
          yield* Deferred.succeed(firstStarted, void 0)
          yield* Effect.never
        }).pipe(Effect.ensuring(Ref.set(firstFinalized, true)))
      )
      yield* Deferred.await(firstStarted)
      const second = yield* manager.startTurn(channelScope, "session-2", Ref.set(secondStarted, true))

      const stop = yield* manager.stop(channelScope)
      yield* Fiber.await(first)
      yield* Fiber.await(second)

      return {
        active: yield* manager.isActive(channelScope),
        firstFinalized: yield* Ref.get(firstFinalized),
        secondStarted: yield* Ref.get(secondStarted),
        stop
      }
    })
  )

  expect(result).toEqual({ active: false, firstFinalized: true, secondStarted: false, stop: { stopped: true } })
  expect(opencode.aborted).toEqual(["c1"])
})
