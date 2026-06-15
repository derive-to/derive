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

import {
  type AgentRecord,
  type ArtifactRecord,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  diffLines,
  formatDiff,
  type VersionRecord,
} from "@dock/core"
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

const summarizeVersion = (v: VersionRecord) => ({
  n: v.n,
  name: v.name,
  message: v.message,
  author: v.author,
  created_at: v.created_at,
})

// A version's bundle manifest (null when it isn't a bundle / is unreadable). Lets
// the loop tools see a multi-page artifact's actual files, not just its entry doc.
const manifestOf = async (ctx: AppContext, v: VersionRecord): Promise<BundleManifest | null> => {
  if (v.content_type !== BUNDLE_CONTENT_TYPE) return null
  const bytes = await ctx.blobs.get(v.blob_key)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as BundleManifest
  } catch {
    return null
  }
}

// Bundle manifests store paths with a leading slash (/index.html); present them
// cleanly to the agent, and accept either form on the way back in.
const cleanPath = (p: string) => p.replace(/^\//, "")

// Which pages changed between two bundle versions — by comparing each file's
// content-addressed blob key. This is the "what's new" a coalesced catch-up needs.
const bundleFileChanges = (from: BundleManifest, to: BundleManifest) => ({
  added: Object.keys(to.files)
    .filter((p) => !from.files[p])
    .map(cleanPath),
  removed: Object.keys(from.files)
    .filter((p) => !to.files[p])
    .map(cleanPath),
  changed: Object.keys(to.files)
    .filter((p) => {
      const f = from.files[p]
      const t = to.files[p]
      return f && t && f.key !== t.key
    })
    .map(cleanPath),
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

  server.registerTool(
    "read_section",
    {
      description:
        "Read a specific page of a multi-page artifact (bundle), or the content of a single-file one. Omit `path` to list a bundle's pages first.",
      inputSchema: {
        short_id: z.string(),
        path: z
          .string()
          .optional()
          .describe("A page path within a bundle, e.g. agentic-loop.html. Omit to list pages."),
        version: z.number().optional().describe("Defaults to the current version."),
      },
    },
    async ({ short_id, path, version }) => {
      const a = await own(short_id)
      if (!a) return text(`No artifact "${short_id}" in this workspace.`)
      const n = version ?? a.current_version
      const v = await ctx.meta.getVersion(a.id, n)
      if (!v) return text(`No version ${n} (have 1..${a.current_version}).`)
      const manifest = await manifestOf(ctx, v)
      if (!manifest) {
        const body = await ctx.sourceText(v)
        return json({ short_id, version: n, path: null, content: clip(body ?? "") })
      }
      if (!path)
        return json({
          short_id,
          version: n,
          entry: cleanPath(manifest.entry),
          pages: Object.keys(manifest.files).map(cleanPath),
        })
      // Accept the page path with or without a leading slash.
      const file = manifest.files[path] ?? manifest.files[`/${cleanPath(path)}`]
      if (!file)
        return text(
          `No page "${path}". Pages: ${Object.keys(manifest.files).map(cleanPath).join(", ")}`,
        )
      const bytes = await ctx.blobs.get(file.key)
      return json({
        short_id,
        version: n,
        path: cleanPath(path),
        type: file.type,
        content: clip(bytes ? new TextDecoder().decode(bytes) : ""),
      })
    },
  )

  server.registerTool(
    "diff",
    {
      description:
        "What changed between two versions of an artifact: a unified diff of the entry document, plus (for bundles) which pages were added / removed / changed. `to` defaults to the current version.",
      inputSchema: {
        short_id: z.string(),
        from: z.number().describe("The base version number."),
        to: z.number().optional().describe("Defaults to the current version."),
      },
    },
    async ({ short_id, from, to }) => {
      const a = await own(short_id)
      if (!a) return text(`No artifact "${short_id}" in this workspace.`)
      const toN = to ?? a.current_version
      const vf = await ctx.meta.getVersion(a.id, from)
      const vt = await ctx.meta.getVersion(a.id, toN)
      if (!vf || !vt) return text(`Missing version (have 1..${a.current_version}).`)
      const [af, at] = [await ctx.sourceText(vf), await ctx.sourceText(vt)]
      if (af === null || at === null) return text("Version content is missing.")
      const [mf, mt] = [await manifestOf(ctx, vf), await manifestOf(ctx, vt)]
      return json({
        short_id,
        from,
        to: toN,
        pages_changed: mf && mt ? bundleFileChanges(mf, mt) : null,
        entry_diff: clip(formatDiff(diffLines(af, at))),
      })
    },
  )

  server.registerTool(
    "catch_me_up",
    {
      description:
        "The coalesced delta since you last looked: every version that landed since `since_version`, which pages changed, a diff of the entry document, and the open comment threads — everything you need to re-sync on the plan in one call. `since_version` defaults to the version before current.",
      inputSchema: {
        short_id: z.string(),
        since_version: z
          .number()
          .optional()
          .describe("The version you last saw. Defaults to current − 1."),
      },
    },
    async ({ short_id, since_version }) => {
      const a = await own(short_id)
      if (!a) return text(`No artifact "${short_id}" in this workspace.`)
      const head = a.current_version
      const since = Math.min(head, Math.max(1, since_version ?? head - 1))
      const newVersions = (await ctx.meta.listVersions(a.id)).filter((v) => v.n > since)
      const vs = await ctx.meta.getVersion(a.id, since)
      const vh = await ctx.meta.getVersion(a.id, head)
      let entryDiff: string | null = null
      let pagesChanged: ReturnType<typeof bundleFileChanges> | null = null
      if (vs && vh && since < head) {
        const [as_, ah] = [await ctx.sourceText(vs), await ctx.sourceText(vh)]
        if (as_ !== null && ah !== null) entryDiff = clip(formatDiff(diffLines(as_, ah)))
        const [ms, mh] = [await manifestOf(ctx, vs), await manifestOf(ctx, vh)]
        if (ms && mh) pagesChanged = bundleFileChanges(ms, mh)
      }
      const open = await ctx.meta.listComments(a.id, { state: "open" })
      return json({
        short_id,
        since,
        head,
        caught_up: since >= head,
        new_versions: newVersions.map(summarizeVersion),
        pages_changed: pagesChanged,
        entry_diff: entryDiff,
        open_comments: open.map((c) => ({
          thread: c.thread_id,
          author: c.author,
          body: c.body_md,
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
