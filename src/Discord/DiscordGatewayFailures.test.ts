import { describe, expect, test } from "bun:test"
import { Events } from "discord.js"
import { Effect } from "effect"
import { type DiscordGatewayClient, startDiscordGateway } from "./DiscordGateway.ts"

const emptyCollection = { values: () => [][Symbol.iterator]() }

class FakeGatewayClient implements DiscordGatewayClient {
  readonly channels = { fetch: () => Promise.resolve(null) }
  readonly listeners = new Map<string, Array<(value: unknown) => void>>()
  readonly application: DiscordGatewayClient["application"]

  constructor(
    readonly user: { readonly id: string } | null = { id: "bot-1" },
    application: DiscordGatewayClient["application"] = { commands: { create: () => Promise.resolve({}) } }
  ) {
    this.application = application
  }

  on(event: string, listener: (value: unknown) => void): DiscordGatewayClient {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  once(event: string, listener: (value: unknown) => void): DiscordGatewayClient {
    const wrapped = (value: unknown) => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((item) => item !== wrapped)
      )
      listener(value)
    }
    return this.on(event, wrapped)
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }

  login(): Promise<string> {
    this.emit(Events.ClientReady, this)
    return Promise.resolve("token")
  }

  destroy(): void {}
}

const message = () => ({
  id: "m1",
  guildId: "g1",
  channelId: "c1",
  channel: { id: "c1", isDMBased: () => false, isThread: () => false },
  author: { id: "u1", username: "alice", bot: false },
  content: "hello",
  createdAt: new Date("2026-06-05T14:03:00.000Z"),
  mentions: { users: emptyCollection, roles: emptyCollection, everyone: false },
  attachments: emptyCollection,
  reactions: { cache: emptyCollection },
  system: false
})

describe("startDiscordGateway failure paths", () => {
  test("falls back to the client user when ready payload has no user", async () => {
    const client = new FakeGatewayClient()
    client.login = () => {
      client.emit(Events.ClientReady, {})
      return Promise.resolve("token")
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* startDiscordGateway({
            token: "token",
            createClient: () => client,
            onMessage: () => Effect.void,
            onStop: () => Effect.void
          })

          expect(gateway.bot).toEqual({ userId: "bot-1" })
        })
      )
    )
  })

  test("handles callback failures and unavailable command registration", async () => {
    const client = new FakeGatewayClient({ id: "bot-1" }, null)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startDiscordGateway({
            token: "token",
            createClient: () => client,
            onMessage: () => Effect.fail("message failed"),
            onStop: () => Effect.fail("stop failed")
          })

          client.emit(Events.MessageCreate, message())
          client.emit(Events.InteractionCreate, {
            commandName: "stop",
            guildId: "g1",
            channelId: "c1",
            channel: { id: "c1" },
            isChatInputCommand: () => true,
            inGuild: () => true
          })
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        })
      )
    )
  })

  test("fails startup when login fails or ready has no bot identity", async () => {
    const loginFailure = new FakeGatewayClient()
    loginFailure.login = () => Promise.reject(new Error("bad token"))
    await expect(
      Effect.runPromise(
        Effect.scoped(
          startDiscordGateway({
            token: "token",
            createClient: () => loginFailure,
            onMessage: () => Effect.void,
            onStop: () => Effect.void
          })
        )
      )
    ).rejects.toMatchObject({ message: "bad token" })

    const missingIdentity = new FakeGatewayClient(null)
    missingIdentity.login = () => {
      missingIdentity.emit(Events.ClientReady, {})
      return Promise.resolve("token")
    }
    await expect(
      Effect.runPromise(
        Effect.scoped(
          startDiscordGateway({
            token: "token",
            createClient: () => missingIdentity,
            onMessage: () => Effect.void,
            onStop: () => Effect.void
          })
        )
      )
    ).rejects.toMatchObject({ message: "Discord gateway became ready without a bot user id" })
  })
})
