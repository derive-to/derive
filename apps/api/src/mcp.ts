// Remote MCP endpoint — Derive as a Model Context Protocol server an AI client
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
  brandprintInstructions,
  capRole,
  diffLines,
  EditError,
  elideDataUris,
  formatDiff,
  isHtmlLike,
  looksLikeHtmlDocument,
  newId,
  type OutlineSection,
  outlineOf,
  PublishError,
  pageText,
  parseBrandprint,
  profileState,
  propose as proposeChange,
  publish as publishVersion,
  type Role,
  resolveBrandprint,
  roleAllows,
  sectionOf,
  toMarkdown,
  type VersionRecord,
} from "@derive/core"
import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import { z } from "zod"
import { BRANDPRINT_REFERENCE, BRANDPRINT_TEMPLATE } from "./brandprint-reference"
import type { AppContext } from "./context"
import { markAddressed } from "./lib/addressed"
import { afterPublish } from "./lib/after-publish"
import {
  cleanPath,
  mergeBundleZip,
  manifestOf as sharedManifestOf,
  zipBundleFiles,
} from "./lib/bundle"
import { parseMeta, quoteOf, REACTIONS } from "./lib/comments"
import { type MaterializedEdits, materializeEdits, preservingFilename } from "./lib/edits"
import { buildReviewEmail } from "./lib/email"
import { MAX_UPLOAD_BYTES } from "./lib/http"
import { notifyCommentBells } from "./lib/notify-comment"
import { enqueueSlackReviewRequestedDm } from "./lib/slack-dm"
import { enqueueChannelDelivery } from "./webhooks"

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })
// Bound a best-effort promise (the tab-delivery receipt) so it can never stall a
// publish: past `ms`, resolve with the fallback and move on.
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
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
    ? `${s.slice(0, MAX_CHARS)}\n\n…[truncated ${s.length - MAX_CHARS} chars — narrow the range]`
    : s

// Above this, a section-less read of a sectionable doc returns its OUTLINE instead of
// a blind dump: ~9k tokens leaves room to read on, small enough that most docs still
// arrive whole. Measured on the formatted body, not the raw source.
const FULL_DOC_MAX = 30_000

// clip(), but the truncation steer names sections that actually resolve.
const clipDoc = (s: string, sections: OutlineSection[]) => {
  if (s.length <= MAX_CHARS) return s
  const steer = sections.length
    ? `read a section instead: ${sections
        .slice(0, 12)
        .map((x) => x.slug)
        .join(", ")}${sections.length > 12 ? ", …" : ""}`
    : "no headings to section by — read a past `version`, or ask for the raw file"
  return `${s.slice(0, MAX_CHARS)}\n\n…[truncated ${s.length - MAX_CHARS} of ${s.length} chars — ${steer}]`
}

// A content-bearing response: a frontmatter-style header, a blank line, then the RAW
// body — one text block, real newlines, never JSON-escaped. When a client spills it
// to a file, that file is line-oriented and greppable (the old JSON envelope turned a
// 68k-char document into one escaped line). Receipts and outlines stay `json()`.
const doc = (meta: Record<string, string | number | null | undefined>, body: string) => {
  const head = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  return text(`---\n${head}\n---\n\n${body}`)
}

// The reading form for stored source at a given format. `markdown` converts HTML;
// `text` is the flat visible text (exactly what comment quotes anchor against);
// `html` is the exact source. Markdown/plain sources ARE their own visible text.
type ReadFormat = "markdown" | "html" | "text"
const baseType = (t: string) => t.split(";")[0]?.trim() ?? t
const isTextType = (t: string) => baseType(t) === "text/html" || baseType(t) === "text/markdown"
// Only the `markdown` format elides data: URIs (never `html`, which `edits` matches
// byte-for-byte against, or `text`, the comment-anchor source) — see elideDataUris.
const present = (source: string, contentType: string, format: ReadFormat): string => {
  if (format === "html") return source
  if (format === "text") return isHtmlLike(contentType) ? pageText(source) : source
  return elideDataUris(toMarkdown(source, contentType))
}
const formatLabel = (contentType: string, format: ReadFormat): string => {
  if (format === "markdown")
    return isHtmlLike(contentType)
      ? `markdown (converted from ${baseType(contentType)})`
      : "markdown (source)"
  return format === "html" ? "html (source)" : "text (visible text)"
}

// Images a read can inline as a real MCP image block (vision models see the mockup
// screenshot instead of PNG bytes decoded as garbage text). Larger ones return
// metadata + the served URL — open it in a browser instead.
const IMAGE_INLINE_MAX = 1_000_000
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
// Dependency-free base64 (no Buffer — this file runs on the Workers tier).
const toBase64 = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? "=" : B64[c & 63]
  }
  return out
}

