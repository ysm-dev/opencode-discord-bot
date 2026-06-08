import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { defaultConfig } from "../Config.ts"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { startLoopbackServer } from "./LoopbackServer.ts"

describe("startLoopbackServer", () => {
  test("binds to loopback and serves POST /tool", async () => {
    const discord = makeMemoryDiscord()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startLoopbackServer({
            port: 0,
            config: defaultConfig,
            projectDir: "/repo",
            discord,
            getAllowedScopes: () => [{ guildId: "g1", channelId: "c1" }]
          })
          const response = yield* Effect.tryPromise(() =>
            fetch(`${server.url}/tool`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "addReaction",
                target: { guildId: "g1", channelId: "c1", messageId: "m1" },
                args: { emoji: "rocket" }
              })
            })
          )
          const body = yield* Effect.tryPromise(() => response.json())

          expect(server.url.startsWith("http://127.0.0.1:")).toBe(true)
          expect(body).toEqual({ ok: true, result: { reacted: true } })
          expect(discord.reactions).toEqual([{ scope: { guildId: "g1", channelId: "c1" }, messageId: "m1", emoji: "rocket", op: "add" }])
          expect(discord.messages).toEqual([])
        })
      )
    )
  })

  test("returns 404 for non-tool routes and contract errors for bad bodies", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startLoopbackServer({ port: 0, config: defaultConfig, projectDir: "/repo", discord: makeMemoryDiscord() })
          const missing = yield* Effect.tryPromise(() => fetch(`${server.url}/missing`))
          const badJson = yield* Effect.tryPromise(() =>
            fetch(`${server.url}/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" })
          )
          const badContract = yield* Effect.tryPromise(() =>
            fetch(`${server.url}/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })
          )
          const badJsonBody = yield* Effect.tryPromise(() => badJson.json())
          const badContractBody = yield* Effect.tryPromise(() => badContract.json())

          expect(missing.status).toBe(404)
          expect(badJsonBody).toEqual({ ok: false, error: "Request body must be valid JSON" })
          expect(badContractBody).toEqual({ ok: false, error: "Request body must match the tool contract" })
        })
      )
    )
  })

  test("rejects tool targets outside the active turn scopes", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startLoopbackServer({
            port: 0,
            config: defaultConfig,
            projectDir: "/repo",
            discord: makeMemoryDiscord(),
            getAllowedScopes: () => [{ guildId: "g1", channelId: "c1" }]
          })
          const response = yield* Effect.tryPromise(() =>
            fetch(`${server.url}/tool`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "addReaction",
                target: { guildId: "g1", channelId: "c2", messageId: "m1" },
                args: { emoji: "rocket" }
              })
            })
          )
          const body = yield* Effect.tryPromise(() => response.json())

          expect(body).toEqual({ ok: false, error: "Discord target is outside the active turn scope" })
        })
      )
    )
  })
})
