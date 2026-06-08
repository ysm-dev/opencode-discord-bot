const fenceStart = (line: string): string | undefined => {
  const match = /^```([^`]*)\s*$/.exec(line.trim())
  return match === null ? undefined : match[1]
}

const hardSplit = (text: string, limit: number): ReadonlyArray<string> => {
  const chunks: Array<string> = []
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit))
  }
  return chunks
}

type SplitState = {
  readonly chunks: Array<string>
  current: string
  openFence: string | undefined
}

const closeChunk = (state: SplitState) => {
  if (state.current.length === 0) return
  const suffix = state.openFence === undefined ? "" : "\n```"
  state.chunks.push(`${state.current}${suffix}`)
  state.current = state.openFence === undefined ? "" : `\`\`\`${state.openFence}\n`
}

const appendSegment = (state: SplitState, segment: string, limit: number) => {
  const suffixLength = state.openFence === undefined ? 0 : 4
  if (segment.length + suffixLength > limit) {
    closeChunk(state)
    appendOversizedSegment(state, segment, limit - suffixLength, suffixLength)
    return
  }
  if (state.current.length + segment.length + suffixLength > limit) {
    closeChunk(state)
    state.current += segment.startsWith("\n") && state.current.length === 0 ? segment.slice(1) : segment
    return
  }
  state.current += segment
}

const appendOversizedSegment = (state: SplitState, segment: string, limit: number, suffixLength: number) => {
  for (const piece of hardSplit(segment, limit)) {
    if (state.current.length + piece.length + suffixLength > limit) closeChunk(state)
    state.current += piece
  }
}

const updateFence = (state: SplitState, line: string) => {
  const marker = fenceStart(line)
  if (marker !== undefined) state.openFence = state.openFence === undefined ? marker : undefined
}

export const splitDiscordMarkdown = (text: string, limit = 2000): ReadonlyArray<string> => {
  if (text.length <= limit) return text.length === 0 ? [] : [text]

  const lines = text.split("\n")
  const state: SplitState = { chunks: [], current: "", openFence: undefined }

  for (let index = 0; index < lines.length; index += 1) {
    const segment = `${index === 0 ? "" : "\n"}${lines[index]}`
    appendSegment(state, segment, limit)
    updateFence(state, lines[index] ?? "")
  }

  if (state.current.length > 0) state.chunks.push(state.current)
  return state.chunks
}
