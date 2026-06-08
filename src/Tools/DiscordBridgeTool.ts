import { tool } from "@opencode-ai/plugin"

const loopbackToolUrl = "__OPENCODE_DISCORD_BOT_LOOPBACK_URL__/tool"

export default tool({
  description: "Perform non-message Discord bridge actions through the local opencode-discord-bot process.",
  args: {
    action: tool.schema
      .enum([
        "addReaction",
        "removeReaction",
        "fetchHistory",
        "attachFile",
        "createThread",
        "editOwnMessage",
        "deleteOwnMessage",
        "pin",
        "unpin"
      ])
      .describe("Discord bridge action to perform."),
    target: tool.schema
      .object({
        guildId: tool.schema.string().optional(),
        channelId: tool.schema.string().optional(),
        threadId: tool.schema.string().optional(),
        messageId: tool.schema.string().optional()
      })
      .describe("Discord target for the action."),
    args: tool.schema
      .record(tool.schema.string(), tool.schema.unknown())
      .describe("Action-specific arguments, such as emoji, limit, path, name, or replacement content for editOwnMessage.")
  },
  async execute(request) {
    const response = await fetch(loopbackToolUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    })
    const payload: unknown = await response.json()
    return JSON.stringify(payload, null, 2) ?? String(payload)
  }
})
