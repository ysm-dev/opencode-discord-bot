export const tokenizeDiscordSearch = (input: string): ReadonlyArray<string> => {
  const matches = input.match(/(?:[^\s"'\\]+|\\.|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g)
  if (matches === null) return []
  return matches.map((token) =>
    token
      .replace(/(["'])((?:\\.|(?!\1).)*)\1/g, (_match, _quote: string, body: string) => body.replace(/\\(.)/g, "$1"))
      .replace(/\\(.)/g, "$1")
  )
}

export const splitValues = (input: string): ReadonlyArray<string> =>
  input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

export const splitKeyValue = (token: string): readonly [string, string] | undefined => {
  const index = token.indexOf(":")
  if (index <= 0) return undefined
  const key = token.slice(0, index).trim().toLowerCase().replaceAll("-", "_")
  const value = token.slice(index + 1).trim()
  return key.length === 0 || value.length === 0 ? undefined : [key, value]
}

export const unique = <A>(items: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(items)]
