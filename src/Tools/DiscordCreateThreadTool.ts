import { tool } from "@opencode-ai/plugin"

const loopbackToolUrl = "__OPENCODE_DISCORD_BOT_LOOPBACK_URL__/tool"

const targetSchema = tool.schema
  .object({
    guildId: tool.schema.string().describe("Discord guild ID."),
    channelId: tool.schema.string().describe("Discord channel ID."),
    threadId: tool.schema.string().optional().describe("Discord parent thread ID, when creating inside a thread context.")
  })
  .describe("Discord channel target for thread creation.")

export default tool({
  description: "Create a Discord thread through the local opencode-discord-bot process.",
  args: {
    target: targetSchema,
    name: tool.schema.string().describe("Name for the new Discord thread.")
  },
  async execute(request) {
    const response = await fetch(loopbackToolUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "createThread", target: request.target, args: { name: request.name } })
    })
    const payload = await response.json()
    return JSON.stringify(payload, null, 2) ?? String(payload)
  }
})
