export type ConfigSources = {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly configText?: string | undefined
}

export type LoadConfigOptions = {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly configPath?: string
}
