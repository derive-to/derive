// Remote MCP endpoint — Dock as a Model Context Protocol server an AI client
// (claude.ai / Claude Code) connects to over Streamable HTTP, authenticated by the
// same OAuth 2.1 bearer the rest of the app uses. It's the transport for the agentic
// loop: connect once, see what changed (catch_up), read, comment, and publish a
// revision — no static token.
//
// Stateless + fetch-native (no Durable Object, no nodejs_compat): a fresh McpServer
// is built per request closing over the resolved agent identity, so tool calls act
// in exactly that bearer's workspace at that bearer's role. Runs identically on the
// Node tier and the Cloudflare Workers tier — same `createApp`.
//
// Tool design follows Anthropic's "Writing effective tools for agents": a small set
// shaped to the agent's workflow (not the API surface), high-signal responses with
// truncate-and-steer, semantic ids (short_id / vN / page path — never UUIDs),
// actionable errors, and identity carried in the server `instructions` rather than a
// tool slot. Five tools, one per intent — FIND (list_artifacts), READ content (read),
// CATCH UP on state/feedback/history (catch_up), COMMENT (comment), and WRITE
// (publish). Variation lives in parameters: `since_version`/`to_version` turn
// catch_up into a diff, `reply_to`/`set_state` fold reply+resolve into comment, and
// `for_review`/role turn publish into a human-reviewed proposal.

import {
  type AgentRecord,
  type ArtifactRecord,
  artifactUrl,
  type BundleManifest,
  diffLines,
  formatDiff,
  MergeConflictError,
  newId,
  PublishError,
  propose as proposeChange,
  publish as publishVersion,
  roleAllows,
  type VersionRecord,
} from "@dock/core"
import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "./context"
import { markAddressed } from "./lib/addressed"
import {
  cleanPath,
  mergeBundleZip,
  manifestOf as sharedManifestOf,
  zipBundleFiles,
} from "./lib/bundle"
import { quoteOf } from "./lib/comments"

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))
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

