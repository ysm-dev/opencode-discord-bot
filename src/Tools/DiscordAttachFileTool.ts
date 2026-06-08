import { tool } from "@opencode-ai/plugin"

const loopbackToolUrl = "__OPENCODE_DISCORD_BOT_LOOPBACK_URL__/tool"

const targetSchema = tool.schema
  .object({
    guildId: tool.schema.string().describe("Discord guild ID."),
    channelId: tool.schema.string().describe("Discord channel ID."),
    threadId: tool.schema.string().optional().describe("Discord thread ID, when targeting a thread.")
  })
  .describe("Discord channel or thread target for file attachment.")

export default tool({
  description: "Attach a generated project file to Discord through the local opencode-discord-bot process.",
  args: {
    target: targetSchema,
    path: tool.schema.string().describe("Project-relative file path to attach.")
  },
  async execute(request) {
    const response = await fetch(loopbackToolUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "attachFile", target: request.target, args: { path: request.path } })
    })
    const payload = await response.json()
    return JSON.stringify(payload, null, 2) ?? String(payload)
  }
})
