import { tool } from "@opencode-ai/plugin"

const loopbackToolUrl = "__OPENCODE_DISCORD_BOT_LOOPBACK_URL__/tool"

const targetSchema = tool.schema
  .object({
    guildId: tool.schema.string().describe("Discord guild ID."),
    channelId: tool.schema.string().describe("Discord channel ID."),
    threadId: tool.schema.string().optional().describe("Discord thread ID, when targeting a thread.")
  })
  .describe("Discord channel or thread target for history fetching.")

export default tool({
  description: "Fetch recent Discord message history through the local opencode-discord-bot process.",
  args: {
    target: targetSchema,
    limit: tool.schema.number().int().positive().optional().describe("Maximum number of recent messages to fetch.")
  },
  async execute(request) {
    const response = await fetch(loopbackToolUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "fetchHistory", target: request.target, args: { limit: request.limit } })
    })
    const payload = await response.json()
    return JSON.stringify(payload, null, 2) ?? String(payload)
  }
})