const summarizeComment = (c: {
  thread_id: string
  author: string
  state?: string
  base_version?: number
  anchor: string | null
  path?: string | null
  body_md: string
}) => ({
  thread: c.thread_id,
  author: c.author,
  ...(c.state ? { state: c.state } : {}),
  ...(c.base_version != null ? { base_version: c.base_version } : {}),
  quote: quoteOf(c.anchor),
  ...(c.path ? { path: c.path } : {}),
  body: c.body_md,
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
 * Tools act in the bearer's workspace at the bearer's role: reads + comments for
 * commenter+, and writes via `publish` — which goes live for an editor/owner, or is
 * filed as a human-reviewed proposal for a commenter (or anyone passing
 * `for_review`). So a low-privilege agent is a safe contributor, not a publisher.
 * Identity rides in the server `instructions` (below), not a `whoami` tool — it's a
 * one-shot fact, not a per-call action.
 */
function buildServer(ctx: AppContext, agent: AgentRecord): McpServer {
  // Steer the write guidance by what this grant can actually do: a publish-capable
  // grant gets the direct-publish path; a lower grant is told its writes go to review.
  const writeGuidance = roleAllows(agent.role, "publish")
    ? `Use publish to create a new artifact (omit short_id) or push a new version of one (pass short_id) — ` +
      `it goes live immediately. Pass for_review:true to file it as a proposal a human approves instead. `
    : `Use publish to submit a revision — at your role it is filed as a proposal a human approves before it ` +
      `goes live; you cannot publish directly. `
  const server = new McpServer(
    { name: "dock", version: "1.0.0" },
    {
      instructions:
        `You are connected to Dock as "${agent.name}", acting in workspace ${agent.org_id} ` +
        `with ${agent.role} permissions. Dock hosts living documents and plans with versioned ` +
        `history, text-anchored review comments, and a publish → review → revise loop. ` +
        `Start a session with catch_up to re-sync on what changed and what feedback is open; use ` +
        `read to view content (outline first for multi-page bundles); use comment to leave or ` +
        `resolve feedback. ${writeGuidance}When a revision fixes specific feedback, pass those ` +
        `thread ids as publish's "addresses" so the threads resolve (or show pending on a proposal).`,
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

  // FIND ----------------------------------------------------------------------
  server.registerTool(
    "list_artifacts",
    {
      description:
        "List the artifacts (docs, plans, sites) in your workspace — short id, title, kind, current version, visibility. Start here to find what to work on, then catch_up or read it.",
      inputSchema: { query: z.string().optional().describe("Optional title search filter.") },
    },
    async ({ query }) => {
      const arts = await ctx.meta.listArtifacts({ orgId: org, q: query })
      return json({ count: arts.length, artifacts: arts.map(summarizeArtifact) })
    },
  )

  // READ CONTENT --------------------------------------------------------------
  server.registerTool(
    "read",
    {
      description:
        "Read an artifact's CONTENT by short id. Multi-page bundle: omit `section` to get its outline (the list of pages), then call again with a `section` (a page path) for that page's full text. Single-file artifact: returns the full content. Pass a past `version` to read history. (For what CHANGED, or the comment threads, use catch_up.)",
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

  // CATCH UP — state, feedback, history, and diffs all in one ------------------
  server.registerTool(
    "catch_up",
    {
      description:
        "START HERE on an artifact. The state of it in one call: a one-line summary, the versions that landed since `since_version`, which pages changed, the open (and outdated) comment threads, and the full version history. " +
        "Pass `comments` (open / addressed / resolved / outdated) to instead get that filtered thread list — your feedback to-do queue. " +
        "Pass `response_format='detailed'` (optionally with `since_version`/`to_version`) to include the exact line-by-line diff between two versions.",
      inputSchema: {
        short_id: z.string(),
        since_version: z
          .number()
          .optional()
          .describe("The version you last saw (the diff base). Defaults to to_version − 1."),
        to_version: z
          .number()
          .optional()
          .describe("Compare up to this version instead of the current one (for an exact diff)."),
        comments: z
          .enum(["open", "addressed", "resolved", "outdated"])
          .optional()
          .describe(
            "Return ONLY this state's comment threads (the feedback queue) instead of the delta.",
          ),
        response_format: z
          .enum(["summary", "detailed"])
          .optional()
          .describe(
            "'summary' (default, token-light) omits the line diff; 'detailed' includes it.",
          ),
      },
    },
    async ({ short_id, since_version, to_version, comments, response_format }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)

      // `comments` filter → the feedback to-do queue (absorbs the old list_comments).
      if (comments) {
        const list = await ctx.meta.listComments(a.id, { state: comments })
        return json({
          short_id,
          comments_state: comments,
          count: list.length,
          comments: list.map(summarizeComment),
        })
      }

      const head = a.current_version
      const to = Math.min(head, Math.max(1, to_version ?? head))
      const since = Math.min(to, Math.max(1, since_version ?? to - 1))
      const history = await ctx.meta.listVersions(a.id)
      const newVersions = history.filter((v) => v.n > since && v.n <= to)
      const vs = await ctx.meta.getVersion(a.id, since)
      const vh = await ctx.meta.getVersion(a.id, to)
      let entryDiff: string | null = null
      let pagesChanged: ReturnType<typeof bundleFileChanges> | null = null
      if (vs && vh && since < to) {
        const [ms, mh] = [await manifestOf(ctx, vs), await manifestOf(ctx, vh)]
        if (ms && mh) pagesChanged = bundleFileChanges(ms, mh)
        if (response_format === "detailed") {
          const [as_, ah] = [await ctx.sourceText(vs), await ctx.sourceText(vh)]
          if (as_ !== null && ah !== null) entryDiff = clip(formatDiff(diffLines(as_, ah)))
        }
      }
      const open = await ctx.meta.listComments(a.id, { state: "open" })
      // Threads whose quoted text changed in a landed version — feedback that may no
      // longer apply. Surfacing it tells the agent its edits touched commented text.
      const outdated = await ctx.meta.listComments(a.id, { state: "outdated" })
      const outdatedBit = outdated.length
        ? ` ${outdated.length} now outdated (the quoted text changed).`
        : ""
      // Threads with a proposal already pending — the agent shouldn't re-address them.
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
        since >= to
          ? `You're up to date on "${a.title}" (v${head}); ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}`
          : `"${a.title}": ${newVersions.length} new version${newVersions.length === 1 ? "" : "s"} since v${since} (now v${to}).${pageBits} ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}`
      return json({
        summary,
        short_id,
        since,
        to,
        head,
        caught_up: since >= to,
        versions: history.slice().reverse().map(summarizeVersion),
        new_versions: newVersions.map(summarizeVersion),
        pages_changed: pagesChanged,
        ...(entryDiff
          ? { entry_diff: entryDiff }
          : {
              entry_diff:
                "(omitted) — call again with response_format='detailed' for the line-level changes.",
            }),
        open_comments: open.map(summarizeComment),
        ...(outdated.length ? { outdated_comments: outdated.map(summarizeComment) } : {}),
      })
    },
  )

  // COMMENT — leave / reply / resolve feedback --------------------------------
  server.registerTool(
    "comment",
    {
      description:
        "Leave feedback on an artifact, reply in a thread, and/or resolve or reopen a thread — all in one tool. Anchor a NEW comment to a quoted span of the rendered text with `quote`. Reply by passing the thread id as `reply_to`. Resolve or reopen by passing `set_state` along with the thread's id in `reply_to`. Thread ids come from catch_up.",
      inputSchema: {
        short_id: z.string(),
        body: z
          .string()
          .optional()
          .describe("The comment text (Markdown). Omit only when just changing thread state."),
        reply_to: z
          .string()
          .optional()
          .describe(
            "A thread id (from catch_up): reply in that thread, and/or the thread to set_state on.",
          ),
        quote: z
          .string()
          .optional()
          .describe("Exact text in the rendered document to anchor a NEW comment to."),
        set_state: z
          .enum(["resolved", "open"])
          .optional()
          .describe("Resolve the thread, or reopen it (with `reply_to`)."),
      },
    },
    async ({ short_id, body, reply_to, quote, set_state }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      if (!roleAllows(agent.role, "comment"))
        return err(
          "Your grant is read-only (dock:read). Re-authorize the connector with dock:comment to leave feedback.",
        )
      if (!body && !set_state)
        return err("Provide `body` (to comment) or `set_state` (to resolve/reopen a thread).")
      let thread = reply_to
      let commentId: string | undefined
      if (body) {
        commentId = newId("c")
        thread = reply_to || commentId
        const anchor = quote ? JSON.stringify({ type: "TextQuoteSelector", exact: quote }) : null
        await ctx.meta.createComment({
          id: commentId,
          artifact_id: a.id,
          thread_id: thread,
          base_version: a.current_version,
          path: null,
          anchor,
          body_md: body,
          author: agent.name,
          author_id: agent.id,
        })
        ctx.bus.publish(a.id, { type: "comment.created" })
      }
      if (set_state) {
        if (!thread) return err("`set_state` needs `reply_to` (the thread id to resolve/reopen).")
        await ctx.meta.setThreadState(a.id, thread, set_state)
        ctx.bus.publish(a.id, { type: "comment.resolved", thread_id: thread, state: set_state })
      }
      return json({
        short_id,
        thread,
        ...(commentId ? { comment_id: commentId, anchored_to: quote ?? null } : {}),
        ...(set_state ? { state: set_state } : {}),
        note: body
          ? reply_to
            ? "Replied in the thread."
            : "New comment thread created."
          : `Thread ${set_state}.`,
      })
    },
  )

  // WRITE — publish live, or file a proposal for review -----------------------
  server.registerTool(
    "publish",
    {
      description:
        "Save a revision of an artifact. It goes LIVE immediately if your role can publish (Creator/Admin); otherwise — or whenever you pass for_review:true — it is filed as a PROPOSAL a human approves before it goes live. Provide `content` for a SINGLE-FILE artifact, or `files` (a map of page path → content) for a MULTI-PAGE BUNDLE (a whole site, images and any binary asset). OMIT short_id to create a NEW artifact (`title` required); PASS short_id to add a version to one you own, matching its kind. A bundle republish REPLACES the whole bundle, so include EVERY page and asset (or use `merge`). Pass `addresses` with the thread ids (from catch_up) this revision resolves. Provide the FULL content, not a patch. (Proposals are single-file only; bundles must be published directly.)",
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
            'A MULTI-PAGE bundle as a map of path → content — the whole site. Text pages are plain strings; binary assets (screenshots, images, fonts) are base64 data: URIs, e.g. {"index.html":"<img src=shot.png>","styles.css":"…","shot.png":"data:image/png;base64,iVBORw0K…","logo.svg":"…"}. The root index.html (else the shallowest .html) becomes the entry page; pages reference assets by relative path. Served content-type comes from the file extension, so give binary entries a real extension (.png/.jpg/.svg/.woff2). A plain republish REPLACES the bundle (include every page and asset). The map travels in one call, so keep each call to a few MB; for a large or image-heavy site, publish the pages first, then add assets in batches with `merge` (below).',
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
          .describe("Omit to create a new artifact; pass it to revise one you own."),
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
        merge: z
          .boolean()
          .optional()
          .describe(
            "Add/overwrite the given `files` INTO the existing bundle instead of replacing it (default false). Build a large site across several calls without re-sending it: publish the pages first, then merge in batches of assets — each call carries only the new files. Requires `short_id` of a bundle; same-path files overwrite, the rest are kept.",
          ),
        base_version: z
          .number()
          .int()
          .optional()
          .describe(
            "The version you edited from (optimistic concurrency). On a republish, if the artifact has since advanced, your change is 3-way merged into the current version instead of overwriting it; if the edits overlap you get the conflicting regions back to reconcile and retry. Omit to overwrite (last-write-wins). Pass the version you read.",
          ),
        message: z.string().optional().describe("What changed — recorded as the version message."),
        filename: z
          .string()
          .optional()
          .describe(
            "Filename hint for the content type of a single file, e.g. index.html or notes.md.",
          ),
        for_review: z
          .boolean()
          .optional()
          .describe(
            "File this as a PROPOSAL for a human to approve instead of publishing live (single-file only). Forced on when your role can't publish directly.",
          ),
        addresses: z
          .array(z.string())
          .optional()
          .describe(
            "Thread ids (from catch_up) this revision resolves. On a live publish they resolve; on a proposal they flip to `addressed` and resolve on approval.",
          ),
      },
    },
    async ({
      content,
      files,
      title,
      short_id,
      visibility,
      spa,
      merge,
      message,
      filename,
      for_review,
      addresses,
      base_version,
    }) => {
      const existing = short_id ? await own(short_id) : null
      if (short_id && !existing) return text(`No artifact "${short_id}" in this workspace.`)
      // Exactly one of content / files. `files` (a page map) means a bundle.
      const isBundle = !!files && Object.keys(files).length > 0
      if (isBundle && content !== undefined)
        return text("Provide `content` (single file) OR `files` (a bundle), not both.")
      if (!isBundle && (content === undefined || content === ""))
        return text("Provide `content` (single file) or `files` (a multi-page bundle).")
      if (existing) {
        // Kind can't change on republish; steer to the right field instead of the 409.
        if (existing.kind === "bundle" && !isBundle)
          return text(
            `"${short_id}" is a multi-page bundle — pass \`files\` (every page) to republish it.`,
          )
        if (existing.kind === "file" && isBundle)
          return text(`"${short_id}" is a single-file artifact — pass \`content\`, not \`files\`.`)
      }

      // Direct publish is gated on the agent's role (Creator/Admin). A commenter-level
      // grant — or anyone asking for_review — is routed to a human-reviewed proposal,
      // so a low-privilege agent still can't push live content.
      const review = for_review === true || !roleAllows(agent.role, "publish")
      if (review) {
        if (!roleAllows(agent.role, "propose"))
          return text(
            "Your grant is read-only (dock:read). Re-authorize with dock:propose (or a publish scope) to suggest changes.",
          )
        if (isBundle)
          return text(
            "Multi-page bundles can't be proposed for review yet — only published directly. Ask an editor to publish, or submit a single-file `content` revision.",
          )
        if (!existing)
          return text(
            "A proposal revises an EXISTING artifact — pass its `short_id`. Creating a new artifact needs publish rights (a Creator/Admin grant).",
          )
        try {
          const { proposal } = await proposeChange(ctx.meta, ctx.blobs, short_id as string, {
            bytes: new TextEncoder().encode(content as string),
            filename: filename ?? "index.html",
            isBundle: false,
            message: message ?? "Proposed revision",
            author: agent.name,
            author_id: agent.id,
          })
          const addressed = addresses?.length
            ? await markAddressed(ctx.meta, existing.id, proposal.id, addresses)
            : []
          for (const threadId of addressed)
            ctx.bus.publish(existing.id, {
              type: "comment.addressed",
              thread_id: threadId,
              state: "addressed",
            })
          return json({
            published: false,
            proposed: true,
            proposal_id: proposal.id,
            base_version: proposal.base_version,
            addressed,
            note: "Submitted for review — a human approves it or requests changes. It is NOT live yet.",
          })
        } catch (e) {
          return text(
            `Couldn't store the proposal: ${e instanceof PublishError ? e.message : "unknown error"}.`,
          )
        }
      }

      // Live publish path.
      if (merge) {
        if (!isBundle) return text("`merge` adds files to a bundle — pass `files`, not `content`.")
        if (!existing) return text("`merge` needs the `short_id` of an existing bundle to add to.")
        if (existing.kind !== "bundle")
          return text(
            `"${short_id}" is a single-file artifact — \`merge\` only applies to bundles.`,
          )
      }
      if (!existing && !title?.trim()) return text("Creating a new artifact needs a `title`.")
      try {
        let bytes: Uint8Array
        // A merge keeps the bundle's existing SPA routing (the caller isn't redeclaring it).
        let bundleSpa = isBundle ? !!spa : undefined
        if (!isBundle) {
          bytes = new TextEncoder().encode(content as string)
        } else if (merge && existing) {
          const v = await ctx.meta.getVersion(existing.id, existing.current_version)
          const manifest = v && (await manifestOf(ctx, v))
          if (!manifest)
            return text(`Couldn't read the current bundle for "${short_id}" to merge into.`)
          bytes = await mergeBundleZip(ctx.blobs, manifest, files as Record<string, string>)
          bundleSpa = manifest.spa
        } else {
          bytes = zipBundleFiles(files as Record<string, string>)
        }
        const { artifact, version } = await publishVersion(
          ctx.meta,
          ctx.blobs,
          {
            bytes,
            filename: isBundle ? `${title?.trim() || "bundle"}.zip` : (filename ?? "index.html"),
            isBundle,
            spa: bundleSpa,
            title: title?.trim(),
            message,
            author: agent.name,
            // New artifacts land in the granting user's workspace, private to the
            // team by default (never link-public unless they ask).
            orgId: agent.org_id,
            visibility: visibility === "link" ? "link" : visibility === "public" ? "public" : "org",
            baseVersion: base_version,
          },
          short_id,
        )
        // A live publish that fixes feedback resolves those threads directly (no
        // approval step to wait on, unlike a proposal's `addressed`).
        const resolved: string[] = []
        for (const threadId of addresses ?? []) {
          await ctx.meta.setThreadState(artifact.id, threadId, "resolved")
          ctx.bus.publish(artifact.id, {
            type: "comment.resolved",
            thread_id: threadId,
            state: "resolved",
          })
          resolved.push(threadId)
        }
        return json({
          published: true,
          short_id: artifact.short_id,
          kind: artifact.kind,
          version: version.n,
          url: artifactUrl(ctx.deps.baseUrl, artifact),
          title: artifact.title,
          visibility: artifact.visibility,
          ...(resolved.length ? { resolved } : {}),
          note: merge
            ? `Live now — merged ${Object.keys(files as Record<string, string>).length} file(s) into the bundle (new current version).`
            : short_id
              ? "Live now — published a new current version."
              : "Live now — created a new artifact in your workspace.",
        })
      } catch (e) {
        // The doc advanced past base_version and the edits overlap: hand the agent
        // the conflicting regions to reconcile rather than clobbering or 500ing.
        if (e instanceof MergeConflictError)
          return json({
            published: false,
            conflict: true,
            base_version: e.baseVersion,
            current_version: e.currentVersion,
            conflicts: e.hunks,
            note: `Couldn't auto-merge: "${short_id}" advanced to v${e.currentVersion} since v${e.baseVersion} and your change overlaps. Re-read the current version, reconcile the conflicting regions, then publish again with base_version ${e.currentVersion}.`,
          })
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
