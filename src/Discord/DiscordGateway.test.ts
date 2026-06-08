import { describe, expect, test } from "bun:test"
import { Events, GatewayIntentBits, Partials } from "discord.js"
import { Effect } from "effect"
import type { DiscordScope } from "../Schema.ts"
import {
  contextReactionPartials,
  type DiscordGatewayClient,
  makeDiscordGatewayClient,
  requiredGatewayIntents,
  startDiscordGateway
} from "./DiscordGateway.ts"

const collection = <A>(items: ReadonlyArray<A>) => ({ values: () => items[Symbol.iterator]() })

class FakeGatewayClient implements DiscordGatewayClient {
  readonly user: { readonly id: string } | null
  readonly channels = { fetch: () => Promise.resolve(null) }
  readonly createdCommands: Array<readonly [{ readonly name: string; readonly description: string }, string | undefined]> = []
  readonly application = {
    commands: {
      create: (command: { readonly name: string; readonly description: string }, guildId?: string) => {
        this.createdCommands.push([command, guildId])
        return Promise.resolve({})
      }
    }
  }
  readonly listeners = new Map<string, Array<(value: unknown) => void>>()
  destroyed = false

  constructor(user: { readonly id: string } | null = { id: "bot-1" }) {
    this.user = user
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

  destroy(): Promise<void> {
    this.destroyed = true
    return Promise.resolve()
  }
}

const message = (
  overrides: {
    readonly channel?: {
      readonly id: string
      readonly parentId?: string | null
      readonly isDMBased?: () => boolean
      readonly isThread?: () => boolean
    }
    readonly guildId?: string | null
    readonly channelId?: string
    readonly authorBot?: boolean
  } = {}
) => ({
  id: "m1",
  guildId: overrides.guildId ?? "g1",
  channelId: overrides.channelId ?? "c1",
  channel: overrides.channel ?? { id: "c1", isDMBased: () => false, isThread: () => false },
  author: { id: "u1", username: "alice", displayName: "Alice", bot: overrides.authorBot ?? false },
  member: { nickname: "ali" },
  content: "hello <@bot-1>",
  createdAt: new Date("2026-06-05T14:03:00.000Z"),
  mentions: { users: collection([{ id: "bot-1" }]), roles: collection([{ id: "r1" }]), everyone: false },
  attachments: collection([{ id: "a1", name: "a.txt", contentType: "text/plain", size: 1, url: "https://example.test/a.txt" }]),
  reactions: { cache: collection([{ emoji: { name: "rocket", identifier: "rocket" }, count: 2 }]) },
  system: false,
  inGuild: () => overrides.guildId !== null
})

describe("Discord gateway constants", () => {
  test("requests guild message intents but no DM intents", () => {
    expect(requiredGatewayIntents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions
    ])
    expect(requiredGatewayIntents.includes(GatewayIntentBits.DirectMessages)).toBe(false)
    expect(contextReactionPartials).toEqual([Partials.Message, Partials.Reaction, Partials.User])
  })

  test("constructs the production discord.js client", () => {
    const client = makeDiscordGatewayClient()

    expect(client).toBeDefined()
    client.destroy()
  })
})

describe("startDiscordGateway", () => {
  test("logs in, registers stop, maps guild messages, and destroys on scope close", async () => {
    const client = new FakeGatewayClient()
    const messages: Array<unknown> = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* startDiscordGateway({
            token: "token",
            guildId: "g1",
            createClient: () => client,
            onMessage: (item, bot) => Effect.sync(() => messages.push({ item, bot })),
            onStop: () => Effect.void
          })

          client.emit(Events.MessageCreate, message())
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))

          expect(gateway.bot).toEqual({ userId: "bot-1" })
          expect(client.createdCommands[0]).toEqual([
            { name: "stop", description: "Stop the active opencode turn in this Discord scope." },
            "g1"
          ])
          expect(messages).toEqual([
            {
              bot: { userId: "bot-1" },
              item: {
                id: "m1",
                guildId: "g1",
                channelId: "c1",
                author: { id: "u1", displayName: "Alice", nickname: "ali", isBot: false },
                content: "hello <@bot-1>",
                timestamp: "2026-06-05T14:03:00.000Z",
                mentions: ["bot-1"],
                roleMentions: ["r1"],
                everyoneMention: false,
                hereMention: false,
                attachments: [{ id: "a1", filename: "a.txt", contentType: "text/plain", size: 1, url: "https://example.test/a.txt" }],
                reactions: [{ emoji: "rocket", count: 2 }],
                channelType: "guild",
                isSystem: false
              }
            }
          ])
        })
      )
    )

    expect(client.destroyed).toBe(true)
  })

  test("preserves thread scopes, ignores DMs, and dispatches slash stop", async () => {
    const client = new FakeGatewayClient()
    const messages: Array<unknown> = []
    const stops: Array<DiscordScope> = []
    let replied = false

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startDiscordGateway({
            token: "token",
            createClient: () => client,
            onMessage: (item) => Effect.sync(() => messages.push(item)),
            onStop: (scope) => Effect.sync(() => stops.push(scope))
          })

          client.emit(Events.MessageCreate, message({ channelId: "t1", channel: { id: "t1", parentId: "c1", isThread: () => true } }))
          client.emit(Events.MessageCreate, message({ guildId: null, channel: { id: "dm1", isDMBased: () => true } }))
          client.emit(Events.InteractionCreate, {
            commandName: "stop",
            guildId: "g1",
            channelId: "t1",
            channel: { id: "t1", parentId: "c1", isThread: () => true },
            isChatInputCommand: () => true,
            inGuild: () => true,
            reply: () => {
              replied = true
              return Promise.resolve({})
            }
          })
          client.emit(Events.InteractionCreate, {
            commandName: "stop",
            guildId: "g1",
            channelId: "t2",
            channel: { id: "t2", isThread: () => true },
            isChatInputCommand: () => true,
            inGuild: () => true
          })
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))

          expect(messages).toEqual([expect.objectContaining({ guildId: "g1", channelId: "c1", threadId: "t1" })])
          expect(stops).toEqual([
            { guildId: "g1", channelId: "c1", threadId: "t1" },
            { guildId: "g1", channelId: "t2", threadId: "t2" }
          ])
          expect(replied).toBe(true)
        })
      )
    )
  })
})
