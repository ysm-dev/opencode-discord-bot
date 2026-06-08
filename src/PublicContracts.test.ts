import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeLiveChatSdkDiscord } from "./Discord/ChatSdkDiscord.ts"
import { Discord } from "./Discord/DiscordPort.ts"
import { makeMemoryDiscord } from "./Discord/MemoryDiscord.ts"
import { makeMemoryOpencode } from "./Opencode/MemoryOpencode.ts"
import { Opencode } from "./Opencode/OpencodePort.ts"
import { makeLiveSdkOpencode } from "./Opencode/SdkOpencode.ts"
import type { DiscordAuthor, DiscordReaction, Snowflake, ToolTarget } from "./Schema.ts"
import { ToolTargetSchema } from "./Schema.ts"

describe("public contracts", () => {
  test("keeps Effect service tags and live adapter factories exported", () => {
    expect(Discord).toBeDefined()
    expect(Opencode).toBeDefined()
    expect(makeLiveChatSdkDiscord({ botToken: "token", applicationId: "123", publicKey: "0".repeat(64) })).toBeDefined()
    expect(makeLiveSdkOpencode({ baseUrl: "http://127.0.0.1:4096", projectDir: "/repo" })).toBeDefined()
    expect(ToolTargetSchema).toBeDefined()
  })

  test("provides and retrieves Effect service tags", async () => {
    const discord = makeMemoryDiscord()
    const opencode = makeMemoryOpencode([])

    const services = await Effect.gen(function* () {
      return { discord: yield* Discord, opencode: yield* Opencode }
    }).pipe(Effect.provideService(Discord, discord), Effect.provideService(Opencode, opencode), Effect.runPromise)

    expect(services.discord).toBe(discord)
    expect(services.opencode).toBe(opencode)
  })

  test("keeps exported schema-adjacent types usable", () => {
    const snowflake: Snowflake = "123"
    const author: DiscordAuthor = { id: snowflake, displayName: "Alice", isBot: false }
    const reaction: DiscordReaction = { emoji: "rocket", count: 1 }
    const target: ToolTarget = { guildId: "g1", channelId: "c1" }

    expect(author.id).toBe("123")
    expect(reaction.count).toBe(1)
    expect(target.channelId).toBe("c1")
  })
})
