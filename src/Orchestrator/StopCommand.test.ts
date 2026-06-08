import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeMemoryDiscord } from "../Discord/MemoryDiscord.ts"
import { makeMemoryOpencode } from "../Opencode/MemoryOpencode.ts"
import type { DiscordScope } from "../Schema.ts"
import { handleStopCommand } from "./StopCommand.ts"
import { createTurnManager } from "./TurnManager.ts"

const scope: DiscordScope = { guildId: "g1", channelId: "c1" }

describe("handleStopCommand", () => {
  test("posts a no-active-turn response when there is no transient handle", async () => {
    const discord = makeMemoryDiscord()
    const manager = createTurnManager(makeMemoryOpencode([]), discord)

    await Effect.runPromise(handleStopCommand(scope, manager, discord))

    expect(discord.messages).toEqual([{ scope, content: "There is no known active turn in this process." }])
  })
})