const summarizeArtifact = (a: ArtifactRecord) => ({
  short_id: a.short_id,
  title: a.title,
  kind: a.kind,
  version: a.current_version,
  workspace_access: a.workspace_access,
  link_role: a.link_role,
  listed: a.listed,
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
async function buildServer(
  ctx: AppContext,
  agent: AgentRecord,
  actingFor: { id: string; name: string | null } | null,
  // The granting user (OAuth grantor, or a dk_agt_ token's creator) whose
  // memberships bound which workspaces this connection can roam — null for a
  // legacy token with no known owner, which stays pinned to its one workspace.
  ownerId: string | null,
  // The grant's UNCAPPED scope role (OAuth) or the agent's runtime role (dk_agt_),
  // re-capped against each roamed workspace's membership — exactly like the
  // X-Derive-Workspace header re-home in agentFor.
  scopeForCap: Role,
  // The workspaces this grant is scoped to (the consent multi-select). EMPTY =
  // "all workspaces" — every workspace the owner belongs to. A non-empty set
  // clamps list_workspaces + the `workspace` arg + cross-workspace read to
  // exactly those: workspaces outside the grant are invisible and unreachable.
  boundWorkspaces: string[],
): Promise<McpServer> {
  // Steer the write guidance by what this grant can actually do: a publish-capable
  // grant gets the direct-publish path; a lower grant is told its writes go to review.
  const writeGuidance = roleAllows(agent.role, "publish")
    ? `Use publish to create a new artifact (omit short_id) or push a new version of one (pass short_id) — ` +
      `it goes live immediately. Pass for_review:true to file it as a proposal a human approves instead. `
    : `Use publish to submit a revision — at your role it is filed as a proposal a human approves before it ` +
      `goes live; you cannot publish directly. `

  // Resolve the Brandprint for this actor: the workspace's conventions merged with the
  // owner's personal ones (profile wins). Each convention doc becomes a readable resource;
  // a one-line pointer goes in the instructions (bodies load lazily on read).
  const wsBrandprint = (await ctx.meta.getOrgSettings(agent.org_id)).brandprint
  const profileBrandprint = parseBrandprint(
    ownerId ? await ctx.meta.getUserBrandprint(ownerId) : null,
  )
  const resolved = resolveBrandprint(wsBrandprint, profileBrandprint)
  const conventionDocs: ArtifactRecord[] = []
  const seenBp = new Set<string>()
  for (const collectionId of resolved.collectionIds) {
    const ids = await ctx.meta.collectionArtifactIds(collectionId)
    for (const a of ids.length ? await ctx.meta.listArtifacts({ ids }) : []) {
      if (!seenBp.has(a.short_id)) {
        seenBp.add(a.short_id)
        conventionDocs.push(a)
      }
    }
  }
  // The brand profile. The placeholder is published into the Brandprint collection,
  // so its record normally arrived with the loop above; the getByShortId fallback
  // covers a pointer set outside the collection. Tenancy is enforced on write, but
  // re-check the org so a stale pointer can never serve another workspace's artifact.
  const profileArt = resolved.profileId
    ? (conventionDocs.find((d) => d.short_id === resolved.profileId) ??
      (await ctx.meta.getByShortId(resolved.profileId)))
    : null
  const bpProfile =
    profileArt && profileArt.org_id === agent.org_id && resolved.profileId
      ? ({ state: profileState(profileArt.current_version), shortId: resolved.profileId } as const)
      : undefined
  // The profile artifact rides in the Brandprint collection but is not a source doc:
  // pending it's an empty stub, live it's served as derive://brandprint/profile below.
  const bpSources = conventionDocs.filter((d) => d.short_id !== resolved.profileId)

  const server = new McpServer(
    { name: "derive", version: "1.0.0" },
    {
      instructions:
        `You are connected to Derive as "${agent.name}"${
          actingFor ? ` on behalf of ${actingFor.name ?? "your user"}` : ""
        }, acting in workspace ${agent.org_id} ` +
        `with ${agent.role} permissions. Derive hosts living documents and plans with versioned ` +
        `history, text-anchored review comments, and a publish → review → revise loop. ` +
        `Start a session with catch_up to re-sync on what changed and what feedback is open; use ` +
        `read to view content — it returns Markdown by default (HTML is converted) and an outline ` +
        `first for large documents or bundles, so pull sections by heading slug or page path once ` +
        `you know what you want; pass format:'html' for the exact source. Use comment to leave or ` +
        `resolve feedback. ${writeGuidance}To change PART of an artifact, prefer publish's edits ` +
        `(exact-match search/replace against the stored source) over resending everything. When a ` +
        `revision fixes specific feedback, pass those thread ids as publish's "addresses" so the ` +
        `threads resolve (or show pending on a proposal). ` +
        `This one login reaches the workspaces in your grant — call list_workspaces to see them, ` +
        `then pass a workspace id or name as the "workspace" argument to act in another one (read, ` +
        `catch_up, comment, publish, list_artifacts). read/catch_up/comment also find a short_id in ` +
        `any of them automatically, so you never need to switch just to open a doc.` +
        brandprintInstructions(bpSources.length, bpProfile),
    },
  )

  // Brandprint conventions as resources: derive://brandprint/<short_id>, bodies fetched
  // lazily (the current version's text). audience:["assistant"], context for the agent.
  for (const doc of bpSources) {
    server.registerResource(
      `brandprint:${doc.short_id}`,
      `derive://brandprint/${doc.short_id}`,
      {
        title: doc.title ?? doc.short_id,
        description: "A Brandprint convention: how this workspace likes its stuff built.",
        mimeType: "text/markdown",
        annotations: { audience: ["assistant"], priority: 0.9 },
      },
      async (uri) => {
        const art = await ctx.meta.getByShortId(doc.short_id)
        const v = art ? await ctx.meta.getVersion(art.id, art.current_version) : null
        const body = v ? await ctx.sourceText(v) : null
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: body ?? "" }] }
      },
    )
  }
  // The generation reference: the build guide + the neutral benchmark page, served
  // whenever a Brandprint exists. Derive runs no inference, so these two static files
  // are its entire side of profile generation; the user's agent does the assembling.
  if (resolved.collectionIds.length > 0) {
    server.registerResource(
      "brandprint:reference",
      "derive://brandprint/reference",
      {
        title: "How to build this workspace's brand profile",
        description: "The build guide: required sections, extraction rules, output contract.",
        mimeType: "text/markdown",
        annotations: { audience: ["assistant"], priority: 0.8 },
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: BRANDPRINT_REFERENCE }],
      }),
    )
    server.registerResource(
      "brandprint:template",
      "derive://brandprint/template",
      {
        title: "Brand profile template (neutral benchmark)",
        description:
          "A complete brand-neutral profile page — the structural and quality benchmark; restyle everything.",
        mimeType: "text/html",
        annotations: { audience: ["assistant"], priority: 0.8 },
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/html", text: BRANDPRINT_TEMPLATE }],
      }),
    )
  }
  // The live brand profile is the headline read — one page that carries the whole
  // brand, humans and machines alike (tokens ride in it as CSS variables + JSON island).
  // The server is per-request, so the record fetched above is fresh enough to reuse.
  if (bpProfile?.state === "live" && profileArt) {
    server.registerResource(
      "brandprint:profile",
      "derive://brandprint/profile",
      {
        title: "Brand profile",
        description: "This workspace's brand profile — read before authoring.",
        mimeType: "text/html",
        annotations: { audience: ["assistant"], priority: 1 },
      },
      async (uri) => {
        const v = await ctx.meta.getVersion(profileArt.id, profileArt.current_version)
        const body = v ? await ctx.sourceText(v) : null
        return { contents: [{ uri: uri.href, mimeType: "text/html", text: body ?? "" }] }
      },
    )
  }

  const defaultOrg = agent.org_id
  const defaultRole = agent.role

  // The owner's workspaces this grant can actually reach: all of them when the
  // grant is unscoped (empty set), else only the ticked subset. The single source
  // of truth for what list_workspaces shows and what the `workspace` arg accepts.
  const grantedWorkspaces = async (): Promise<{ id: string; name: string; role: Role }[]> => {
    if (!ownerId) return []
    const all = await ctx.meta.listWorkspaces(ownerId)
    return boundWorkspaces.length ? all.filter((w) => boundWorkspaces.includes(w.id)) : all
  }
  // Is an org within this grant's scope? (An unscoped grant reaches all.)
  const inGrant = (org: string) => boundWorkspaces.length === 0 || boundWorkspaces.includes(org)

  // Resolve a workspace REFERENCE (id or name) to an org + the role the grant
  // holds there. No ref → the connection's default workspace. Roaming needs a
  // known granting user (ownerId); the role is re-capped from the grant's scope
  // against that workspace's membership — the same rule as agentFor's
  // X-Derive-Workspace re-home. Returns an actionable error the model recovers from.
  const resolveWs = async (
    ref?: string,
  ): Promise<{ org: string; role: Role } | { error: string }> => {
    if (!ref) return { org: defaultOrg, role: defaultRole }
    if (!ownerId)
      return {
        error:
          "This connection is pinned to a single workspace and can't switch. Reconnect it with an OAuth login to reach your other workspaces.",
      }
    // Only workspaces WITHIN THE GRANT are resolvable — one outside the ticked set
    // is as good as non-existent to this connection, even if the owner belongs to it.
    const mine = await grantedWorkspaces()
    const w =
      mine.find((x) => x.id === ref) ??
      mine.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase())
    if (!w)
      return {
        error: `No workspace "${ref}" in this grant. Call list_workspaces to see the workspaces this connection can act in (match by id or name).`,
      }
    return { org: w.id, role: capRole(scopeForCap, w.role) }
  }

  // Reach an artifact this connection can act on, resolving WHERE it lives.
  // With `wsRef`: only that workspace. Without: the default workspace, then —
  // for a bare short_id — ANY workspace the granting user belongs to, so a doc
  // is found wherever it lives without the model naming the workspace.
  // `workspace_access = none` narrows further: touchable only through the
  // agent's human (or a legacy row of the agent's own) — a teammate's
  // invite-only draft stays invisible over MCP.
  // Returns the artifact plus the org + re-capped role to act with there.
  const reach = async (
    shortId: string,
    wsRef?: string,
  ): Promise<{ a: ArtifactRecord; org: string; role: Role } | { error: string } | null> => {
    const a = await ctx.meta.getByShortId(shortId)
    if (!a) return null
    let org = defaultOrg
    let role = defaultRole
    if (wsRef) {
      const t = await resolveWs(wsRef)
      if ("error" in t) return t
      if (a.org_id !== t.org) return null // named a workspace this artifact isn't in
      org = t.org
      role = t.role
    } else if (a.org_id !== defaultOrg) {
      // Auto-roam to the doc's workspace only if it's within this grant and the
      // owner is a member. A doc in a workspace outside the grant reads as not found.
      if (!ownerId || !inGrant(a.org_id)) return null
      const m = await ctx.meta.getMembership(a.org_id, ownerId)
      if (!m) return null
      org = a.org_id
      role = capRole(scopeForCap, m.role)
    }
    if (a.workspace_access !== "member") {
      const ok =
        (actingFor && (await ctx.meta.getArtifactMember(a.id, actingFor.id))) ||
        (await ctx.meta.getArtifactMember(a.id, agent.id))
      if (!ok) return null
    }
    return { a, org, role }
  }
  const notFound = (shortId: string) =>
    err(
      `No artifact "${shortId}" you can reach in any of your workspaces. Call list_artifacts (optionally with a workspace) to see what's there.`,
    )

  // The `workspace` argument shared by every workspace-scoped tool.
  const wsArg = z
    .string()
    .optional()
    .describe(
      "Workspace to act in — its id or name from list_workspaces. Omit for your default workspace; read/catch_up/comment also find a short_id in ANY of your workspaces automatically.",
    )

  // WORKSPACES — the switcher: every workspace this one login can reach --------
  server.registerTool(
    "list_workspaces",
    {
      description:
        "List every workspace THIS grant can act in — id, name, your role there, and which is your default. This is the set you chose when you connected (all your workspaces, or a subset). Pass a workspace's id or name as the `workspace` argument to list_artifacts / read / catch_up / comment / publish to act there. No reconnect — read/catch_up/comment even find a short_id across these workspaces automatically.",
      inputSchema: {},
    },
    async () => {
      const mine = await grantedWorkspaces()
      const rows = mine.length
        ? mine.map((w) => ({ id: w.id, name: w.name, role: w.role, default: w.id === defaultOrg }))
        : [{ id: defaultOrg, name: null as string | null, role: agent.role, default: true }]
      return json({ count: rows.length, workspaces: rows })
    },
  )

  // FIND ----------------------------------------------------------------------
  server.registerTool(
    "list_artifacts",
    {
      description:
        "List the artifacts (docs, plans, sites) in a workspace — short id, title, kind, current version, access (workspace_access/link_role/listed). Defaults to your current workspace; pass `workspace` (id or name from list_workspaces) to list another one. Includes your own unlisted publishes — out of the shared library, but you always find your work. Start here to find what to work on, then catch_up or read it.",
      inputSchema: {
        query: z.string().optional().describe("Optional title search filter."),
        workspace: wsArg,
      },
    },
    async ({ query, workspace }) => {
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      // viewerId keeps private rows scoped to the agent's human (mirrors `reach`) —
      // the owner row written at publish is what lets the agent always find its
      // own drafts while a teammate's private work stays invisible.
      const arts = await ctx.meta.listArtifacts({
        orgId: t.org,
        q: query,
        viewerId: actingFor?.id ?? agent.id,
      })
      return json({ workspace: t.org, count: arts.length, artifacts: arts.map(summarizeArtifact) })
    },
  )

  // READ CONTENT --------------------------------------------------------------
  server.registerTool(
    "read",
    {
      description:
        "Read an artifact's CONTENT by short id, as Markdown by default (HTML is converted; the styling noise is dropped). Small docs return whole; a LARGE doc returns its heading OUTLINE first — call again with a `section` slug for just that part. Multi-page bundle: omit `section` for the page outline, then pass a page path (optionally `page.html#slug`). Pass format:'html' for the exact source (required before publish `edits`), or a past `version` for history. (For what CHANGED, or the comment threads, use catch_up.)",
      inputSchema: {
        short_id: z.string().describe("The artifact's short id, e.g. nk0dsral."),
        section: z
          .string()
          .optional()
          .describe(
            'What to read. Single-file doc: a heading slug from the outline (e.g. rollout-plan). Bundle: a page path (agentic-loop.html), optionally with a slug (agentic-loop.html#risks). Pass "*" (or "page.html#*" for a bundle page) to force the full (clipped) document/page. Omit it: small docs/pages return whole, large ones return their outline.',
          ),
        format: z
          .enum(["markdown", "html", "text"])
          .optional()
          .describe(
            "markdown (default): HTML converted to structured Markdown — headings, lists, tables, code fences; Markdown sources return as-is. html: the exact stored source — read this BEFORE publish `edits` on an HTML artifact (edits match raw source). text: flat visible text, exactly what comment `quote`s anchor against.",
          ),
        version: z.number().optional().describe("Defaults to the current version."),
        workspace: wsArg,
      },
    },
    async ({ short_id, section, format, version, workspace }) => {
      const fmt: ReadFormat = format ?? "markdown"
      const r = await reach(short_id, workspace)
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(short_id)
      const a = r.a
      const n = version ?? a.current_version
      if (n < 1 || n > a.current_version)
        return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
      const v = await ctx.meta.getVersion(a.id, n)
      if (!v) return err(`Version ${n} of "${short_id}" is unavailable.`)
      const url = artifactUrl(ctx.deps.baseUrl, a)
      const manifest = await manifestOf(ctx, v)

      if (!manifest) {
        // Single-file artifact.
        const src = (await ctx.sourceText(v)) ?? ""
        const ct = v.content_type
        const meta = {
          short_id,
          title: a.title,
          version: `${n}${n === a.current_version ? " (current)" : ""}`,
          kind: a.kind,
          format: formatLabel(ct, fmt),
          url,
        }
        if (section && section !== "*") {
          const slice = sectionOf(src, ct, section)
          if (slice === null) {
            const slugs = outlineOf(src, ct).map((s) => s.slug)
            return err(
              slugs.length
                ? `No section "${section}" in "${short_id}" v${n} — sections: ${slugs.join(", ")}.`
                : `"${short_id}" has no headings to section by — read it whole (omit \`section\`).`,
            )
          }
          // Also feeds clipDoc's steer below — a single section can itself be huge
          // (e.g. the last one, which runs to </body>), so it needs the same
          // MAX_CHARS ceiling the whole-doc path gets, not an unbounded return.
          const outline = outlineOf(src, ct)
          const i = outline.findIndex((s) => s.slug === section)
          const body = present(slice, ct, fmt)
          return doc(
            {
              ...meta,
              section: `${section} (${i + 1} of ${outline.length})`,
              chars: body.length,
            },
            clipDoc(body, outline),
          )
        }
        const body = present(src, ct, fmt)
        if (!section && body.length > FULL_DOC_MAX) {
          const outline = outlineOf(src, ct)
          if (outline.length)
            return json({
              short_id,
              title: a.title,
              kind: a.kind,
              version: n,
              source: ct,
              format: fmt,
              doc_chars: body.length,
              url,
              sections: outline,
              next: 'Large document — call read again with a `section` slug for just that part, or section:"*" for the full clipped text. To revise it, publish with `edits` instead of resending content.',
            })
          // No headings to summarize by — fall through to a plain (clipped) return,
          // reusing the already-computed (empty) outline instead of asking again.
          return doc({ ...meta, chars: body.length }, clipDoc(body, outline))
        }
        // Under FULL_DOC_MAX: clipDoc's MAX_CHARS ceiling is far above this body's
        // size, so it can never truncate — skip computing an outline it won't use.
        const outline = body.length > MAX_CHARS ? outlineOf(src, ct) : []
        return doc({ ...meta, chars: body.length }, clipDoc(body, outline))
      }

      // Bundle.
      const pages = Object.keys(manifest.files).map(cleanPath)
      if (!section) {
        // Outline: every page, plus sizes + headings for the shallowest text pages
        // (each costs a blob read — the manifest has no sizes — so cap the sweep).
        const textPages = pages
          .filter((p) => isTextType(manifest.files[p]?.type ?? manifest.files[`/${p}`]?.type ?? ""))
          .sort((x, y) => x.split("/").length - y.split("/").length || x.localeCompare(y))
        const entry = cleanPath(manifest.entry)
        const inspect = [entry, ...textPages.filter((p) => p !== entry)].slice(0, 25)
        // The blob reads are independent — fetch them all at once instead of one
        // round trip at a time (up to 25 pages, otherwise serialized latency).
        const detailEntries = await Promise.all(
          inspect.map(
            async (p): Promise<[string, { chars: number; headings: OutlineSection[] }] | null> => {
              const file = manifest.files[p] ?? manifest.files[`/${p}`]
              if (!file) return null
              const bytes = await ctx.blobs.get(file.key)
              if (!bytes) return null
              const text_ = new TextDecoder().decode(bytes)
              return [
                p,
                {
                  chars: toMarkdown(text_, file.type).length,
                  headings: outlineOf(text_, file.type),
                },
              ]
            },
          ),
        )
        const detail = new Map(detailEntries.filter((e) => e !== null))
        return json({
          short_id,
          title: a.title,
          kind: "bundle",
          version: n,
          entry,
          url,
          pages: pages.map((p) => {
            const type = manifest.files[p]?.type ?? manifest.files[`/${p}`]?.type
            const d = detail.get(p)
            return {
              path: p,
              type,
              ...(d
                ? {
                    chars: d.chars,
                    headings: d.headings.map((h) => ({
                      slug: h.slug,
                      level: h.level,
                      text: h.text,
                    })),
                  }
                : {}),
            }
          }),
          next: "Call read again with a `section` (a page path above, optionally page.html#slug for one heading's part) for content.",
        })
      }

      // A page (optionally page#slug — split on the LAST '#'). "#*" forces the
      // page's full (clipped) content, the same bypass single-file section:"*" is.
      const hash = section.lastIndexOf("#")
      const pagePath = hash > 0 ? section.slice(0, hash) : section
      const rawSlug = hash > 0 ? section.slice(hash + 1) : null
      const slug = rawSlug === "*" ? null : rawSlug
      const forceFull = rawSlug === "*"
      const file = manifest.files[pagePath] ?? manifest.files[`/${cleanPath(pagePath)}`]
      if (!file) return err(`No page "${pagePath}" in "${short_id}". Pages: ${pages.join(", ")}.`)
      const bytes = await ctx.blobs.get(file.key)

      // An image page is an IMAGE, not text: inline it as a real image block (small
      // ones), or point at the served URL. Never decode PNG bytes as a string.
      if (baseType(file.type).startsWith("image/")) {
        const pageUrl = `${ctx.deps.baseUrl}/raw/${short_id}/v/${n}/${cleanPath(pagePath)}`
        const size = bytes?.length ?? 0
        if (!bytes || size > IMAGE_INLINE_MAX)
          return json({
            short_id,
            section: cleanPath(pagePath),
            type: file.type,
            bytes: size,
            url: pageUrl,
            note: "Too large to inline over MCP — open the url to view it.",
          })
        return {
          content: [
            {
              type: "text" as const,
              text: `${cleanPath(pagePath)} (${file.type}, ${size} bytes) — served at ${pageUrl}`,
            },
            { type: "image" as const, data: toBase64(bytes), mimeType: baseType(file.type) },
          ],
        }
      }

      const raw = bytes ? new TextDecoder().decode(bytes) : ""
      const isText = isTextType(file.type)
      const meta = {
        short_id,
        title: a.title,
        version: `${n}${n === a.current_version ? " (current)" : ""}`,
        kind: "bundle",
        url,
        type: file.type,
      }
      if (slug) {
        if (!isText)
          return err(`"${pagePath}" is ${file.type} — heading sections only apply to text pages.`)
        const slice = sectionOf(raw, file.type, slug)
        if (slice === null) {
          const slugs = outlineOf(raw, file.type).map((s) => s.slug)
          return err(
            slugs.length
              ? `No section "${slug}" in "${pagePath}" — sections: ${slugs.join(", ")}.`
              : `"${pagePath}" has no headings to section by — read the whole page.`,
          )
        }
        const outline = outlineOf(raw, file.type)
        const body = present(slice, file.type, fmt)
        return doc(
          {
            ...meta,
            section: `${cleanPath(pagePath)}#${slug}`,
            format: formatLabel(file.type, fmt),
            chars: body.length,
          },
          clipDoc(body, outline),
        )
      }
      // css/js/json/etc always return source — conversion only applies to text pages.
      const body = isText ? present(raw, file.type, fmt) : raw
      // Same outline-first threshold the single-file path applies: a bundle page can
      // be just as large as a standalone doc, so it gets the same treatment instead
      // of only ever cutting at the much higher MAX_CHARS ceiling below.
      if (isText && !slug && !forceFull && body.length > FULL_DOC_MAX) {
        const outline = outlineOf(raw, file.type)
        if (outline.length)
          return json({
            short_id,
            title: a.title,
            kind: "bundle",
            version: n,
            section: cleanPath(pagePath),
            source: file.type,
            format: fmt,
            doc_chars: body.length,
            url,
            sections: outline,
            next: `Large page — call read again with \`section\` set to "${cleanPath(pagePath)}#slug" for just that part, or "${cleanPath(pagePath)}#*" for the full clipped text.`,
          })
        return doc(
          { ...meta, section: cleanPath(pagePath), chars: body.length },
          clipDoc(body, outline),
        )
      }
      const outline = isText && body.length > MAX_CHARS ? outlineOf(raw, file.type) : []
      return doc(
        {
          ...meta,
          section: cleanPath(pagePath),
          format: isText ? formatLabel(file.type, fmt) : file.type,
          chars: body.length,
        },
        clipDoc(body, outline),
      )
    },
  )

  // CATCH UP — state, feedback, history, and diffs all in one ------------------
  server.registerTool(
    "catch_up",
    {
      description:
        "START HERE on an artifact. The state of it in one call: a one-line summary, the versions that landed since `since_version`, which pages changed, the open (and outdated) comment threads, and the full version history. " +
        "Pass `comments` (open / addressed / resolved / outdated) to instead get that filtered thread list — your feedback to-do queue. " +
        "Pass `response_format='detailed'` (optionally with `since_version`/`to_version`) to include a line-by-line diff between two versions — of their READABLE Markdown form, not raw HTML, so it shows what changed rather than tag noise. " +
        "WAITING ON A REVIEW? Pass `wait` (seconds, max 50): the call blocks until the human sends back / approves / comments (or the time runs out), then returns the fresh state. Chain wait calls instead of sleeping between polls — feedback reaches you in seconds.",
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
        wait: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Long-poll: block up to this many seconds for the human's next action (send back, approve, or a new comment) before returning. Returns immediately when something is already actionable.",
          ),
        workspace: wsArg,
      },
    },
    async ({ short_id, since_version, to_version, comments, response_format, wait, workspace }) => {
      const r = await reach(short_id, workspace)
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(short_id)
      let a = r.a

      // Long-poll: when the agent is waiting on the human, block on the artifact
      // channel until they act, then fall through and build the response fresh
      // (composes with the `comments` filter below — wait, then the queue). The
      // event is only a wake signal — all state below is re-read from the store,
      // so a missed or raced event can never produce a wrong answer. The
      // subscription starts BEFORE the state check, so an action landing in that
      // gap wakes us instead of slipping through; when something is already
      // actionable the wait is released immediately.
      if (wait && ctx.bus.waitFor) {
        const release = new AbortController()
        const waited = ctx.bus
          .waitFor(
            a.id,
            [
              "review.sent_back",
              "review.approved",
              "comment.created",
              "comment.updated",
              "version.published",
            ],
            wait * 1000,
            release.signal,
          )
          .catch(() => null)
        const rounds = await ctx.meta.listReviewRounds(a.id)
        const round =
          rounds.find((r) => r.state === "pending") ??
          rounds.find((r) => r.requested_by === agent.id) ??
          rounds[0] ??
          null
        // Actionable = a settled decision the agent hasn't built on yet (it still
        // applies to the current head). A stale sent_back/approved from an older
        // version never disables the long-poll — the agent already consumed it.
        const actionable = round && round.state !== "pending" && round.version >= a.current_version
        if (actionable) {
          release.abort()
          await waited
        } else {
          await waited
          // Refresh: the head (or the artifact itself) may have moved while waiting.
          const rr = await reach(short_id, workspace)
          a = rr && !("error" in rr) ? rr.a : a
        }
      }

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
          if (as_ !== null && ah !== null) {
            // Diff the READABLE form, not raw source: HTML tag noise drowns a
            // real change, and minified one-line HTML produces one useless
            // del/add pair. Markdown conversion re-introduces line structure so
            // the diff answers what an agent actually asks — what changed.
            const md = diffLines(toMarkdown(as_, vs.content_type), toMarkdown(ah, vh.content_type))
            entryDiff = `diff of markdown conversion (semantic view):\n\n${clip(formatDiff(md))}`
          }
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
      // The review round this agent is waiting on (the loop's poll target): the round
      // it requested most recently. `pending` = still waiting; `sent_back` = the human
      // returned answers — read the open threads and revise; `approved` = the go-signal.
      const rounds = await ctx.meta.listReviewRounds(a.id)
      const myRound =
        rounds.find((r) => r.state === "pending") ??
        rounds.find((r) => r.requested_by === agent.id) ??
        rounds[0] ??
        null
      const review = myRound
        ? {
            state: myRound.state,
            version: myRound.version,
            requested_at: myRound.created_at,
            resolved_at: myRound.resolved_at,
            note: myRound.note,
          }
        : null
      const reviewBit = review
        ? review.state === "pending"
          ? ` Review requested on v${review.version} — waiting for the human.`
          : review.state === "sent_back"
            ? ` The human sent back their review of v${review.version} — read the open threads, revise, and re-request.`
            : ` The human approved v${review.version} — you're clear to proceed.`
        : ""
      const summary =
        since >= to
          ? `You're up to date on "${a.title}" (v${head}); ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}${reviewBit}`
          : `"${a.title}": ${newVersions.length} new version${newVersions.length === 1 ? "" : "s"} since v${since} (now v${to}).${pageBits} ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}${reviewBit}`
      return json({
        summary,
        review,
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
        "Leave feedback on an artifact, reply in a thread, react, and/or resolve or reopen a thread — all in one tool. Anchor a NEW comment to a quoted span of the rendered text with `quote`. Reply by passing the thread id as `reply_to`. Pass `react` (with `reply_to`) to acknowledge the latest human comment in a thread without the noise of a reply — the minimum ack the loop requires. Resolve or reopen by passing `set_state` along with the thread's id in `reply_to`. Thread ids come from catch_up.",
      inputSchema: {
        short_id: z.string(),
        body: z
          .string()
          .optional()
          .describe("The comment text (Markdown). Omit when just reacting or changing state."),
        reply_to: z
          .string()
          .optional()
          .describe(
            "A thread id (from catch_up): reply in that thread, and/or the thread to react / set_state on.",
          ),
        quote: z
          .string()
          .optional()
          .describe("Exact text in the rendered document to anchor a NEW comment to."),
        react: z
          .enum(REACTIONS as [string, ...string[]])
          .optional()
          .describe(
            "React to the thread's latest comment by someone else (with `reply_to`) — the lightweight ack. 👍 is the loop's default.",
          ),
        set_state: z
          .enum(["resolved", "open"])
          .optional()
          .describe("Resolve the thread, or reopen it (with `reply_to`)."),
        workspace: wsArg,
      },
    },
    async ({ short_id, body, reply_to, quote, react, set_state, workspace }) => {
      const r = await reach(short_id, workspace)
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(short_id)
      const a = r.a
      if (!roleAllows(r.role, "comment"))
        return err(
          "Your grant is read-only (derive:read). Re-authorize the connector with derive:comment to leave feedback.",
        )
      if (!body && !set_state && !react)
        return err(
          "Provide `body` (to comment), `react` (to acknowledge), or `set_state` (to resolve/reopen).",
        )
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
        // Same bell fan-out as the HTTP route: thread participants + the
        // artifact's owners hear the agent's reply even with no tab open.
        // (Previously this path belled no one.) The MCP tool has no mentions.
        const created = await ctx.meta.getComment(commentId)
        if (created)
          await notifyCommentBells({ meta: ctx.meta, bus: ctx.bus }, a, created, {
            mentionIds: new Set(),
            actorId: agent.id,
          })
      }
      // The ack: land the emoji on the thread's newest comment by someone ELSE
      // (the human being acknowledged), falling back to its newest comment.
      // Idempotent — re-acking never toggles the reaction off.
      let reactedTo: string | undefined
      if (react) {
        if (!thread) return err("`react` needs `reply_to` (the thread to acknowledge).")
        const inThread = (await ctx.meta.listComments(a.id)).filter(
          (c) => c.thread_id === thread && !parseMeta(c.meta).deleted,
        )
        if (inThread.length === 0) return err(`No thread "${thread}" on "${short_id}".`)
        const target =
          [...inThread].reverse().find((c) => c.author_id !== agent.id) ??
          inThread[inThread.length - 1]
        if (target) {
          const md = parseMeta(target.meta)
          const reactions = md.reactions ?? {}
          const arr = reactions[react] ?? []
          if (!arr.includes(agent.name)) arr.push(agent.name)
          reactions[react] = arr
          md.reactions = reactions
          await ctx.meta.updateComment(target.id, { meta: JSON.stringify(md) })
          ctx.bus.publish(a.id, { type: "comment.reacted", thread_id: thread })
          reactedTo = target.id
        }
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
        ...(reactedTo ? { reacted: react, reacted_to: reactedTo } : {}),
        ...(set_state ? { state: set_state } : {}),
        note: body
          ? reply_to
            ? "Replied in the thread."
            : "New comment thread created."
          : reactedTo
            ? `Acknowledged with ${react}.`
            : `Thread ${set_state}.`,
      })
    },
  )

  // WRITE — publish live, or file a proposal for review -----------------------
  server.registerTool(
    "publish",
    {
      description:
        "Save a revision of an artifact. It goes LIVE immediately if your role can publish (Creator/Admin); otherwise — or whenever you pass for_review:true — it is filed as a PROPOSAL a human approves before it goes live. To CHANGE PART of a single-file artifact, prefer `edits` (exact-match search/replace against the stored source — read format:'html' first) over resending everything. Otherwise provide the full `content` for a SINGLE-FILE artifact, or `files` (a map of page path → content) for a MULTI-PAGE BUNDLE (a whole site, images and any binary asset). OMIT short_id to create a NEW artifact (`title` required); PASS short_id to add a version to one you own, matching its kind. A bundle republish REPLACES the whole bundle, so include EVERY page and asset (or use `merge`). Pass `addresses` with the thread ids (from catch_up) this revision resolves. (Proposals are single-file only; bundles must be published directly.)",
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe(
            "The complete content for a SINGLE-FILE artifact (HTML or Markdown). Use this OR `files`, not both. To embed an image CHEAPLY (no base64 in this call), upload the raw bytes to POST /v1/assets first — the response's `url` is a permanent public link; paste it straight into an `<img src>` or markdown `![]()`. Never inline a base64 data: URI here — it tokenizes at roughly 1 token/char, so one modest screenshot can cost 100k+ tokens to pass through this call.",
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'A MULTI-PAGE bundle as a map of path → content — the whole site. Each value is one of: a text page (plain string); a base64 data: URI for a small inline binary ("shot.png":"data:image/png;base64,iVBORw0K…"); or — PREFERRED for real images — an "asset:<hash>" handle returned by uploading the raw bytes to POST /v1/assets first ("shot.png":"asset:9f86d0818…"). The asset handle keeps the call tiny: stream each screenshot up as raw binary (no base64 transcription), then reference the handles here. Example: {"index.html":"<img src=shot.png>","styles.css":"…","shot.png":"asset:9f86d0818…","logo.png":"data:image/png;base64,iVBORw0K…"}. The root index.html (else the shallowest .html) becomes the entry page; pages reference assets by relative path. Served content-type comes from the file extension, so give binary entries a real extension (.png/.jpg/.webp/.woff2). A plain republish REPLACES the bundle (include every page and asset). Keep each call to a few MB; for many/large images, upload them to /v1/assets and reference the handles (or publish pages first, then `merge` asset batches). Each published page is also readable directly at /raw/<short_id>/v/<n>/<path> once live.',
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
        workspace_access: z
          .enum(["none", "member"])
          .optional()
          .describe(
            "Do THIS workspace's members reach a NEW artifact (each at their seat role — admin/editor/commenter)? member (the usual default — a pasted link opens for a teammate) or none (invite-only, even for the workspace). Omit to use the workspace's default. Ignored on republish.",
          ),
        link_role: z
          .enum(["none", "viewer", "commenter", "editor"])
          .optional()
          .describe(
            "What merely holding a NEW artifact's URL confers on ANYONE (incl. people outside the workspace): none (no world link — the usual default), viewer, commenter, or editor. Anonymous holders are always clamped to viewer. Omit to use the workspace's default. Ignored on republish.",
          ),
        listed: z
          .enum(["none", "workspace", "public"])
          .optional()
          .describe(
            "Where a NEW artifact SURFACES for discovery (no access of its own): none (no feeds/libraries — the usual default; a human promotes it when ready), workspace (the team library — needs workspace_access=member), or public (the public directory — needs a link_role). Omit to use the workspace's default. Ignored on republish — the human promotes via the share dialog.",
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
        request_review: z
          .boolean()
          .optional()
          .describe(
            "After a LIVE publish, open a review round asking your human to review this version — the /derive loop. They answer inline and hit Send back (or Approve); poll catch_up's `review` for the state. No effect on a proposal (that already IS a review).",
          ),
        workspace: wsArg,
        edits: z
          .array(
            z.object({
              old_str: z
                .string()
                .describe(
                  "Exact text from the STORED SOURCE (read format:'html' first on an HTML artifact — the markdown view will not match). Must occur exactly once.",
                ),
              new_str: z.string().describe("Replacement text. Empty string deletes."),
            }),
          )
          .optional()
          .describe(
            "Surgical revision of a SINGLE-FILE artifact without resending it: exact-match search/replace against the current stored source, applied in order (each edit sees the previous one's result). Errors — applying nothing — if any old_str matches zero or multiple times; add surrounding context to disambiguate. Requires `short_id`; use INSTEAD of `content`. Composes with for_review, addresses, message, request_review.",
          ),
        base_version: z
          .number()
          .optional()
          .describe(
            "Safety check for `edits`: pass the version you read; the publish errors instead of applying when the artifact has moved past it.",
          ),
      },
    },
    async ({
      content: contentIn,
      files,
      title,
      short_id,
      workspace_access,
      link_role,
      listed,
      spa,
      merge,
      message,
      filename,
      for_review,
      addresses,
      request_review,
      workspace,
      edits,
      base_version,
    }) => {
      let content = contentIn
      // Revise an existing artifact wherever it lives (reach roams to its
      // workspace, within the grant); create a new one in the targeted (or
      // default) workspace. The acting role is re-capped to that workspace, so
      // publish/propose gating is correct there, not just in the default one.
      const reached = short_id ? await reach(short_id, workspace) : null
      if (reached && "error" in reached) return text(reached.error)
      const existing = reached && !("error" in reached) ? reached.a : null
      if (short_id && !existing) return text(`No artifact "${short_id}" you can reach.`)
      let targetOrg = defaultOrg
      let actRole = defaultRole
      if (existing && reached && !("error" in reached)) {
        targetOrg = reached.org
        actRole = reached.role
      } else if (!short_id) {
        const t = await resolveWs(workspace)
        if ("error" in t) return text(t.error)
        targetOrg = t.org
        actRole = t.role
      }

      // `edits` — materialize the full new content up front, then fall through to the
      // untouched publish/proposal pipeline (sweep, addresses, receipts all inherit).
      let editsApplied = 0
      if (edits !== undefined) {
        if (content !== undefined || files)
          return err("Provide `edits` OR `content`/`files`, not both.")
        if (!existing) return err("`edits` revises an EXISTING artifact — pass its `short_id`.")
        let materialized: MaterializedEdits
        try {
          materialized = await materializeEdits(
            { getVersion: ctx.meta.getVersion.bind(ctx.meta), sourceText: ctx.sourceText },
            existing,
            edits,
            base_version,
          )
        } catch (e) {
          if (e instanceof EditError) return err(e.message)
          throw e
        }
        // Same size/storage ceiling the REST /versions and /proposals routes apply
        // after materializing edits — without this the MCP tool could write an
        // over-quota version the HTTP surfaces would have rejected.
        const editedBytes = new TextEncoder().encode(materialized.content).length
        if (editedBytes > MAX_UPLOAD_BYTES) return err("Edited content is too large.")
        if (await ctx.overStorage(targetOrg, editedBytes))
          return err(`"${short_id}"'s workspace storage quota is exceeded.`)
        content = materialized.content
        editsApplied = edits.length
        if (!filename) filename = materialized.filename
      }

      // Exactly one of content / files. `files` (a page map) means a bundle.
      const isBundle = !!files && Object.keys(files).length > 0
      if (isBundle && content !== undefined)
        return text("Provide `content` (single file) OR `files` (a bundle), not both.")
      if (!isBundle && (content === undefined || content === ""))
        return text("Provide `content` (single file), `files` (a multi-page bundle), or `edits`.")
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
      const review = for_review === true || !roleAllows(actRole, "publish")
      if (review) {
        if (!roleAllows(actRole, "propose"))
          return text(
            "Your grant is read-only (derive:read). Re-authorize with derive:propose (or a publish scope) to suggest changes.",
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
            // The sniffer types by filename first: a bare index.html default would
            // re-type a markdown artifact as HTML when the proposal is approved.
            filename: filename ?? preservingFilename(existing.current_content_type),
            isBundle: false,
            message: message ?? "Proposed revision",
            author: agent.name,
            author_id: agent.id,
            // Delegation provenance: the agent proposes on behalf of the human that
            // authorized it, so reviewers see "Agent X on behalf of Alice."
            on_behalf_of: actingFor?.id ?? null,
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
            ...(editsApplied ? { edits_applied: editsApplied } : {}),
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
          bytes = await zipBundleFiles(files as Record<string, string>, ctx.blobs)
        }
        // Access is set-on-create (a republish never re-stamps): each field resolves
        // explicit arg > the TARGETED workspace's default (the default workspace
        // unless a `workspace` was named). The factory default is the "team
        // draft" — workspace_access=member, link_role=none, listed=none: a teammate
        // can open the link, the world can't, and it stays out of feeds until a human
        // promotes it. Sharing wider stays a deliberate act.
        const settings = short_id ? null : await ctx.meta.getOrgSettings(targetOrg)
        const resolvedWorkspaceAccess = short_id
          ? undefined
          : (workspace_access ?? settings?.defaultWorkspaceAccess)
        const resolvedLinkRole = short_id ? undefined : (link_role ?? settings?.defaultLinkRole)
        const resolvedListed = short_id ? undefined : (listed ?? settings?.defaultListed)
        // The only cross-field invariants: a doc can't be listed where it grants no access.
        if (!short_id && resolvedListed === "workspace" && resolvedWorkspaceAccess !== "member")
          return text("A workspace-listed artifact must grant workspace access.")
        if (!short_id && resolvedListed === "public" && resolvedLinkRole === "none")
          return text("A publicly-listed artifact must grant at least a viewer link.")
        // No filename on a single-file publish must never blindly default to
        // index.html: the sniffer types by filename first, so that default silently
        // re-types an existing markdown doc as HTML — the browser then parses the
        // raw markdown as markup and swallows tag-like text. A republish preserves
        // the artifact's current type; a new artifact is sniffed, so markdown
        // content without a filename hint lands as markdown.
        const singleFileFallback = existing
          ? preservingFilename(existing.current_content_type)
          : looksLikeHtmlDocument((content as string | undefined) ?? "")
            ? "index.html"
            : "index.md"
        const { artifact, version } = await publishVersion(
          ctx.meta,
          ctx.blobs,
          {
            bytes,
            filename: isBundle
              ? `${title?.trim() || "bundle"}.zip`
              : (filename ?? singleFileFallback),
            isBundle,
            spa: bundleSpa,
            title: title?.trim(),
            message,
            author: agent.name,
            // Attributed to the human the agent acts for — their profile, their
            // followers' feed (same as the HTTP publish route).
            authorId: actingFor?.id ?? null,
            // New artifacts land in the TARGETED workspace (the default unless a
            // `workspace` was named), never wider than asked (the workspace's
            // default access when unspecified).
            orgId: targetOrg,
            workspaceAccess: resolvedWorkspaceAccess,
            linkRole: resolvedLinkRole,
            listed: resolvedListed,
          },
          short_id,
        )
        // Ownership, same as the HTTP route: one row, the human the agent acts
        // for (the agent borrows that standing — no agent rows in the roster).
        if (!short_id)
          await ctx.meta.setArtifactMember({
            id: newId("am"),
            artifact_id: artifact.id,
            user_id: actingFor?.id ?? agent.id,
            role: "owner",
          })
        // Webhook + follower fan-out + thread resolves + realtime/render/re-anchor, via the
        // one shared helper — event parity with the HTTP publish route (an open tab
        // live-reloads, the webhook outbox reaches integrations) with no chance to drift.
        // A live publish that fixes feedback resolves those threads directly here (no
        // approval step, unlike a proposal's `addressed`).
        const { resolved } = await afterPublish(
          {
            meta: ctx.meta,
            blobs: ctx.blobs,
            bus: ctx.bus,
            notify: ctx.notify,
            notifyRender: ctx.notifyRender,
            background: ctx.background,
          },
          artifact,
          version,
          { isNew: !short_id, onBehalf: actingFor?.id ?? null, resolves: addresses ?? [] },
        )
        // The /derive loop: ask the human to review this live version.
        let review_round: string | null = null
        if (request_review && actingFor) {
          const round = await ctx.meta.createReviewRound({
            id: newId("rr"),
            artifact_id: artifact.id,
            version: version.n,
            requested_by: agent.id,
            requested_for: actingFor.id,
          })
          review_round = round.id
          ctx.bus.publish(artifact.id, { type: "review.requested", round_id: round.id })
          await ctx.notify(artifact, "review.requested", {
            version: version.n,
            requested_by: agent.name,
          })
          // The review request is the one event that earns an email: the loop is
          // blocked on the human, who may have no tab open (same policy as the
          // HTTP publish path). `settings` is only pre-loaded on a create, so a
          // republish (where most review rounds happen) fetches the gate here.
          if ((settings ?? (await ctx.meta.getOrgSettings(targetOrg))).emailNotifications) {
            const [r] = await ctx.meta.getUsers([actingFor.id])
            if (r?.email)
              await enqueueChannelDelivery(ctx.meta, "email", "review.requested", {
                to: r.email,
                toName: r.name ?? undefined,
                ...buildReviewEmail(ctx.deps.baseUrl, artifact, {
                  requestedBy: agent.name,
                  version: version.n,
                }),
              })
          }
          // Same interrupt, mirrored to Slack (independent of the email gate above —
          // gated on the reviewer's own Slack-DM preference instead).
          await enqueueSlackReviewRequestedDm(
            { meta: ctx.meta, baseUrl: ctx.deps.baseUrl },
            artifact,
            { requestedBy: agent.name, version: version.n },
            actingFor.id,
          )
        }
        const url = artifactUrl(ctx.deps.baseUrl, artifact)
        // Bell entry for the human behind the grant, so a push reaches them even
        // with no tab open (the on-the-go path). One row per push that warrants
        // one: a review ask beats a plain "published" (never both).
        if (actingFor && (review_round || !short_id)) {
          const row = {
            id: newId("n"),
            user_id: actingFor.id,
            actor: agent.name,
            kind: review_round ? ("review" as const) : ("publish" as const),
            artifact_id: artifact.id,
            artifact_short_id: artifact.short_id,
            artifact_title: artifact.title,
            thread_id: "",
            comment_id: "",
            preview: review_round
              ? `requested your review of v${version.n}`
              : (artifact.title ?? "published something new"),
          }
          await ctx.meta.createNotification(row)
          ctx.bus.publish(`u:${actingFor.id}`, {
            type: "notification",
            notification: { ...row, read: 0, created_at: new Date().toISOString() },
          })
        }
        // Auto-open: tell the granting user's open tabs an agent just pushed. The
        // delivery receipt (how many live streams caught it) becomes
        // `opened_in_tab`, so the agent knows whether to open the URL locally.
        let openedInTab = false
        if (actingFor) {
          const channel = `u:${actingFor.id}`
          // Same service flag as the /v1 publish path: a context-bound agent's
          // push is routinely someone ELSE's ask — the client toasts instead of
          // auto-opening the owner's tab.
          const contexts = await ctx.meta.listContexts(artifact.org_id)
          const service = contexts.some((x) => x.agent_id === agent.id)
          const pushed = {
            type: "artifact.pushed" as const,
            event_id: newId("ev"),
            short_id: artifact.short_id,
            artifact_id: artifact.id,
            title: artifact.title,
            version: version.n,
            kind: short_id ? "revised" : "created",
            url,
            agent: agent.name,
            review_requested: !!review_round,
            service,
          }
          if (ctx.bus.publishWithReceipt) {
            openedInTab =
              (await withTimeout(ctx.bus.publishWithReceipt(channel, pushed), 1500, 0)) > 0
          } else {
            ctx.bus.publish(channel, pushed)
          }
        }
        // Each bundle page (including any bound images) is directly fetchable once
        // live — surfacing the URLs here is the fix for an agent that can't find
        // them otherwise and falls back to inlining base64 (see the "cheap image
        // embedding" handoff): no separate call needed to learn where a page serves.
        const pageUrls = isBundle
          ? Object.fromEntries(
              Object.keys(files as Record<string, string>).map((p) => [
                cleanPath(p),
                `${ctx.deps.baseUrl}/raw/${artifact.short_id}/v/${version.n}/${cleanPath(p)}`,
              ]),
            )
          : null
        return json({
          published: true,
          short_id: artifact.short_id,
          ...(review_round ? { review_requested: true } : {}),
          kind: artifact.kind,
          version: version.n,
          url,
          ...(pageUrls ? { page_urls: pageUrls } : {}),
          title: artifact.title,
          workspace_access: artifact.workspace_access,
          link_role: artifact.link_role,
          listed: artifact.listed,
          ...(editsApplied ? { edits_applied: editsApplied } : {}),
          ...(resolved.length ? { resolved } : {}),
          ...(actingFor ? { opened_in_tab: openedInTab } : {}),
          note:
            (merge
              ? `Live now — merged ${Object.keys(files as Record<string, string>).length} file(s) into the bundle (new current version).`
              : short_id
                ? "Live now — published a new current version."
                : "Live now — created a new artifact in your workspace.") +
            (actingFor && !openedInTab
              ? " No open Derive tab caught this push — open the url for the user (e.g. run `open <url>`) if they should see it now."
              : ""),
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
    const ownerId = await ctx.privateOwnerId(c)
    const actingFor = ownerId ? ((await ctx.meta.getUsers([ownerId]))[0] ?? null) : null
    // The grant's uncapped scope role (OAuth) — or the agent's own role for a
    // registered dk_agt_ token — is what a roamed workspace's role is re-capped
    // from, mirroring agentFor's X-Derive-Workspace re-home. boundWorkspaces is the
    // consent multi-select (empty = all): the MCP surface clamps to it.
    const grant = await ctx.oauthGrant(c)
    const scopeForCap = grant?.scopeRole ?? agent.role
    const boundWorkspaces = grant?.boundWorkspaces ?? []
    const server = await buildServer(ctx, agent, actingFor, ownerId, scopeForCap, boundWorkspaces)
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return transport.handleRequest(c)
  })
}
