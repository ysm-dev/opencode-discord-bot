import { tool } from "@opencode-ai/plugin"

const loopbackToolUrl = "__OPENCODE_DISCORD_BOT_LOOPBACK_URL__/tool"

const targetSchema = tool.schema
  .object({
    guildId: tool.schema.string().describe("Discord guild ID."),
    channelId: tool.schema.string().describe("Discord channel ID."),
    threadId: tool.schema.string().optional().describe("Discord thread ID, when targeting a thread."),
    messageId: tool.schema.string().describe("Discord message ID to react to.")
  })
  .describe("Discord message target for the reaction.")

export default tool({
  description: "Add an emoji reaction to a Discord message through the local opencode-discord-bot process.",
  args: {
    target: targetSchema,
    emoji: tool.schema.string().describe("Emoji to add as a reaction.")
  },
  async execute(request) {
    const response = await fetch(loopbackToolUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "addReaction", target: request.target, args: { emoji: request.emoji } })
    })
    const payload = await response.json()
    return JSON.stringify(payload, null, 2) ?? String(payload)
  }
})
