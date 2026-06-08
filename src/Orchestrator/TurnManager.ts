import { Deferred, type Duration, Effect, Fiber, Semaphore, Stream } from "effect"
import type { DiscordService } from "../Discord/DiscordPort.ts"
import type { OpencodeService } from "../Opencode/OpencodePort.ts"
import type { DiscordScope } from "../Schema.ts"

type ActiveTurn = {
  readonly scope: DiscordScope
  readonly sessionId?: string | undefined
  readonly fiber: Fiber.Fiber<void, never>
}

type PendingTurn = {
  readonly scope: DiscordScope
  readonly sessionId?: string | undefined
  readonly effect: Effect.Effect<void, never>
}

type StopResult = { readonly stopped: true } | { readonly stopped: false; readonly reason: "no-active-turn" }

export type TurnManager = {
  readonly runExclusive: <A, E, R>(scope: DiscordScope, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly startTurn: (
    scope: DiscordScope,
    sessionId: string | undefined,
    effect: Effect.Effect<void, never>
  ) => Effect.Effect<Fiber.Fiber<void, never>>
  readonly stop: (scope: DiscordScope) => Effect.Effect<StopResult>
  readonly isActive: (scope: DiscordScope) => Effect.Effect<boolean>
}

export type TurnManagerOptions = {
  readonly strategy?: "queue" | "burst" | undefined
  readonly globalMaxActiveTurns?: number | null | undefined
  readonly maxTurn?: Duration.Duration | null | undefined
}

const scopeKey = (scope: DiscordScope): string => scope.threadId ?? scope.channelId

export const createTurnManager = (opencode: OpencodeService, _discord: DiscordService, options: TurnManagerOptions = {}): TurnManager => {
  const locks = new Map<string, Semaphore.Semaphore>()
  const activeTurns = new Map<string, ActiveTurn>()
  const queuedTurns = new Map<string, PendingTurn>()
  const currentFibers = new Map<string, Fiber.Fiber<void, never>>()
  const waitingTurns = new Map<string, Set<Fiber.Fiber<void, never>>>()
  const globalLock =
    options.globalMaxActiveTurns === undefined || options.globalMaxActiveTurns === null
      ? undefined
      : Semaphore.makeUnsafe(Math.max(1, Math.floor(options.globalMaxActiveTurns)))

  const lockFor = (scope: DiscordScope): Semaphore.Semaphore => {
    const key = scopeKey(scope)
    const existing = locks.get(key)
    if (existing !== undefined) return existing
    const next = Semaphore.makeUnsafe(1)
    locks.set(key, next)
    return next
  }

  const withGlobalLimit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => globalLock?.withPermit(effect) ?? effect

  const withMaxTurn = (scope: DiscordScope, effect: Effect.Effect<void, never>): Effect.Effect<void, never> => {
    if (options.maxTurn === undefined || options.maxTurn === null) return effect
    return effect.pipe(
      Effect.timeoutOrElse({
        duration: options.maxTurn,
        orElse: () =>
          opencode.abort(scope).pipe(
            Stream.runDrain,
            Effect.catch(() => Effect.void)
          )
      })
    )
  }

  const runExclusive: TurnManager["runExclusive"] = (scope, effect) => withGlobalLimit(lockFor(scope).withPermit(effect))

  const hasWaitingTurn = (key: string): boolean => (waitingTurns.get(key)?.size ?? 0) > 0

  const addWaitingTurn = (key: string, fiber: Fiber.Fiber<void, never>): void => {
    const waiting = waitingTurns.get(key) ?? new Set<Fiber.Fiber<void, never>>()
    waiting.add(fiber)
    waitingTurns.set(key, waiting)
  }

  const removeWaitingTurn = (key: string, fiber: Fiber.Fiber<void, never>): void => {
    const waiting = waitingTurns.get(key)
    if (waiting === undefined) return
    waiting.delete(fiber)
    if (waiting.size === 0) waitingTurns.delete(key)
  }

  const completeTurn = (key: string, fiber: Fiber.Fiber<void, never>): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.sync(() => removeWaitingTurn(key, fiber))
      if (activeTurns.get(key)?.fiber === fiber) activeTurns.delete(key)
      const queued = queuedTurns.get(key)
      if (queued === undefined) {
        if (currentFibers.get(key) === fiber) currentFibers.delete(key)
        return
      }
      queuedTurns.delete(key)
      yield* launchTurn(queued).pipe(Effect.asVoid)
    })

  const launchTurn = Effect.fn("launchTurn")(function* (turn: PendingTurn) {
    const key = scopeKey(turn.scope)
    const startGate = yield* Deferred.make<void>()
    const self = yield* Deferred.make<Fiber.Fiber<void, never>>()
    const fiber = yield* Effect.gen(function* () {
      yield* Deferred.await(startGate)
      const current = yield* Deferred.await(self)
      yield* runExclusive(
        turn.scope,
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            removeWaitingTurn(key, current)
            activeTurns.set(key, { scope: turn.scope, sessionId: turn.sessionId, fiber: current })
          })
          yield* withMaxTurn(turn.scope, turn.effect)
        })
      )
    })
      .pipe(Effect.ensuring(Deferred.await(self).pipe(Effect.flatMap((current) => completeTurn(key, current)))))
      .pipe(Effect.forkDetach)

    yield* Effect.sync(() => {
      addWaitingTurn(key, fiber)
      currentFibers.set(key, fiber)
    })
    yield* Deferred.succeed(self, fiber)
    yield* Deferred.succeed(startGate, void 0)
    return fiber
  })

  const startTurn: TurnManager["startTurn"] = (scope, sessionId, effect) =>
    Effect.gen(function* () {
      const key = scopeKey(scope)
      const turn = { scope, sessionId, effect } satisfies PendingTurn
      const current = currentFibers.get(key)
      if (current !== undefined && options.strategy !== "burst") {
        queuedTurns.set(key, turn)
        return current
      }
      return yield* launchTurn(turn)
    })

  const stop: TurnManager["stop"] = (scope) =>
    Effect.gen(function* () {
      const key = scopeKey(scope)
      const active = activeTurns.get(key)
      const waiting = [...(waitingTurns.get(key) ?? [])]
      const queued = queuedTurns.get(key)
      if (active === undefined && waiting.length === 0 && queued === undefined) return { stopped: false, reason: "no-active-turn" } as const

      activeTurns.delete(key)
      queuedTurns.delete(key)
      currentFibers.delete(key)
      waitingTurns.delete(key)
      if (active !== undefined) {
        yield* opencode.abort(active.scope).pipe(
          Stream.runDrain,
          Effect.catch(() => Effect.void)
        )
        yield* Fiber.interrupt(active.fiber)
      }
      for (const fiber of waiting) {
        yield* Fiber.interrupt(fiber).pipe(Effect.catch(() => Effect.void))
      }
      return { stopped: true } as const
    })

  const isActive: TurnManager["isActive"] = (scope) =>
    Effect.sync(() => {
      const key = scopeKey(scope)
      return activeTurns.has(key) || currentFibers.has(key) || hasWaitingTurn(key) || queuedTurns.has(key)
    })

  return { runExclusive, startTurn, stop, isActive }
}
