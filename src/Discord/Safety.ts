export type DiscordOutputGuards = {
  readonly stripMassMentions: boolean
}

export const sanitizeDiscordContent = (content: string, guards: DiscordOutputGuards): string => {
  if (!guards.stripMassMentions) return content
  return content
    .replaceAll("@everyone", "@ everyone")
    .replaceAll("@here", "@ here")
    .replace(/<@&(\d+)>/g, "<@& $1>")
}
