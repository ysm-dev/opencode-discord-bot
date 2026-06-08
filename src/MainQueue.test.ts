import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { defaultConfig } from "./Config.ts"
import { makeMemoryDiscord } from "./Discord/MemoryDiscord.ts"
import { makeApplication } from "./Main.ts"
import { OpencodeError, type OpencodeService } from "./Opencode/OpencodePort.ts"
import type { DiscordMessage } from "./Schema.ts"

const mentionMessage = {
  id: "m1",
  guildId: "g1",
  channelId: "c1",
  author: { id: "u1", displayName: "Alice", isBot: false },
  content: "first <@self>",
  timestamp: "2026-06-05T14:03:00.000Z",
  mentions: ["self"],
  roleMentions: [],
  everyoneMention: false,
  hereMention: false,
  attachments: [],
  reactions: [],
  channelType: "guild"
} satisfies DiscordMessage

test("queues only the latest busy-scope message and surfaces skipped context", async () => {
  const secondMessage = { ...mentionMessage, id: "m2", content: "second <@self>" } satisfies DiscordMessage
  const thirdMessage = { ...mentionMessage, id: "m3", content: "third <@self>" } satisfies DiscordMessage
  const discord = makeMemoryDiscord({ context: [mentionMessage, secondMessage, thirdMessage] })
  let releaseFirst: (() => void) | undefined
  let markFirstPromptStarted: (() => void) | undefined
  let markQueuedPromptStarted: (() => void) | undefined
  const firstTurn = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const firstPromptStarted = new Promise<void>((resolve) => {
    markFirstPromptStarted = resolve
  })
  const queuedPromptStarted = new Promise<void>((resolve) => {
    markQueuedPromptStarted = resolve
  })
  const prompts: Array<string> = []
  const opencode: OpencodeService = {
    checkHealth: Effect.void,
    abort: () => Stream.empty,
    runPrompt: (input) => {
      prompts.push(input.prompt)
      if (prompts.length === 1) {
        markFirstPromptStarted?.()
        return Stream.fromAsyncIterable(
          (async function* () {
            yield { type: "text-delta" as const, text: "first" }
            await firstTurn
            yield { type: "idle" as const }
          })(),
          () => new OpencodeError({ message: "stream failed" })
        )
      }
      markQueuedPromptStarted?.()
      return Stream.fromIterable([{ type: "text-delta", text: "queued" }, { type: "idle" }])
    }
  }
  const app = makeApplication({ bot: { userId: "self" }, config: defaultConfig, discord, opencode })

  await Effect.runPromise(app.startMessageTurn(mentionMessage))
  await firstPromptStarted
  await Effect.runPromise(app.startMessageTurn(secondMessage))
  await Effect.runPromise(app.startMessageTurn(thirdMessage))
  releaseFirst?.()
  await queuedPromptStarted

  const queuedPrompt = prompts[1]
  if (queuedPrompt === undefined) throw new Error("missing queued prompt")
  expect(prompts).toHaveLength(2)
  expect(queuedPrompt).toContain("(queued intermediate message)")
  expect(queuedPrompt).toContain("second <@self>")
  expect(queuedPrompt).toContain("third <@self>")
  expect(queuedPrompt.indexOf("second <@self>")).toBeLessThan(queuedPrompt.indexOf("third <@self>"))
})

test("does not let ignored busy-scope messages replace a queued mention", async () => {
  const queuedMention = { ...mentionMessage, id: "m2", content: "queued <@self>" } satisfies DiscordMessage
  const ignored = { ...mentionMessage, id: "m3", content: "noise", mentions: [] } satisfies DiscordMessage
  const discord = makeMemoryDiscord({ context: [mentionMessage, queuedMention, ignored] })
  let releaseFirst: (() => void) | undefined
  let markQueuedPromptStarted: (() => void) | undefined
  const firstTurn = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const queuedPromptStarted = new Promise<void>((resolve) => {
    markQueuedPromptStarted = resolve
  })
  const prompts: Array<string> = []
  const opencode: OpencodeService = {
    checkHealth: Effect.void,
    abort: () => Stream.empty,
    runPrompt: (input) => {
      prompts.push(input.prompt)
      if (prompts.length === 1) {
        return Stream.fromAsyncIterable(
          (async function* () {
            await firstTurn
            yield { type: "idle" as const }
          })(),
          () => new OpencodeError({ message: "stream failed" })
        )
      }
      markQueuedPromptStarted?.()
      return Stream.fromIterable([{ type: "idle" }])
    }
  }
  const app = makeApplication({ bot: { userId: "self" }, config: defaultConfig, discord, opencode })

  await Effect.runPromise(app.startMessageTurn(mentionMessage))
  await Effect.runPromise(app.startMessageTurn(queuedMention))
  await Effect.runPromise(app.startMessageTurn(ignored))
  releaseFirst?.()
  await queuedPromptStarted

  const queuedPrompt = prompts[1]
  if (queuedPrompt === undefined) throw new Error("missing queued prompt")
  expect(prompts).toHaveLength(2)
  expect(queuedPrompt).toContain("queued <@self>")
  expect(queuedPrompt.indexOf("noise")).toBeLessThan(queuedPrompt.indexOf("queued <@self>"))
})
