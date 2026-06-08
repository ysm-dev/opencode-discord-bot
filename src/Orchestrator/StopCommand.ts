import { Effect } from "effect"
import type { DiscordService } from "../Discord/DiscordPort.ts"
import type { DiscordScope } from "../Schema.ts"
import type { TurnManager } from "./TurnManager.ts"

export const handleStopCommand = Effect.fn("handleStopCommand")(function* (
  scope: DiscordScope,
  turns: TurnManager,
  discord: DiscordService
) {
  const result = yield* turns.stop(scope)
  const content = result.stopped ? "Stopped the active turn." : "There is no known active turn in this process."
  yield* discord.postMessage(scope, content)
})
