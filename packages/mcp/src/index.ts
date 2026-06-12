import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { createClient } from "./client"

const client = createClient({
  baseUrl: process.env.DOCK_SERVER ?? "http://localhost:8080",
  token: process.env.DOCK_TOKEN,
})

const server = new McpServer({ name: "dock", version: "0.1.0" })

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })

server.registerTool(
  "publish_artifact",
  {
    description: "Publish an HTML or Markdown artifact and get a permanent URL.",
    inputSchema: {
      content: z.string().describe("The artifact's text content (HTML or Markdown)."),
      filename: z.string().describe("Filename, e.g. report.html or notes.md."),
      title: z.string().optional(),
      slug: z.string().optional(),
      visibility: z.enum(["public", "link", "org", "password"]).optional(),
    },
  },
  async (args) => {
    const a = await client.publish(args)
    return text(`Published "${a.title}" → ${a.url}\nshort_id ${a.short_id} · v${a.current_version}`)
  },
)

server.registerTool(
  "publish_version",
  {
    description: "Publish a new version of an existing artifact (same URL).",
    inputSchema: {
      short_id: z.string(),
      content: z.string(),
      filename: z.string(),
      message: z.string().optional().describe("What changed in this version."),
      resolves: z
        .array(z.string())
        .optional()
        .describe("Comment ids whose threads this version resolves."),
    },
  },
  async ({ short_id, content, filename, message, resolves }) => {
    const a = await client.publish({ id: short_id, content, filename, message, resolves })
    const note = resolves?.length ? ` · resolved ${resolves.length} thread(s)` : ""
    return text(`${a.url} is now v${a.current_version}${note}`)
  },
)

server.registerTool(
  "get_artifact",
  {
    description:
      "Read an artifact's metadata and source content for a given version (defaults to current).",
    inputSchema: { short_id: z.string(), version: z.number().int().optional() },
  },
  async ({ short_id, version }) => {
    const a = await client.get(short_id)
    const body = await client.getContent(short_id, version)
    const v = version ?? a.current_version
    return text(`# ${a.title} (v${v}/${a.current_version}, ${a.kind})\n${a.url}\n\n---\n${body}`)
  },
)

server.registerTool(
  "list_versions",
  { description: "List an artifact's version history.", inputSchema: { short_id: z.string() } },
  async ({ short_id }) => {
    const a = await client.get(short_id)
    const lines = a.versions
      .map((v) => `v${v.n} · ${v.author} · ${v.message ?? ""} · ${v.created_at}`)
      .join("\n")
    return text(`${a.title} (${a.versions.length} versions)\n${lines}`)
  },
)

server.registerTool(
  "list_comments",
  {
    description: "List comment threads on an artifact (the feedback queue). Filter by state.",
    inputSchema: { short_id: z.string(), state: z.enum(["open", "resolved"]).optional() },
  },
  async ({ short_id, state }) => {
    const comments = await client.listComments(short_id, state)
    if (comments.length === 0) return text(`No ${state ?? ""} comments.`)
    const lines = comments.map(
      (c) =>
        `[${c.id}] thread ${c.thread_id} · ${c.state} · ${c.author} · base v${c.base_version}` +
        (c.anchor ? ` · @${c.anchor}` : "") +
        `\n  ${c.body_md}`,
    )
    return text(lines.join("\n"))
  },
)

server.registerTool(
  "reply_comment",
  {
    description: "Reply in an existing comment thread (agents can discuss, not just resolve).",
    inputSchema: { short_id: z.string(), thread_id: z.string(), body_md: z.string() },
  },
  async ({ short_id, thread_id, body_md }) => {
    const c = await client.createComment(short_id, { thread_id, body_md, author: "agent" })
    return text(`Replied in thread ${c.thread_id} (comment ${c.id}).`)
  },
)

await server.connect(new StdioServerTransport())
