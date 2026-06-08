import { Client, Events, GatewayIntentBits, Partials } from "discord.js"
import { Effect } from "effect"
import type { BotIdentity, DiscordMessage, DiscordScope } from "../Schema.ts"
import { type DiscordJsChannelLike, type DiscordJsClientLike, type DiscordJsMessageLike, fromDiscordJsMessage } from "./DiscordJsDiscord.ts"

export const requiredGatewayIntents: ReadonlyArray<GatewayIntentBits> = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageReactions
] as const

export const contextReactionPartials: ReadonlyArray<Partials> = [Partials.Message, Partials.Reaction, Partials.User]

type InteractionLike = {
  readonly commandName: string
  readonly guildId: string | null
  readonly channelId: string | null
  readonly channel: DiscordJsChannelLike | null
  readonly isChatInputCommand: () => boolean
  readonly inGuild?: () => boolean
  readonly reply?: (input: { readonly content: string; readonly ephemeral: boolean }) => Promise<unknown>
}

export type DiscordGatewayClient = DiscordJsClientLike & {
  readonly application: {
    readonly commands: {
      readonly create: (command: { readonly name: string; readonly description: string }, guildId?: string) => Promise<unknown>
    }
  } | null
  readonly on: (event: string, listener: (value: unknown) => void) => DiscordGatewayClient
  readonly once: (event: string, listener: (value: unknown) => void) => DiscordGatewayClient
  readonly login: (token?: string) => Promise<string>
  readonly destroy: () => Promise<void> | void
}

export type DiscordGateway = {
  readonly bot: BotIdentity
  readonly client: DiscordGatewayClient
}

export type DiscordGatewayOptions = {
  readonly token: string
  readonly guildId?: string | undefined
  readonly createClient?: (() => DiscordGatewayClient) | undefined
  readonly onMessage: (message: DiscordMessage, bot: BotIdentity) => Effect.Effect<void, unknown>
  readonly onStop: (scope: DiscordScope, bot: BotIdentity) => Effect.Effect<void, unknown>
}

const stopCommand = {
  name: "stop",
  description: "Stop the active opencode turn in this Discord scope."
} as const

export const makeDiscordGatewayClient = (): DiscordGatewayClient =>
  new Client({
    intents: [...requiredGatewayIntents],
    partials: [...contextReactionPartials]
  })

const runCallback = (effect: Effect.Effect<void, unknown>): void => {
  void Effect.runPromise(effect.pipe(Effect.catch((error) => Effect.logError(`Discord gateway handler failed: ${String(error)}`))))
}

const botFromReady = (ready: unknown, client: DiscordGatewayClient): BotIdentity => {
  const candidate = typeof ready === "object" && ready !== null && "user" in ready ? ready.user : client.user
  if (typeof candidate === "object" && candidate !== null && "id" in candidate && typeof candidate.id === "string")
    return { userId: candidate.id }
  if (client.user !== null) return { userId: client.user.id }
  throw new Error("Discord gateway became ready without a bot user id")
}

const interactionScope = (interaction: InteractionLike): DiscordScope | undefined => {
  if (interaction.inGuild?.() === false || interaction.guildId === null || interaction.channelId === null) return undefined
  const channel = interaction.channel
  if (channel?.isDMBased?.() === true) return undefined
  if (channel?.isThread?.() === true) {
    return { guildId: interaction.guildId, channelId: channel.parentId ?? interaction.channelId, threadId: interaction.channelId }
  }
  return { guildId: interaction.guildId, channelId: interaction.channelId }
}

const isInteraction = (value: unknown): value is InteractionLike =>
  typeof value === "object" &&
  value !== null &&
  "isChatInputCommand" in value &&
  typeof value.isChatInputCommand === "function" &&
  "commandName" in value &&
  typeof value.commandName === "string"

const isGatewayMessage = (value: unknown): value is DiscordJsMessageLike =>
  typeof value === "object" && value !== null && "author" in value && "mentions" in value && "channel" in value

const registerStopCommand = (client: DiscordGatewayClient, guildId: string | undefined): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      if (client.application === null) return
      await client.application.commands.create(stopCommand, guildId)
    },
    catch: () => undefined
  }).pipe(Effect.catch(() => Effect.void))

export const startDiscordGateway = Effect.fn("startDiscordGateway")(function* (options: DiscordGatewayOptions) {
  const client = options.createClient?.() ?? makeDiscordGatewayClient()
  const bot = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const ready = new Promise<BotIdentity>((resolve, reject) => {
          client.once(Events.ClientReady, (value) => {
            try {
              resolve(botFromReady(value, client))
            } catch (cause) {
              reject(cause)
            }
          })
        })

        client.on(Events.MessageCreate, (raw) => {
          if (!isGatewayMessage(raw)) return
          const mapped = fromDiscordJsMessage(raw)
          if (mapped !== undefined && client.user !== null) runCallback(options.onMessage(mapped, { userId: client.user.id }))
        })
        client.on(Events.InteractionCreate, (raw) => {
          if (!isInteraction(raw) || !raw.isChatInputCommand() || raw.commandName !== "stop") return
          const scope = interactionScope(raw)
          if (scope === undefined || client.user === null) return
          if (raw.reply !== undefined) void raw.reply({ content: "Stop request received.", ephemeral: true }).catch(() => undefined)
          runCallback(options.onStop(scope, { userId: client.user.id }))
        })
        await client.login(options.token)
        return await ready
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error("Discord gateway startup failed"))
    }),
    () => Effect.promise(() => Promise.resolve(client.destroy())).pipe(Effect.catch(() => Effect.void))
  )

  yield* registerStopCommand(client, options.guildId)
  return { bot, client } satisfies DiscordGateway
})
