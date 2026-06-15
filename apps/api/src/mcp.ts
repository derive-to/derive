// Remote MCP endpoint — Dock as a Model Context Protocol server an AI client
// (claude.ai / Claude Desktop) connects to over Streamable HTTP, authenticated by
// the same OAuth 2.1 bearer the rest of the app uses. It's the transport for the
// agentic loop: the agent connects once, then observes the plan (and, in later
// phases, diffs it and proposes revisions) without a static token.
//
// Stateless + fetch-native (no Durable Object, no nodejs_compat): a fresh McpServer
// is built per request closing over the resolved agent identity, so tool calls act
// in exactly that bearer's workspace at that bearer's role. Runs identically on the
// Node tier and the Cloudflare Workers tier — same `createApp`.

import type { AgentRecord, ArtifactRecord } from "@dock/core"
import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "./context"

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))

// Tool reads are bounded so a big artifact can never blow the client's context
// window (Claude caps tool responses at ~25k tokens; ~80k chars is a safe ceiling).
const MAX_CHARS = 80_000
const clip = (s: string) =>
  s.length > MAX_CHARS
    ? `${s.slice(0, MAX_CHARS)}\n\n…[truncated ${s.length - MAX_CHARS} chars]`
    : s

const summarizeArtifact = (a: ArtifactRecord) => ({
  short_id: a.short_id,
  title: a.title,
  kind: a.kind,
  version: a.current_version,
  visibility: a.visibility,
  removed: !!a.removed_at,
})

/**
 * A new MCP server for one request, scoped to `agent` (the OAuth-resolved identity).
 * Phase 0 is read-only — the agent can see what it's working on; the write/loop
 * tools (diff, propose, catch_me_up) land in Phase 1.
 */
function buildServer(ctx: AppContext, agent: AgentRecord): McpServer {
  const server = new McpServer({ name: "dock", version: "1.0.0" })
  const org = agent.org_id

  // Resolve a short id within the caller's workspace (never another org's artifact).
  const own = async (shortId: string): Promise<ArtifactRecord | null> => {
    const a = await ctx.meta.getByShortId(shortId)
    return a && a.org_id === org ? a : null
  }

  server.registerTool(
    "whoami",
    {
      description:
        "Who you are to Dock: your agent name, the workspace you're acting in, and your role (what you're allowed to do). Call this first to confirm the connection.",
      inputSchema: {},
    },
    async () => json({ name: agent.name, workspace: org, role: agent.role }),
  )

  server.registerTool(
    "list_artifacts",
    {
      description:
        "List the artifacts (docs, plans, sites) in your workspace: short id, title, kind, current version, visibility. Start here to find what to read.",
      inputSchema: { query: z.string().optional().describe("Optional title search filter.") },
    },
    async ({ query }) => {
      const arts = await ctx.meta.listArtifacts({ orgId: org, q: query })
      return json({ count: arts.length, artifacts: arts.map(summarizeArtifact) })
    },
  )

  server.registerTool(
    "read_artifact",
    {
      description:
        "Read one artifact by its short id: its metadata plus the current version's text content. (Multi-page bundles report their shape here; per-page reads come with read_section.)",
      inputSchema: { short_id: z.string().describe("The artifact's short id, e.g. nk0dsral.") },
    },
    async ({ short_id }) => {
      const a = await own(short_id)
      if (!a) return text(`No artifact "${short_id}" in this workspace.`)
      const meta = summarizeArtifact(a)
      if (a.kind === "bundle")
        return json({
          ...meta,
          note: "Multi-page bundle; per-page content via read_section (soon).",
        })
      const v = await ctx.meta.getVersion(a.id, a.current_version)
      if (!v) return json({ ...meta, content: null })
      const bytes = await ctx.blobs.get(v.blob_key)
      const body = bytes ? new TextDecoder().decode(bytes) : ""
      return json({ ...meta, content_type: v.content_type, content: clip(body) })
    },
  )

  server.registerTool(
    "list_comments",
    {
      description:
        "The review feedback on an artifact: open and resolved comment threads with author, body, and the text each is anchored to. This is the agent's to-do list.",
      inputSchema: {
        short_id: z.string(),
        state: z.enum(["open", "resolved"]).optional().describe("Filter by thread state."),
      },
    },
    async ({ short_id, state }) => {
      const a = await own(short_id)
      if (!a) return text(`No artifact "${short_id}" in this workspace.`)
      const comments = await ctx.meta.listComments(a.id, state ? { state } : undefined)
      return json({
        count: comments.length,
        comments: comments.map((c) => ({
          thread: c.thread_id,
          author: c.author,
          state: c.state,
          base_version: c.base_version,
          body: c.body_md,
        })),
      })
    },
  )

  server.registerTool(
    "list_versions",
    {
      description:
        "The version history of an artifact, newest first: version number, checkpoint name, message, author, and timestamp. Use it to see how the plan has evolved.",
      inputSchema: { short_id: z.string() },
    },
    async ({ short_id }) => {
      const a = await own(short_id)
      if (!a) return text(`No artifact "${short_id}" in this workspace.`)
      const versions = await ctx.meta.listVersions(a.id)
      return json({
        current: a.current_version,
        versions: versions
          .slice()
          .reverse()
          .map((v) => ({
            n: v.n,
            name: v.name,
            message: v.message,
            author: v.author,
            created_at: v.created_at,
          })),
      })
    },
  )

  return server
}

/**
 * Mount the Streamable-HTTP MCP endpoint at /mcp, bearer-gated by the same agent
 * bridge the rest of the API uses. On a missing/invalid token we return the
 * spec-required 401 + WWW-Authenticate pointing at our protected-resource metadata,
 * which is how claude.ai auto-starts the OAuth handshake.
 */
export function mountMcp(app: Hono, ctx: AppContext): void {
  app.all("/mcp", async (c) => {
    const agent = await ctx.agentFor(c)
    if (!agent) {
      const meta = new URL("/.well-known/oauth-protected-resource", c.req.url).toString()
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
        401,
        { "WWW-Authenticate": `Bearer resource_metadata="${meta}"` },
      )
    }
    const server = buildServer(ctx, agent)
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return transport.handleRequest(c)
  })
}
