import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { defaultConfig } from "./Config.ts"
import { makeMemoryDiscord } from "./Discord/MemoryDiscord.ts"
import { makeApplication } from "./Main.ts"
import { makeMemoryOpencode } from "./Opencode/MemoryOpencode.ts"

describe("makeApplication external triggers", () => {
  test("starts external trigger turns through the application facade", async () => {
    const discord = makeMemoryDiscord()
    const opencode = makeMemoryOpencode([{ type: "text-delta", text: "nightly summary" }, { type: "idle" }])
    const app = makeApplication({
      bot: { userId: "self" },
      config: defaultConfig,
      discord,
      opencode
    })

    await Effect.runPromise(
      app.startTriggeredTurn({
        guildId: "g1",
        channelId: "c1",
        prompt: "Use searchMessages to summarize today's channel conversation.",
        model: "provider/model",
        agent: "summarizer",
        name: "nightly-summary"
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(opencode.prompts).toHaveLength(1)
    expect(opencode.prompts[0]?.scope).toEqual({ guildId: "g1", channelId: "c1" })
    expect(opencode.prompts[0]?.prompt).toContain("scheduled trigger: nightly-summary")
    expect(opencode.prompts[0]?.prompt).toContain("Use searchMessages")
    expect(opencode.prompts[0]?.model).toBe("provider/model")
    expect(opencode.prompts[0]?.agent).toBe("summarizer")
    expect(discord.messages.map((item) => item.content)).toEqual(["nightly summary"])
  })
})
