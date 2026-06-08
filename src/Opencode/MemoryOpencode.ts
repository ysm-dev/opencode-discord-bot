import { Stream } from "effect"
import type { OpencodeEvent } from "../Schema.ts"
import type { OpencodePrompt, OpencodeService } from "./OpencodePort.ts"

export type MemoryOpencode = OpencodeService & {
  readonly prompts: Array<OpencodePrompt>
  readonly aborted: Array<string>
}

const scopeKey = (scope: OpencodePrompt["scope"]) => scope.threadId ?? scope.channelId

export const makeMemoryOpencode = (events: ReadonlyArray<OpencodeEvent>): MemoryOpencode => {
  const prompts: Array<OpencodePrompt> = []
  const aborted: Array<string> = []

  return {
    prompts,
    aborted,
    checkHealth: Stream.runDrain(Stream.empty),
    runPrompt: (input) => {
      prompts.push(input)
      return Stream.fromIterable(events)
    },
    abort: (scope) => {
      aborted.push(scopeKey(scope))
      return Stream.empty
    }
  }
}
