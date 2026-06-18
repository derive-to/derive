// Remote MCP endpoint — Dock as a Model Context Protocol server an AI client
// (claude.ai / Claude Code) connects to over Streamable HTTP, authenticated by the
// same OAuth 2.1 bearer the rest of the app uses. It's the transport for the agentic
// loop: connect once, see what changed (catch_me_up), read, and propose revisions a
// human approves — no static token.
//
// Stateless + fetch-native (no Durable Object, no nodejs_compat): a fresh McpServer
// is built per request closing over the resolved agent identity, so tool calls act
// in exactly that bearer's workspace at that bearer's role. Runs identically on the
// Node tier and the Cloudflare Workers tier — same `createApp`.
//
// Tool design follows Anthropic's "Writing effective tools for agents": few tools
// shaped to the agent's workflow (not the API surface), high-signal responses with
// truncate-and-steer, semantic ids (short_id / vN / page path — never UUIDs),
// actionable errors, and identity carried in the server `instructions` rather than a
// tool slot.

import {
  type AgentRecord,
  type ArtifactRecord,
  artifactUrl,
  type BundleManifest,
  diffLines,
  formatDiff,
  PublishError,
  propose as proposeChange,
  publish as publishVersion,
  roleAllows,
  type VersionRecord,
} from "@dock/core"
import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { zipSync } from "fflate"
import type { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "./context"
import { markAddressed } from "./lib/addressed"
import { cleanPath, manifestOf as sharedManifestOf } from "./lib/bundle"
import { quoteOf } from "./lib/comments"

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))

// Pack a {path: content} map into a zip the core publish path can ingest exactly
// like an HTTP bundle upload (it re-validates size, paths, and entry point). Text
// pages only — binary assets still go through the multipart/zip HTTP route.
const zipFromFiles = (files: Record<string, string>): Uint8Array => {
  const enc = new TextEncoder()
  const entries: Record<string, Uint8Array> = {}
  for (const [path, content] of Object.entries(files)) entries[path] = enc.encode(content)
  return zipSync(entries)
}
// An actionable error the model can recover from (per the MCP spec, isError text is
// fed back to the agent so it self-corrects), rather than an opaque failure.
const err = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true as const,
})

// Tool reads are bounded so a big artifact can never blow the client's context
// window (Claude caps tool responses at ~25k tokens; ~80k chars is a safe ceiling).
const MAX_CHARS = 80_000
const clip = (s: string) =>
  s.length > MAX_CHARS
    ? `${s.slice(0, MAX_CHARS)}\n\n…[truncated ${s.length - MAX_CHARS} chars — read a specific section]`
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

// A version's bundle manifest, presented cleanly. Lets the loop tools see a
// multi-page artifact's actual files, not just its entry doc.
const manifestOf = (ctx: AppContext, v: VersionRecord) => sharedManifestOf(ctx.blobs, v)

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

const changeCount = (c: ReturnType<typeof bundleFileChanges>) =>
  c.added.length + c.changed.length + c.removed.length

/**
 * A new MCP server for one request, scoped to `agent` (the OAuth-resolved identity).
 * Tools act in the bearer's workspace at the bearer's role: reads for anyone, and
 * `propose` (the human-in-the-loop write) for commenter+ — a proposal never goes
 * live without a human approving it, so an agent is a safe contributor, not a
 * publisher. Identity rides in the server `instructions` (below), not a `whoami`
 * tool — it's a one-shot fact, not a per-call action.
 */
