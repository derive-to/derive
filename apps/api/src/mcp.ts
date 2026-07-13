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
// tool slot. Seven tools, one per intent — WORKSPACES (list_workspaces), FIND
// (list_artifacts), READ content (read), GREP (search), CATCH UP on state/feedback/
// history (catch_up), COMMENT (comment), and WRITE (publish). Variation lives in
// parameters, never a new tool: `since_version`/`to_version` turn catch_up into a
// diff, `reply_to`/`set_state` fold reply+resolve into comment, `for_review`/role
// turn publish into a human-reviewed proposal, and omitting `short_id` turns
// `search` from grep-one-artifact into grep-the-workspace. A new capability is a
// parameter on an existing tool, not a new tool — every extra tool costs the agent
// a slot to understand and choose between.

import {
  type AgentRecord,
  type ArtifactRecord,
  artifactUrl,
  type BundleManifest,
  brandprintInstructions,
  bundleDoc,
  capRole,
  diffLines,
  EditError,
  formatDiff,
  isHtmlLike,
  landmarkSlice,
  landmarksOf,
  looksLikeHtmlDocument,
  newId,
  type OutlineSection,
  outlineOf,
  PublishError,
  parseBrandprint,
  parseFrontmatter,
  profileState,
  propose as proposeChange,
  publishAdvisories,
  publish as publishVersion,
  type Role,
  resolveBrandprint,
  roleAllows,
  SKILL_CONTENT_TYPE,
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
import { clip, MAX_CHARS } from "./lib/clip"
import { parseMeta, quoteOf, REACTIONS } from "./lib/comments"
import { type MaterializedEdits, materializeEdits, preservingFilename } from "./lib/edits"
import { buildReviewEmail } from "./lib/email"
import { MAX_UPLOAD_BYTES } from "./lib/http"
import { notifyCommentBells } from "./lib/notify-comment"
import {
  baseType,
  isTextType,
  present,
  type ReadFormat,
  searchArtifactVersion,
  searchMatcher,
  searchReport,
  searchWorkspace,
  workspaceSearchReport,
} from "./lib/search"
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

// Above this, a section-less read of a sectionable doc returns its OUTLINE instead of
// a blind dump: ~9k tokens leaves room to read on, small enough that most docs still
// arrive whole. Measured on the formatted body, not the raw source.
const FULL_DOC_MAX = 30_000

// Cap on landmark regions in a headless-page map: a card grid can have thousands of
// top-level sections/articles, and the map (built to AVOID a wall of text) must not
// itself blow the response budget. The rest are summarized as a "+N more" count.
const PAGE_MAP_MAX = 50

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

// A 1-indexed, inclusive line range for windowed reads: "40-120", "40" (one line),
// or "40-" (from 40 to the end). Returns null on a malformed, inverted, or
// out-of-range start (a `from` past the end has no valid window — the caller errors
// with the real line count rather than returning an empty "999-5" window).
const parseLineRange = (spec: string, total: number): { from: number; to: number } | null => {
  const m = spec.trim().match(/^(\d+)(?:-(\d*))?$/)
  if (!m) return null
  const from = Number(m[1])
  if (from < 1 || from > total) return null
  const to = m[2] === undefined ? from : m[2] === "" ? total : Number(m[2])
  if (to < from) return null
  return { from, to: Math.min(to, total) }
}

const summarizeArtifact = (a: ArtifactRecord) => ({
  short_id: a.short_id,
  title: a.title,
  kind: a.kind,
  // Skill-ness rides the denormalized content type — a skill is a bundle, so `kind`
  // alone can't distinguish it from a docs/site bundle. Surfaced so an agent can spot
  // reusable procedure without opening each bundle.
  is_skill: a.current_content_type === SKILL_CONTENT_TYPE,
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
        `history, text-anchored review comments, and a publish → review → revise loop. Fully-styled ` +
        `HTML pages are first-class too: a single-file artifact with its own <style>, scripts, fonts ` +
        `and images renders as-authored in a sandboxed viewer — publish real designed pages, not just ` +
        `prose. ` +
        `Start a session with catch_up to re-sync on what changed and what feedback is open; use ` +
        `read to view content — it returns Markdown by default (HTML is converted) and an outline ` +
        `first for large documents or bundles, so pull sections by heading slug or page path once ` +
        `you know what you want; pass format:'html' for the exact source. On a large artifact, use ` +
        `search to grep for a spot and read's \`lines\` to window just that range, instead of ` +
        `pulling the whole thing. Not sure WHICH artifact has something? Call search without ` +
        `short_id to grep across the workspace instead — same tool, that one parameter omitted. ` +
        `After publishing a styled page, call read with render:"top" (or ` +
        `"full"/"marked") to SEE what shipped — it catches visual breakage no text ` +
        `read can. Use comment to leave or ` +
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

  const GENERIC_CONVENTION = "A Brandprint convention: how this workspace likes its stuff built."

  // A Brandprint member's resource shape. A SKILL bundle carries its own identity in
  // SKILL.md frontmatter — name + description ARE progressive disclosure, so they must
  // reach the resource list (not a generic label), and its auxiliary files (scripts/,
  // references/) are announced so the agent knows to `read` them. Reading the skill's
  // entry at connect is what surfaces that identity; a plain doc reads nothing here and
  // keeps loading its body lazily on read. `body` set ⇒ prepared at connect (skill:
  // frontmatter stripped, file footer appended); undefined ⇒ fetched lazily below.
  const brandprintMember = async (
    doc: ArtifactRecord,
  ): Promise<{ title: string; description: string; mimeType: "text/markdown"; body?: string }> => {
    const generic = {
      title: doc.title ?? doc.short_id,
      description: GENERIC_CONVENTION,
      mimeType: "text/markdown" as const,
    }
    if (doc.current_content_type !== SKILL_CONTENT_TYPE) return generic
    // This runs at CONNECT (to surface the skill's frontmatter identity), so a read
    // failure here must NEVER break the whole connection — fall back to the generic
    // descriptor + the lazy body path, exactly as a non-skill member behaves.
    try {
      const v = await ctx.meta.getVersion(doc.id, doc.current_version)
      const manifest = v ? await manifestOf(ctx, v) : null
      const entry = v ? await ctx.sourceText(v) : null // the SKILL.md, frontmatter intact
      if (!manifest || entry === null) return generic
      const info = bundleDoc(manifest, entry)
      const others = info.files.map((f) => f.path).filter((p) => p !== info.entry)
      const footer = others.length
        ? `\n\n---\nOther files in this skill — read them with the read tool ` +
          `(read short_id:"${doc.short_id}" section:"${others[0]}"): ${others.join(", ")}`
        : ""
      return {
        title: info.name ?? doc.title ?? doc.short_id,
        description: info.description ?? GENERIC_CONVENTION,
        mimeType: "text/markdown",
        body: parseFrontmatter(entry).body + footer,
      }
    } catch {
      return generic
    }
  }

  // Brandprint conventions as resources: derive://brandprint/<short_id>. A plain doc's
  // body is fetched lazily (the current version's text); a skill's is prepared at connect
  // (we read its entry anyway to surface the frontmatter identity). audience:["assistant"].
  for (const doc of bpSources) {
    const m = await brandprintMember(doc)
    server.registerResource(
      `brandprint:${doc.short_id}`,
      `derive://brandprint/${doc.short_id}`,
      {
        title: m.title,
        description: m.description,
        mimeType: m.mimeType,
        annotations: { audience: ["assistant"], priority: 0.9 },
      },
      async (uri) => {
        if (m.body !== undefined)
          return { contents: [{ uri: uri.href, mimeType: m.mimeType, text: m.body }] }
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
    // A taken-down artifact serves NO content, mirroring the web /raw 410: read, search,
    // comment, and publish all resolve through here, so gating it once covers every
    // one-artifact tool. It stays visible as a tombstone in list_artifacts (metadata
    // only). Checked AFTER the reach/membership gates so it never confirms a removed
    // short_id to someone who couldn't have reached it anyway (they still get notFound).
    if (a.removed_at) return { error: `"${shortId}" was taken down and is no longer available.` }
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
        "List the artifacts (docs, plans, sites, skills) in a workspace — short id, title, kind, is_skill, current version, access (workspace_access/link_role/listed). Defaults to your current workspace; pass `workspace` (id or name from list_workspaces) to list another one. Pass skills:true to list only skills (reusable agent procedure). Includes your own unlisted publishes — out of the shared library, but you always find your work. Start here to find what to work on, then catch_up or read it.",
      inputSchema: {
        query: z.string().optional().describe("Optional title search filter."),
        skills: z
          .boolean()
          .optional()
          .describe("Only list skills (bundles with a SKILL.md — reusable agent procedure)."),
        workspace: wsArg,
      },
    },
    async ({ query, skills, workspace }) => {
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
      // Skill-ness isn't a store-level filter (it's the denormalized content type), so
      // narrow here — a title `query` still composes with it.
      const rows = skills ? arts.filter((a) => a.current_content_type === SKILL_CONTENT_TYPE) : arts
      return json({ workspace: t.org, count: rows.length, artifacts: rows.map(summarizeArtifact) })
    },
  )

  // READ CONTENT --------------------------------------------------------------
  server.registerTool(
    "read",
    {
      description:
        "Read an artifact's CONTENT by short id, as Markdown by default (HTML is converted to its readable text — note a styled page renders fully to VIEWERS; only this reading view flattens it). Small docs return whole; a LARGE doc returns its heading OUTLINE first — call again with a `section` slug for just that part. Multi-page bundle: omit `section` for the page outline, then pass a page path (optionally `page.html#slug`). Pass format:'html' for the exact source (required before publish `edits`), or a past `version` for history. (For what CHANGED, or the comment threads, use catch_up.)",
      inputSchema: {
        short_id: z.string().describe("The artifact's short id, e.g. nk0dsral."),
        section: z
          .string()
          .optional()
          .describe(
            'What to read. Single-file doc: a heading slug from the outline (e.g. rollout-plan), or a region ref like "@2" from a headless page\'s map. Bundle: a page path (agentic-loop.html), optionally with a slug (agentic-loop.html#risks). Pass "*" (or "page.html#*" for a bundle page) to force the full (clipped) document/page. Omit it: small docs/pages return whole, large ones return their outline or region map.',
          ),
        format: z
          .enum(["markdown", "html", "text"])
          .optional()
          .describe(
            "markdown (default): HTML converted to structured Markdown — headings, lists, tables, code fences; Markdown sources return as-is. html: the exact stored source — read this BEFORE publish `edits` on an HTML artifact (edits match raw source). text: flat visible text, exactly what comment `quote`s anchor against.",
          ),
        lines: z
          .string()
          .optional()
          .describe(
            'Windowed read: a 1-indexed inclusive line range of the body in the chosen format — "40-120", "40" (one line), or "40-" (to the end). Windows a single-file doc, or one bundle page named by a bare `section` path. Pair with format:"html" to window the exact source before an edit. Skips the outline; still capped.',
          ),
        render: z
          .enum(["top", "full", "marked"])
          .optional()
          .describe(
            'SEE the published page instead of reading its text — what a viewer actually sees, catching visual breakage (a failed font, a broken layout) no text read can. "top": the 1200x630 crop (fastest, what an og:image unfurl shows). "full": the whole page, fullPage screenshot — catches below-the-fold breakage "top" misses. "marked": "full" again with the region map\'s @N refs drawn on it — pairs with a no-heading page\'s region map so what you SEE lines up with what you READ. All three computed a few seconds after each publish; pass alone (optionally with `version`).',
          ),
        version: z.number().optional().describe("Defaults to the current version."),
        workspace: wsArg,
      },
    },
    async ({ short_id, section, format, version, lines, render, workspace }) => {
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

      // The render rung: the version's screenshot, so an agent SEES what it shipped.
      // The preview pipeline computes all three variants per publish (previews.ts);
      // this surfaces whichever one was asked for. Each lives on its own
      // key/status/error triple, so "full"/"marked" failing never blocks "top" (the
      // OG crop og:image unfurls depend on) and vice versa.
      if (render) {
        if (section || lines)
          return err(
            "`render` is a view of the whole version — pass it alone (with `version` for history).",
          )
        const variant =
          render === "top"
            ? { key: v.preview_key, status: v.preview_status, error: v.preview_error }
            : render === "full"
              ? {
                  key: v.preview_full_key,
                  status: v.preview_full_status,
                  error: v.preview_full_error,
                }
              : {
                  key: v.preview_marked_key,
                  status: v.preview_marked_status,
                  error: v.preview_marked_error,
                }
        const label =
          render === "top"
            ? "the top of the page, 1200x630"
            : render === "full"
              ? "the whole page"
              : "the whole page, with the region map's @N refs drawn on it"
        if (variant.status === "ready" && variant.key) {
          const png = await ctx.blobs.get(variant.key)
          if (png) {
            if (png.length > IMAGE_INLINE_MAX)
              return json({
                short_id,
                version: n,
                render: "ready",
                bytes: png.length,
                note: `Too large to inline over MCP — open ${url} to view the page.`,
              })
            return {
              content: [
                {
                  type: "text" as const,
                  text: `render:${render} of "${short_id}" v${n} — ${label} (${png.length} bytes), as a viewer sees it. The source is untouched; use read/search for the text.`,
                },
                { type: "image" as const, data: toBase64(png), mimeType: "image/png" },
              ],
            }
          }
        }
        if (variant.status === "failed")
          return err(
            `The render:${render} of "${short_id}" v${n} failed${variant.error ? ` (${variant.error})` : ""} — the page may still be fine; open ${url} to check, or republish to retry.`,
          )
        return err(
          `The render:${render} of "${short_id}" v${n} isn't ready yet — screenshots are computed a few seconds after publish. Try again shortly.`,
        )
      }
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
        if (lines) {
          if (section && section !== "*")
            return err("Pass `lines` OR `section`, not both — windowing applies to the whole doc.")
          const body = present(src, ct, fmt)
          const all = body.split("\n")
          const range = parseLineRange(lines, all.length)
          if (!range)
            return err(
              `Bad \`lines\` "${lines}" for "${short_id}" v${n} (1..${all.length}) — use "40-120", "40", or "40-".`,
            )
          const windowed = all.slice(range.from - 1, range.to).join("\n")
          return doc(
            {
              ...meta,
              lines: `${range.from}-${range.to} of ${all.length}`,
              chars: windowed.length,
            },
            clip(windowed),
          )
        }
        // Region read: "@N" pulls the Nth landmark region from the page map, so a
        // headless page's map is directly readable, not just orientation.
        const regionRef = section?.match(/^@(\d+)$/)
        if (regionRef) {
          const idx = Number(regionRef[1])
          const slice = landmarkSlice(src, idx)
          if (slice === null) {
            const count = landmarksOf(src, ct).length
            return err(
              count
                ? `No region @${idx} in "${short_id}" — it has ${count} region(s), @1..@${count}. Read with no \`section\` for the map.`
                : `"${short_id}" has no landmark regions — read a heading \`section\`, a \`lines\` range, or the whole doc.`,
            )
          }
          const body = present(slice, ct, fmt)
          const count = landmarksOf(src, ct).length
          return doc(
            { ...meta, section: `@${idx} of ${count} regions`, chars: body.length },
            clip(body),
          )
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
          // No headings — a designed, headless HTML page (dashboard, card grid) still
          // has landmark structure. Return that map so the agent can search/window in
          // rather than blindly dumping a clipped wall of text.
          const regions = landmarksOf(src, ct)
          if (regions.length)
            return json({
              short_id,
              title: a.title,
              kind: a.kind,
              version: n,
              source: ct,
              format: fmt,
              doc_chars: body.length,
              url,
              regions: regions
                .slice(0, PAGE_MAP_MAX)
                .map((region, i) => ({ ref: `@${i + 1}`, ...region })),
              ...(regions.length > PAGE_MAP_MAX
                ? { more_regions: regions.length - PAGE_MAP_MAX }
                : {}),
              next: 'This page has no headings — it is mapped by region above. Read a region directly with its `ref` (e.g. section:"@1"), or `search` for a term. section:"*" forces the full clipped text.',
            })
          // Truly unstructured — fall through to a plain (clipped) return, reusing the
          // already-computed (empty) outline instead of asking again.
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
      if (lines) {
        if (slug)
          return err("Pass `lines` OR a #slug, not both — windowing applies to a whole page.")
        const pageBody = isText ? present(raw, file.type, fmt) : raw
        const all = pageBody.split("\n")
        const range = parseLineRange(lines, all.length)
        if (!range)
          return err(
            `Bad \`lines\` "${lines}" for "${cleanPath(pagePath)}" (1..${all.length}) — use "40-120", "40", or "40-".`,
          )
        const windowed = all.slice(range.from - 1, range.to).join("\n")
        return doc(
          {
            ...meta,
            section: cleanPath(pagePath),
            lines: `${range.from}-${range.to} of ${all.length}`,
            chars: windowed.length,
          },
          clip(windowed),
        )
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
        const regions = landmarksOf(raw, file.type)
        if (regions.length)
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
            regions: regions.slice(0, PAGE_MAP_MAX),
            ...(regions.length > PAGE_MAP_MAX
              ? { more_regions: regions.length - PAGE_MAP_MAX }
              : {}),
            next: `This page has no headings — it is mapped by region above. Use \`search\` to find a term, then read with \`lines:"from-to"\` to window that part, or "${cleanPath(pagePath)}#*" for the full clipped text.`,
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

  // SEARCH — grep within one artifact, so an agent finds a spot without a full read
  server.registerTool(
    "search",
    {
      description:
        "Find text within ONE artifact, or across a WORKSPACE. Pass short_id to grep one artifact (not a full read): matching lines with line numbers (and optional context), ripgrep-style, so you can then `read` a narrow `lines` range (in the format the result names) or `edit` that spot. A bundle is searched across all its text pages, grouped by page. Omit short_id to search across the workspace — the artifacts you can see (same visibility rules as list_artifacts), ranked by relevance and grouped by artifact — so you can find WHICH doc has something before opening it; a note tells you when more matched than were shown. Searches the exact source by default (in:'text' searches the visible text instead). The query is matched literally (metacharacters are not special).",
      inputSchema: {
        short_id: z
          .string()
          .optional()
          .describe(
            "The artifact's short id, e.g. nk0dsral. Omit to search across the workspace instead of one artifact.",
          ),
        query: z.string().describe("The literal text to find (metacharacters are not special)."),
        case_sensitive: z.boolean().optional().describe("Default false."),
        in: z
          .enum(["source", "text"])
          .optional()
          .describe(
            "source (default): the exact stored bytes — the positions you'd `edit`. text: the visible text a reader sees (HTML tags stripped).",
          ),
        context: z
          .number()
          .optional()
          .describe("Lines of surrounding context to show around each match (default 0, max 5)."),
        max_matches: z
          .number()
          .optional()
          .describe(
            "Cap on matches returned per artifact (default 40, max 200). Applies to each artifact scanned in workspace mode too.",
          ),
        version: z
          .number()
          .optional()
          .describe("Defaults to the current version. Ignored in workspace mode (always current)."),
        workspace: wsArg,
      },
    },
    async ({
      short_id,
      query,
      case_sensitive,
      in: scope,
      context,
      max_matches,
      version,
      workspace,
    }) => {
      if (!query) return err("`query` is required.")
      const re = searchMatcher(query, case_sensitive ?? false)
      const ctxLines = Math.min(Math.max(context ?? 0, 0), 5)
      const cap = Math.min(Math.max(max_matches ?? 40, 1), 200)
      const where = scope ?? "source"

      if (!short_id) {
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const { results, note } = await searchWorkspace(ctx, {
          orgId: t.org,
          viewerId: actingFor?.id ?? agent.id,
          query,
          re,
          where,
          ctxLines,
          cap,
        })
        return text(workspaceSearchReport(query, where, results, note))
      }

      const r = await reach(short_id, workspace)
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(short_id)
      const a = r.a
      const n = version ?? a.current_version
      if (n < 1 || n > a.current_version)
        return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
      const v = await ctx.meta.getVersion(a.id, n)
      if (!v) return err(`Version ${n} of "${short_id}" is unavailable.`)
      const { groups, total, note } = await searchArtifactVersion(ctx, v, re, where, ctxLines, cap)
      return text(searchReport(short_id, query, where, total, cap, groups, note))
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
        "WAITING ON SOMETHING? Pass `wait` (seconds, max 50): the call blocks until the human sends back / approves / comments / publishes a new version (or the time runs out), then returns the fresh state — including anything new since `since_version`. Works with no pending review too: co-editing live with a human, `wait` blocks until THEIR next save lands. Chain wait calls instead of sleeping between polls — feedback reaches you in seconds.",
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
            "Long-poll: block up to this many seconds for the human's next action (send back, approve, a new comment, or a new published version — e.g. co-editing the artifact live) before returning. Returns immediately when something is already actionable.",
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
        "Save a revision of an artifact. It goes LIVE immediately if your role can publish (Creator/Admin); otherwise — or whenever you pass for_review:true — it is filed as a PROPOSAL a human approves before it goes live. To CHANGE PART of a single-file artifact, prefer `edits` (exact-match search/replace against the stored source — read format:'html' first) over resending everything. Otherwise provide the full `content` for a SINGLE-FILE artifact, or `files` (a map of page path → content) for a MULTI-PAGE BUNDLE (a whole site, images and any binary asset). OMIT short_id to create a NEW artifact (`title` required); PASS short_id to add a version to one you own, matching its kind. A bundle republish REPLACES the whole bundle, so include EVERY page and asset (or use `merge`). Pass `addresses` with the thread ids (from catch_up) this revision resolves. (Proposals are single-file only; bundles must be published directly.) FULLY-STYLED HTML renders as-authored (own <style>/scripts/fonts) in the sandboxed viewer — two rules: declare your own <meta name=\"viewport\"> (pages without one get a mobile-reflow injection whose media caps can fight intentional layouts; `data-reflow-exempt` on an element is the per-component escape hatch), and self-host binaries via POST /v1/assets (images AND woff2 fonts) instead of base64. The response echoes `content_sha256` of the stored bytes — verify it when the content passed through your context.",
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe(
            "The complete content for a SINGLE-FILE artifact (HTML or Markdown). Use this OR `files`, not both. To embed an image OR a web font CHEAPLY (no base64 in this call), upload the raw bytes to POST /v1/assets first (PNG/JPEG/GIF/WebP/WOFF/WOFF2) — the response's `url` is a permanent public link; paste it into an `<img src>`, a CSS `url()`, or markdown `![]()`. Never inline a base64 data: URI here — it tokenizes at roughly 1 token/char (one modest screenshot can cost 100k+ tokens), and content carried through your context can be silently mistranscribed; binaries should travel as bytes. If you have shell access and the file is large, you can also POST it directly to /v1/artifacts (raw body) with your bearer token — zero tokens through this call.",
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
                  "Exact text from the STORED SOURCE (read format:'html' first on an HTML artifact — the markdown view will not match). Must occur exactly once, unless `occurrence` picks one of several.",
                ),
              new_str: z.string().describe("Replacement text. Empty string deletes."),
              occurrence: z
                .number()
                .optional()
                .describe(
                  "1-based index of WHICH match to replace, when old_str is intentionally non-unique (a phrase repeated verbatim). Omit when old_str already matches once.",
                ),
            }),
          )
          .optional()
          .describe(
            "Surgical revision of a SINGLE-FILE artifact without resending it: exact-match search/replace against the current stored source, applied in order (each edit sees the previous one's result). Errors — applying nothing — if any old_str matches zero times, or matches more than once without `occurrence`; a miss's error explains why (whitespace difference, or the doc changed) so you can fix it in one round. Requires `short_id`; use INSTEAD of `content`. Composes with for_review, addresses, message, request_review.",
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
          // Single-file publishes report the stored bytes' sha256 (the content-
          // addressed blob key) so callers can verify what landed matches what
          // they sent.
          ...(artifact.kind === "file" ? { content_sha256: version.blob_key } : {}),
          ...(pageUrls ? { page_urls: pageUrls } : {}),
          // The publish→look loop: a screenshot of the served page is queued at every
          // publish; seeing it is the only way to catch purely-visual breakage.
          render: `queued — call read(short_id:"${artifact.short_id}", render:"top") in a few seconds to SEE the published page ("full"/"marked" for the whole page, or with the region map's @N refs drawn on it).`,
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
              : "") +
            // Advisories over what was just stored (missing viewport meta, oversized
            // inline base64). `content` holds the full document for both direct and
            // edits publishes — materializeEdits assigned into it above.
            (typeof content === "string" && artifact.kind === "file"
              ? publishAdvisories(content, version.content_type)
                  .map((advisory) => ` ${advisory}`)
                  .join("")
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
