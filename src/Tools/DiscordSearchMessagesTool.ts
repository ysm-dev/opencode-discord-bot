import { tool } from "@opencode-ai/plugin"

const loopbackToolUrl = "__OPENCODE_DISCORD_BOT_LOOPBACK_URL__/tool"

const targetSchema = tool.schema
  .object({
    guildId: tool.schema.string().describe("Discord guild/server ID to search within."),
    channelId: tool.schema.string().optional().describe("Optional active channel ID. Search is guild-wide unless the query uses in:."),
    threadId: tool.schema.string().optional().describe("Optional active thread ID. Search is guild-wide unless the query uses in:.")
  })
  .describe("Discord guild target for message search.")

export default tool({
  description:
    "Search Discord message history using Discord-style search syntax. Use free text plus operators like from:<@user>, mentions:<@user>, in:<#channel>, has:link, has:file, before:YYYY-MM-DD, after:YYYY-MM-DD, during:YYYY-MM-DD, pinned:true, sort:relevance, order:desc. Returns matching messages and total count. The active turn already includes recent messages by default; use this tool for older or specific messages.",
  args: {
    target: targetSchema,
    query: tool.schema.string().describe("Discord search query string, using the same operators a Discord user would type."),
    limit: tool.schema.number().int().positive().optional().describe("Results per page, 1-25. Default 25."),
    offset: tool.schema.number().int().optional().describe("Pagination offset. Default 0; Discord supports offsets up to 9975.")
  },
  async execute(request) {
    const response = await fetch(loopbackToolUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "searchMessages",
        target: request.target,
        args: { query: request.query, limit: request.limit, offset: request.offset }
      })
    })
    const payload = await response.json()
    return JSON.stringify(payload, null, 2) ?? String(payload)
  }
})