function buildServer(ctx: AppContext, agent: AgentRecord): McpServer {
  // Steer the write guidance by what this grant can actually do: a publish-capable
  // grant gets the create/publish path; a lower grant is pointed at propose only.
  const writeGuidance = roleAllows(agent.role, "publish")
    ? `Use publish to create a new artifact (omit short_id) or push a new version of one you own — ` +
      `it goes live immediately in your workspace. Use propose to suggest changes to artifacts you ` +
      `don't own, which a human approves. `
    : `Work the open threads from list_comments and use propose to suggest a revision a human ` +
      `approves — you cannot publish directly. `
  const server = new McpServer(
    { name: "dock", version: "1.0.0" },
    {
      instructions:
        `You are connected to Dock as "${agent.name}", acting in workspace ${agent.org_id} ` +
        `with ${agent.role} permissions. Dock hosts living documents and plans with versioned ` +
        `history, text-anchored review comments, and a propose → review → revise loop. ` +
        `Start a session with catch_me_up to re-sync on what changed; use read to view content ` +
        `(outline first for multi-page bundles). ${writeGuidance}When a ` +
        `proposal fixes specific feedback, pass those thread ids as propose's "addresses" so the ` +
        `threads show as pending and auto-resolve on approval.`,
    },
  )
  const org = agent.org_id

  // Resolve a short id within the caller's workspace (never another org's artifact).
  const own = async (shortId: string): Promise<ArtifactRecord | null> => {
    const a = await ctx.meta.getByShortId(shortId)
    return a && a.org_id === org ? a : null
  }
  const notFound = (shortId: string) =>
    err(`No artifact "${shortId}" in your workspace. Call list_artifacts to see what's here.`)

  server.registerTool(
    "list_artifacts",
    {
      description:
        "List the artifacts (docs, plans, sites) in your workspace — short id, title, kind, current version, visibility. Start here to find what to work on, then catch_me_up or read it.",
      inputSchema: { query: z.string().optional().describe("Optional title search filter.") },
    },
    async ({ query }) => {
      const arts = await ctx.meta.listArtifacts({ orgId: org, q: query })
      return json({ count: arts.length, artifacts: arts.map(summarizeArtifact) })
    },
  )

  server.registerTool(
    "catch_me_up",
    {
      description:
        "START HERE on an artifact. The coalesced delta since you last saw it (`since_version`): a one-line summary, the versions that landed, which pages changed, and the open comment threads — everything to re-sync in one call. For an exact line-by-line comparison of two specific versions, use `diff` instead. Pass response_format='detailed' to also include the entry-document diff inline.",
      inputSchema: {
        short_id: z.string(),
        since_version: z
          .number()
          .optional()
          .describe("The version you last saw. Defaults to current − 1."),
        response_format: z
          .enum(["summary", "detailed"])
          .optional()
          .describe(
            "'summary' (default, token-light) omits the line diff; 'detailed' includes it.",
          ),
      },
    },
    async ({ short_id, since_version, response_format }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      const head = a.current_version
      const since = Math.min(head, Math.max(1, since_version ?? head - 1))
      const newVersions = (await ctx.meta.listVersions(a.id)).filter((v) => v.n > since)
      const vs = await ctx.meta.getVersion(a.id, since)
      const vh = await ctx.meta.getVersion(a.id, head)
      let entryDiff: string | null = null
      let pagesChanged: ReturnType<typeof bundleFileChanges> | null = null
      if (vs && vh && since < head) {
        const [ms, mh] = [await manifestOf(ctx, vs), await manifestOf(ctx, vh)]
        if (ms && mh) pagesChanged = bundleFileChanges(ms, mh)
        if (response_format === "detailed") {
          const [as_, ah] = [await ctx.sourceText(vs), await ctx.sourceText(vh)]
          if (as_ !== null && ah !== null) entryDiff = clip(formatDiff(diffLines(as_, ah)))
        }
      }
      const open = await ctx.meta.listComments(a.id, { state: "open" })
      // Threads whose quoted text changed in a landed version — feedback that may
      // no longer apply. Surfacing the count tells the agent its (or someone's)
      // edits touched commented passages.
      const outdated = await ctx.meta.listComments(a.id, { state: "outdated" })
      const outdatedBit = outdated.length
        ? ` ${outdated.length} now outdated (the quoted text changed).`
        : ""
      // Threads with a proposal already pending — the agent shouldn't re-propose them.
      const addressed = await ctx.meta.listComments(a.id, { state: "addressed" })
      const addressedBit = addressed.length
        ? ` ${addressed.length} addressed (a proposal is pending review).`
        : ""
      const pageBits =
        pagesChanged && changeCount(pagesChanged)
          ? ` Pages: ${[
              pagesChanged.added.length && `+${pagesChanged.added.length}`,
              pagesChanged.changed.length && `~${pagesChanged.changed.length}`,
              pagesChanged.removed.length && `-${pagesChanged.removed.length}`,
            ]
              .filter(Boolean)
              .join(" ")}.`
          : ""
      const summary =
        since >= head
          ? `You're up to date on "${a.title}" (v${head}); ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}`
          : `"${a.title}": ${newVersions.length} new version${newVersions.length === 1 ? "" : "s"} since v${since} (now v${head}).${pageBits} ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}`
      return json({
        summary,
        short_id,
        since,
        head,
        caught_up: since >= head,
        new_versions: newVersions.map(summarizeVersion),
        pages_changed: pagesChanged,
        ...(entryDiff
          ? { entry_diff: entryDiff }
          : {
              entry_diff:
                "(omitted) — call again with response_format='detailed', or diff(from, to), for the line-level changes.",
            }),
        open_comments: open.map((c) => ({
          thread: c.thread_id,
          author: c.author,
          quote: quoteOf(c.anchor),
          body: c.body_md,
        })),
        // Only included when non-empty, to keep the common response lean.
        ...(outdated.length
          ? {
              outdated_comments: outdated.map((c) => ({
                thread: c.thread_id,
                author: c.author,
                quote: quoteOf(c.anchor),
                body: c.body_md,
              })),
            }
          : {}),
      })
    },
  )

  server.registerTool(
    "read",
    {
      description:
        "Read an artifact's content by short id. Multi-page bundle: omit `section` to get its outline (the list of pages), then call again with a `section` (a page path) for that page's full text. Single-file artifact: returns the full content. Pass a past `version` to read history.",
      inputSchema: {
        short_id: z.string().describe("The artifact's short id, e.g. nk0dsral."),
        section: z
          .string()
          .optional()
          .describe("A bundle page path, e.g. agentic-loop.html. Omit to get the outline first."),
        version: z.number().optional().describe("Defaults to the current version."),
      },
    },
    async ({ short_id, section, version }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      const n = version ?? a.current_version
      if (n < 1 || n > a.current_version)
        return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
      const v = await ctx.meta.getVersion(a.id, n)
      if (!v) return err(`Version ${n} of "${short_id}" is unavailable.`)
      const manifest = await manifestOf(ctx, v)
      if (!manifest) {
        // Single-file artifact — return its content.
        const body = await ctx.sourceText(v)
        return json({
          short_id,
          title: a.title,
          kind: a.kind,
          version: n,
          content: clip(body ?? ""),
        })
      }
      const pages = Object.keys(manifest.files).map(cleanPath)
      if (!section)
        return json({
          short_id,
          title: a.title,
          kind: "bundle",
          version: n,
          entry: cleanPath(manifest.entry),
          pages,
          next: "Call read again with a `section` (one of the pages above) for that page's content.",
        })
      const file = manifest.files[section] ?? manifest.files[`/${cleanPath(section)}`]
      if (!file) return err(`No page "${section}" in "${short_id}". Pages: ${pages.join(", ")}.`)
      const bytes = await ctx.blobs.get(file.key)
      return json({
        short_id,
        version: n,
        section: cleanPath(section),
        type: file.type,
        content: clip(bytes ? new TextDecoder().decode(bytes) : ""),
      })
    },
  )

  server.registerTool(
    "diff",
    {
      description:
        "Exact line-by-line comparison of two versions of an artifact: a unified diff of the entry document, plus (for bundles) which pages were added / removed / changed. For a summary of everything new since you last looked, prefer catch_me_up. `to` defaults to the current version.",
      inputSchema: {
        short_id: z.string(),
        from: z.number().describe("The base version number."),
        to: z.number().optional().describe("Defaults to the current version."),
      },
    },
    async ({ short_id, from, to }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      const toN = to ?? a.current_version
      const vf = await ctx.meta.getVersion(a.id, from)
      const vt = await ctx.meta.getVersion(a.id, toN)
      if (!vf || !vt)
        return err(`Missing version — "${short_id}" has versions 1..${a.current_version}.`)
      const [af, at] = [await ctx.sourceText(vf), await ctx.sourceText(vt)]
      if (af === null || at === null) return err("Version content is unavailable.")
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
    "list_comments",
    {
      description:
        "The review feedback on an artifact: comment threads with author, body, the quoted text they're anchored to, the version they were left on, and state. This is your to-do list before proposing — work the `open` threads. State is open (live feedback), addressed (a proposal you/someone made is pending review for it — don't re-propose), resolved (settled), or outdated (the quoted text changed in a later version, so the feedback may no longer apply — verify before acting). Filter by `state`; default lists all.",
      inputSchema: {
        short_id: z.string(),
        state: z
          .enum(["open", "addressed", "resolved", "outdated"])
          .optional()
          .describe("Filter by thread state. Omit to list every thread."),
      },
    },
    async ({ short_id, state }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      const comments = await ctx.meta.listComments(a.id, state ? { state } : undefined)
      return json({
        count: comments.length,
        comments: comments.map((c) => ({
          thread: c.thread_id,
          author: c.author,
          state: c.state,
          base_version: c.base_version,
          // The quoted text the thread is anchored to (null for whole-document
          // feedback) — tells the agent WHERE in the artifact the note applies.
          quote: quoteOf(c.anchor),
          path: c.path,
          body: c.body_md,
        })),
      })
    },
  )

  server.registerTool(
    "list_versions",
    {
      description:
        "The version history of an artifact, newest first: number, checkpoint name, message, author, timestamp. For what actually changed between versions, use diff or catch_me_up.",
      inputSchema: { short_id: z.string() },
    },
    async ({ short_id }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      const versions = await ctx.meta.listVersions(a.id)
      return json({
        current: a.current_version,
        versions: versions.slice().reverse().map(summarizeVersion),
      })
    },
  )

  server.registerTool(
    "propose",
    {
      description:
        "Propose a revised version of a single-file artifact for human review. It does NOT go live — a reviewer approves it or requests changes, so you're a safe contributor, not a publisher. Provide the FULL new content (not a patch) and a rationale that tells the reviewer what changed and why. Pass `addresses` with the thread ids (from list_comments) this revision resolves — those threads show as `addressed` (pending review) and auto-resolve when the proposal is approved. Multi-page bundles aren't proposable over MCP yet.",
      inputSchema: {
        short_id: z.string(),
        content: z
          .string()
          .describe("The complete new content of the document (HTML or Markdown)."),
        message: z
          .string()
          .min(1)
          .describe("What you changed and why — shown to the reviewer. Required."),
        filename: z
          .string()
          .optional()
          .describe("Filename hint for the content type, e.g. index.html or notes.md."),
        addresses: z
          .array(z.string())
          .optional()
          .describe(
            "Thread ids (from list_comments) this revision resolves. They flip to `addressed` and resolve on approval.",
          ),
      },
    },
    async ({ short_id, content, message, filename, addresses }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      if (agent.role === "viewer")
        return err(
          "Your grant is read-only (dock:read). Re-authorize the connector with dock:propose to propose changes.",
        )
      if (a.kind === "bundle")
        return err(
          `"${short_id}" is a multi-page bundle; proposing bundle revisions over MCP isn't supported yet (single-file artifacts only).`,
        )
      try {
        const { proposal } = await proposeChange(ctx.meta, ctx.blobs, short_id, {
          bytes: new TextEncoder().encode(content),
          filename: filename ?? "index.html",
          isBundle: false,
          message,
          author: agent.name,
          author_id: agent.id,
        })
        const addressed = addresses?.length
          ? await markAddressed(ctx.meta, a.id, proposal.id, addresses)
          : []
        for (const threadId of addressed)
          ctx.bus.publish(a.id, {
            type: "comment.addressed",
            thread_id: threadId,
            state: "addressed",
          })
        return json({
          proposed: true,
          proposal_id: proposal.id,
          base_version: proposal.base_version,
          addressed,
          note: "Submitted for review — a human approves it or requests changes. It is NOT live yet.",
        })
      } catch (e) {
        return err(
          `Couldn't store the proposal: ${e instanceof PublishError ? e.message : "unknown error"}.`,
        )
      }
    },
  )

  server.registerTool(
    "publish",
    {
      description:
        "Publish an artifact to your workspace DIRECTLY — it goes live immediately, no review. Provide `content` for a SINGLE-FILE artifact, or `files` (a map of page path → content) for a MULTI-PAGE BUNDLE. OMIT short_id to create a NEW artifact (a first publish) — `title` is then required. PASS short_id to publish a new version of one you already own, matching its kind: a bundle takes `files`, a single file takes `content`. A bundle republish REPLACES the whole bundle, so include EVERY page. Requires publish rights (Creator/Admin role on the workspace); a commenter-level grant should use `propose` instead. Provide the FULL content (not a patch).",
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe(
            "The complete content for a SINGLE-FILE artifact (HTML or Markdown). Use this OR `files`, not both.",
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'A MULTI-PAGE bundle as a map of page path → content, e.g. {"index.html":"…","about.html":"…","nav.js":"…"}. The root index.html (else the shallowest .html) becomes the entry page. A republish REPLACES the bundle, so include every page. Text pages only — zip-upload via the HTTP API for binary assets.',
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Title for a NEW artifact (required when creating). On republish, renames only if provided.",
          ),
        short_id: z
          .string()
          .optional()
          .describe(
            "Omit to create a new artifact; pass it to publish a new version of one you own.",
          ),
        visibility: z
          .enum(["workspace", "link", "public"])
          .optional()
          .describe(
            "Who can see a NEW artifact: workspace (your team, default), link (anyone with the link), or public (discoverable). Ignored on republish.",
          ),
        spa: z
          .boolean()
          .optional()
          .describe(
            "For a NEW bundle only: serve unknown paths from the entry page (single-page-app routing). Default false.",
          ),
        message: z.string().optional().describe("What changed — recorded as the version message."),
        filename: z
          .string()
          .optional()
          .describe(
            "Filename hint for the content type of a single file, e.g. index.html or notes.md.",
          ),
      },
    },
    async ({ content, files, title, short_id, visibility, spa, message, filename }) => {
      // Direct publish is gated on the agent's role: Creator/Admin only. A
      // commenter-level grant is steered to `propose` (human-reviewed), so a
      // low-privilege agent still can't push live content.
      if (!roleAllows(agent.role, "publish"))
        return text(
          "Your grant can't publish directly (needs a Creator/Admin role). Use `propose` to submit a reviewed change, or re-authorize with a publish scope.",
        )
      // Exactly one of content / files. `files` (a page map) means a bundle.
      const isBundle = !!files && Object.keys(files).length > 0
      if (isBundle && content !== undefined)
        return text("Provide `content` (single file) OR `files` (a bundle), not both.")
      if (!isBundle && (content === undefined || content === ""))
        return text("Provide `content` (single file) or `files` (a multi-page bundle).")
      if (short_id) {
        const a = await own(short_id)
        if (!a) return text(`No artifact "${short_id}" in this workspace.`)
        // Kind can't change on republish; steer to the right field instead of
        // bubbling the core's 409.
        if (a.kind === "bundle" && !isBundle)
          return text(
            `"${short_id}" is a multi-page bundle — pass \`files\` (every page) to republish it.`,
          )
        if (a.kind === "file" && isBundle)
          return text(`"${short_id}" is a single-file artifact — pass \`content\`, not \`files\`.`)
      } else if (!title?.trim()) {
        return text("Creating a new artifact needs a `title`.")
      }
      try {
        const { artifact, version } = await publishVersion(
          ctx.meta,
          ctx.blobs,
          {
            bytes: isBundle
              ? zipFromFiles(files as Record<string, string>)
              : new TextEncoder().encode(content as string),
            filename: isBundle ? `${title?.trim() || "bundle"}.zip` : (filename ?? "index.html"),
            isBundle,
            spa: isBundle ? !!spa : undefined,
            title: title?.trim(),
            message,
            author: agent.name,
            // New artifacts land in the granting user's workspace, private to the
            // team by default (never link-public unless they ask).
            orgId: agent.org_id,
            visibility: visibility === "link" ? "link" : visibility === "public" ? "public" : "org",
          },
          short_id,
        )
        return json({
          published: true,
          short_id: artifact.short_id,
          kind: artifact.kind,
          version: version.n,
          url: artifactUrl(ctx.deps.baseUrl, artifact),
          title: artifact.title,
          visibility: artifact.visibility,
          note: short_id
            ? "Live now — published a new current version."
            : "Live now — created a new artifact in your workspace.",
        })
      } catch (e) {
        const msg = e instanceof PublishError ? e.message : "could not publish"
        return text(`Publish failed: ${msg}`)
      }
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
