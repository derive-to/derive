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
// tool slot.
//
// THIN TOOLS, THICK SKILLS (spec: the "Thin tools, thick skills" plan on Derive). The always-loaded surface
// — every tool description plus the server `instructions` — is context every connected
// agent pays for before it does anything, so it stays THIN: each description states
// intent, keeps its safety/consequence lines, and steers to a skill at the decision
// point. The actual working procedure lives in five lazily-read CORE SKILLS
// (src/skills-reference.ts), served as derive://skills/<name> resources AND readable via
// read("derive://skills/<name>") — exactly how derive://brandprint/* works. The
// instructions carry only a one-line index of them. The mcp-surface-budget test guards
// the thinness.
//
// TEN tools, one per intent — WORKSPACES (list_workspaces), FIND (find: BROWSE the
// library, GREP one artifact, or SEARCH the workspace — plus the askable contexts,
// all discriminated by argument), READ content (read), CATCH UP on state/feedback/
// history AND pull the WORK QUEUE (catch_up: with a short_id it's one artifact's
// delta; with none it's the @mention inbox teammates handed this agent — the ask-agent
// and Rework buttons — so the queue is a mode of catch_up, not its own slot), COMMENT
// (comment), WRITE (publish: also the home for the Brandprint profile — publishing to
// derive://brandprint/profile scaffolds the slot on first write, so brand setup is a
// publish target, not a separate tool), STAGE out-of-band uploads (stage: target:'doc'
// for a whole big document/bundle, target:'asset' for an image/font — one tool, two
// upload URLs), SAVE working state (checkpoint), and USE a workspace context (use:
// query the live data agents a workspace hosts, acting for the connection's human — the
// one intent where Derive routes a question to a runner).
// Variation lives in parameters, never a new tool: `since_version`/`to_version` turn
// catch_up into a diff and omitting `short_id` turns it into the work queue,
// `reply_to`/`set_state` fold reply+resolve into comment, `for_review`/role turn publish
// into a human-reviewed proposal, and `find` collapses browse/grep/search/contexts onto
// `query`/`short_id`/`tag`. A new capability is a parameter on an existing tool, not a
// new tool — every extra tool costs the agent a slot to understand and choose between.

import {
  AGENT_INBOX_PAGE,
  type AgentRecord,
  type ArtifactRecord,
  artifactUrl,
  type BundleManifest,
  brandprintInstructions,
  bundleDoc,
  type ContextRecord,
  capRole,
  diffLines,
  EditError,
  formatDiff,
  isHtmlLike,
  landmarkSlice,
  landmarksOf,
  looksLikeHtmlDocument,
  newId,
  newShortId,
  type OutlineSection,
  outlineOf,
  PublishError,
  parseFrontmatter,
  pendingRequestsPointer,
  profileState,
  propose as proposeChange,
  publishAdvisories,
  publish as publishVersion,
  type Role,
  roleAllows,
  type SessionRecord,
  SKILL_CONTENT_TYPE,
  sectionOf,
  toMarkdown,
  type VersionRecord,
} from "@derive/core"
import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import { z } from "zod"
import {
  BRANDPRINT_REFERENCE,
  BRANDPRINT_TEMPLATE,
  PROFILE_PLACEHOLDER_HTML,
} from "./brandprint-reference"
import type { AppContext } from "./context"
import { markAddressed } from "./lib/addressed"
import { afterPublish } from "./lib/after-publish"
import { resolveActorBrandprint } from "./lib/brandprint"
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
import { MAX_ASSET_BYTES } from "./lib/image"
import { notifyCommentBells } from "./lib/notify-comment"
import { PUBLISH_TARGET_CREATE, PUBLISH_TOKEN_TTL_MS, signPublishToken } from "./lib/publish-token"
import {
  baseType,
  isTextType,
  present,
  type ReadFormat,
  searchArtifactVersion,
  searchMatcher,
  searchReport,
  searchWorkspace,
  toSearchHits,
} from "./lib/search"
import { enqueueSlackReviewRequestedDm } from "./lib/slack-dm"
import { computeTagSuggestions } from "./lib/tag-suggestions"
import { normalizeTags } from "./lib/tags"
import { signUploadToken, UPLOAD_TOKEN_TTL_MS } from "./lib/upload-token"
import { CORE_SKILLS } from "./skills-reference"
import { enqueueChannelDelivery } from "./webhooks"

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })
// Bound a best-effort promise (the tab-delivery receipt) so it can never stall a
// publish: past `ms`, resolve with the fallback and move on.
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
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

// publish guardrails — reject inline payloads that belong out-of-band, BEFORE writing,
// with an error naming the `stage` mode to use. A single base64 data: URI past this is a
// binary pasted through the tool call — it should be an asset (stage target:'asset').
const MAX_INLINE_DATA_URI_BYTES = 32 * 1024
// Total inline `content` (or summed `files`) past this is a whole big document that
// should be curled out-of-band (stage target:'doc') instead of chunked through context.
const MAX_INLINE_CONTENT_BYTES = 64 * 1024
// The decoded byte size of the LARGEST single base64 data: URI in a string (0 if none) —
// base64 encodes 3 bytes per 4 chars, so decoded ≈ payload_chars * 3/4.
const largestInlineDataUriBytes = (s: string): number => {
  let max = 0
  for (const m of s.matchAll(/data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)/g)) {
    const bytes = Math.floor(((m[1] ?? "").length * 3) / 4)
    if (bytes > max) max = bytes
  }
  return max
}

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
  // Forgiving: agents sometimes wrap the range in stray quotes (lines:'"40-120"') or
  // whitespace — strip surrounding quotes/space before matching, so "40-120" and
  // '"40-120"' parse identically.
  const cleaned = spec
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
  const m = cleaned.match(/^(\d+)(?:-(\d*))?$/)
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
  // A registered workspace agent (dk_agt_ token), not a human's OAuth grant. Only a
  // registered agent has a request inbox: it is the id an @mention can name.
  registered: boolean,
  // The workspaces this grant is scoped to (the consent multi-select). EMPTY =
  // "all workspaces" — every workspace the owner belongs to. A non-empty set
  // clamps list_workspaces + the `workspace` arg + cross-workspace read to
  // exactly those: workspaces outside the grant are invisible and unreachable.
  boundWorkspaces: string[],
): Promise<McpServer> {
  // The always-loaded CORE SKILLS index: one line per skill (name — summary — read
  // derive://skills/<name>), kept in lockstep with the skill bodies by iterating the
  // same array the resources register from. The workflow/protocol prose lives in those
  // lazily-read skills, not here.
  const skillsIndex = CORE_SKILLS.map(
    (s) => `- ${s.name} — ${s.summary} — read derive://skills/${s.name}`,
  ).join("\n")

  // Resolve the Brandprint for this actor: the workspace's conventions merged with the
  // owner's personal ones (profile wins). Each convention doc becomes a readable resource;
  // a one-line pointer goes in the instructions (bodies load lazily on read). The request
  // queue rides the same batch (independent reads), but only for a registered agent: an
  // OAuth grant's id is synthetic (oauth:<client>) and can never be @mentioned, so
  // querying its inbox would be a guaranteed-empty read on every human's every call.
  const [resolved, pendingRequests] = await Promise.all([
    resolveActorBrandprint(ctx.meta, agent.org_id, ownerId),
    registered ? ctx.meta.listPendingAgentMentions(agent.id, AGENT_INBOX_PAGE) : [],
  ])
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
      // High-level ORIENTATION, not a manual (SOTA per the MCP spec's "hint" framing and
      // GitHub/Goose/Cline/Codex: identity first, capability pointers second, procedure
      // deferred). Carries only what no single tool description conveys — identity, the loop
      // at altitude, where durable context lives (Brandprint), that work is queued, and the
      // core-skills index. The detailed workflow lives in the derive://skills/* bodies, and
      // actionable errors steer the rest at runtime.
      instructions:
        `You are connected to Derive as "${agent.name}"${
          actingFor ? ` on behalf of ${actingFor.name ?? "your user"}` : ""
        }, acting in workspace ${agent.org_id} ` +
        `with ${agent.role} permissions. Derive hosts living documents, plans, and skills with ` +
        `versioned history, text-anchored review comments, and a publish → review → revise loop; ` +
        `fully-styled HTML pages are first-class artifacts that render as-authored in a sandboxed ` +
        `viewer, so publish real designed pages, not just prose. Work the loop: start with catch_up ` +
        `to see what changed and what feedback is open, read to pull only the sections you need, then ` +
        `act — comment to give or resolve feedback, publish a revision, respond to review. This one ` +
        `login reaches every workspace in your grant: call list_workspaces to see them, then pass a ` +
        `workspace id or name as the "workspace" argument to act in another (read, catch_up, comment, ` +
        `publish, find); read/catch_up/comment also find a short_id in any of them ` +
        `automatically.\n\n` +
        `CORE SKILLS carry the working procedure for each intent — read the matching one (a resource, ` +
        `or read("derive://skills/<name>")) before you act:\n${skillsIndex}\n\n` +
        `Workspace skills (team procedures) exist too: find skills:true, then read.` +
        brandprintInstructions(bpSources.length, bpProfile) +
        pendingRequestsPointer(pendingRequests.length),
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
  // The generation reference: the build guide + the neutral benchmark page. Registered
  // UNCONDITIONALLY (not gated on an existing Brandprint) for two reasons: (1) they're
  // the static guide an agent needs precisely BEFORE a Brandprint exists, to build one;
  // (2) registering at least one resource is what makes the SDK advertise the `resources`
  // capability at `initialize` — gating them meant a session that connected to a
  // Brandprint-less workspace cached "no resources" for its whole life (capability is
  // negotiated once), so a later `set up my Brandprint` couldn't read them. They're also
  // reachable through the `read` tool (read("derive://brandprint/reference")), which every
  // client supports even when MCP resources aren't. Derive runs no inference; these two
  // static files are its entire side of profile generation, the user's agent assembles it.
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

  // The CORE SKILLS as resources: derive://skills/<name>. Registered UNCONDITIONALLY,
  // exactly like the Brandprint reference/template — they're the always-available
  // protocol the instructions index points at, their bodies loading lazily on read. Each
  // is also reachable through the `read` tool (read("derive://skills/<name>")), which
  // every client supports even where MCP resources aren't. audience:["assistant"].
  for (const skill of CORE_SKILLS) {
    server.registerResource(
      `skill:${skill.name}`,
      `derive://skills/${skill.name}`,
      {
        title: `Core skill — ${skill.name}`,
        description: skill.summary,
        mimeType: "text/markdown",
        annotations: { audience: ["assistant"], priority: 0.8 },
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: skill.body }],
      }),
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
    // A taken-down artifact serves NO content, mirroring the web /raw 410: read, find,
    // comment, and publish all resolve through here, so gating it once covers every
    // one-artifact tool. It stays visible as a tombstone in find's browse rows (metadata
    // only). Checked AFTER the reach/membership gates so it never confirms a removed
    // short_id to someone who couldn't have reached it anyway (they still get notFound).
    if (a.removed_at) return { error: `"${shortId}" was taken down and is no longer available.` }
    return { a, org, role }
  }
  const notFound = (shortId: string) =>
    err(
      `No artifact "${shortId}" you can reach in any of your workspaces. Call find (optionally with a workspace) to see what's there.`,
    )

  // The `workspace` argument shared by every workspace-scoped tool.
  const wsArg = z
    .string()
    .optional()
    .describe(
      "Workspace to act in — its id or name from list_workspaces. Omit for your default workspace; read/catch_up/comment also find a short_id in ANY of your workspaces automatically.",
    )

  // WORK QUEUE — what teammates asked this agent to do (a MODE of catch_up: no short_id).
  // The pull inbox behind the ask-agent and Rework buttons: a teammate @mentions this
  // agent in a comment and the request waits here until some session of the agent reads
  // and acks it. catch_up with no short_id returns it; only a REGISTERED workspace agent
  // has an inbox (an OAuth grant's id is oauth:<client>, which no @mention can name), so a
  // connection without one gets an explicit note instead of a bare empty list.
  const workQueue = async (ack?: string[], wait?: number) => {
    // No inbox at all: say so, rather than returning [] the agent might read as "no work".
    if (!registered)
      return json({
        acked: 0,
        pending: [],
        note: "This connection has no inbox — @mentions can't name an OAuth grant, so there's no work queue here (a registered workspace agent has one). Pass a short_id to catch up on an artifact instead.",
      })
    // The queue this request already read at connect (a fresh server per request, so it
    // is this call's snapshot). `acked` counts what actually LEFT the queue, so acking is
    // idempotent: the store matches a row whether or not it was already acknowledged, so
    // an unknown or repeated id would otherwise inflate the count.
    const queue = pendingRequests
    const handled = new Set((ack ?? []).filter((id) => queue.some((m) => m.id === id)))
    let acked = 0
    for (const id of handled) if (await ctx.meta.ackAgentMention(agent.id, id)) acked++
    let pending = queue.filter((m) => !handled.has(m.id))

    // Long-poll: when nothing is pending, subscribe to this agent's channel, then RE-READ
    // fresh (a request may have landed since connect, or during the wait) — the same
    // check-then-wait gap close catch_up uses. The event is only a wake signal; we always
    // answer from a fresh store read, so a missed or raced wake is never a wrong answer.
    if (wait && pending.length === 0 && ctx.bus.waitFor) {
      const release = new AbortController()
      const woke = ctx.bus
        .waitFor(`u:${agent.id}`, ["request.created"], wait * 1000, release.signal)
        .catch(() => null)
      const fresh = await ctx.meta.listPendingAgentMentions(agent.id, AGENT_INBOX_PAGE)
      if (fresh.length) {
        release.abort()
        await woke
      } else {
        await woke
      }
      pending = fresh.length
        ? fresh
        : await ctx.meta.listPendingAgentMentions(agent.id, AGENT_INBOX_PAGE)
    }
    return json({
      acked,
      pending: pending.map((m) => ({
        id: m.id,
        artifact: m.artifact_short_id,
        thread: m.thread_id,
        author: m.author,
        request: m.body,
        created_at: m.created_at,
      })),
    })
  }

  server.registerTool(
    "list_workspaces",
    {
      description:
        "List every workspace THIS grant can act in — id, name, your role there, and which is your default (the set you chose when you connected: all your workspaces, or a subset). Pass a workspace's id or name as the `workspace` argument to find / read / catch_up / comment / publish to act there. No reconnect — read/catch_up/comment even find a short_id across these workspaces automatically.",
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

  // FIND — one tool over BROWSE (list_artifacts) + GREP/SEARCH (search) + the askable
  // CONTEXTS (list_contexts), discriminated by argument. The mode is decided by what's
  // passed: `short_id` ⇒ grep within it; `query` alone ⇒ search the workspace; neither ⇒
  // browse. Result rows are typed (artifact | match | context) so a mixed listing is
  // unambiguous. -----------------------------------------------------------------------
  const CONTEXTS_NEED_HUMAN =
    "Contexts (askable live data agents) are hidden here: this connection has no signed-in user. Reconnect with an OAuth login to see and use them."
  // Askable contexts as typed `find` rows — INVARIANT (A): sourced ONLY from
  // askableContexts (the per-human canUserAskContext gate), so a roster-gated context this
  // user may not ask never appears; (B): with no acting human this returns [] and the
  // caller adds an explicit note rather than erroring. Each row carries its own open
  // sessions and the steer to reach it with `use`. (askableContexts/runnerOnline are
  // defined further down; referenced here from a handler that runs at call-time.)
  const contextFindRows = async (org: string, matches?: (name: string) => boolean) => {
    if (!actingFor) return []
    const human = actingFor
    const rows = await askableContexts(org, human.id)
    const picked = matches ? rows.filter(({ x }) => matches(x.name)) : rows
    return Promise.all(
      picked.map(async ({ x, manifest }) => {
        const open = (await ctx.meta.listSessions(x.id, { askerId: human.id, limit: 10 }))
          .filter((s) => s.state !== "closed")
          .map((s) => ({ id: s.id, state: s.state, updated_at: s.updated_at ?? s.created_at }))
        return {
          type: "context" as const,
          id: x.id,
          name: x.name,
          online: runnerOnline(x),
          manifest: manifest ? { short_id: manifest.short_id, title: manifest.title } : null,
          your_open_sessions: open,
          note: "Ask it on your user's behalf with `use` (a question or a commission).",
        }
      }),
    )
  }
  server.registerTool(
    "find",
    {
      description:
        "Find things in Derive — the MODE is decided by what you pass. Pass `short_id` + `query` to GREP within one artifact: matching lines with line numbers (in:'source'|'text', context lines, a past `version`), so you can then read a `lines` range or edit that spot. Pass `query` ALONE to SEARCH the whole workspace — artifacts ranked by relevance with a snippet each, so you find WHICH doc has something before opening it; this ALSO surfaces any askable context whose name matches. Pass NEITHER to BROWSE the library: every artifact (short id, title, kind, is_skill, version, access, tags — skills:true or a `tag` narrows it) PLUS the askable contexts. Rows are typed (artifact | match | context); a context row is reached with `use`, never read/opened. Includes your own unlisted work. For the browse→work rhythm, read derive://skills/loop.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "With `short_id`: the literal text to grep within it (metacharacters are not special). Alone (no short_id): the workspace content search. Omit both to browse.",
          ),
        short_id: z
          .string()
          .optional()
          .describe("Grep WITHIN this one artifact (needs `query`). Omit to browse or search."),
        tag: z
          .string()
          .optional()
          .describe("Browse only: artifacts carrying this browse tag (case-insensitive)."),
        skills: z
          .boolean()
          .optional()
          .describe(
            "Browse only: list only skills (bundles with a SKILL.md — reusable agent procedure).",
          ),
        case_sensitive: z.boolean().optional().describe("Grep/search: default false."),
        in: z
          .enum(["source", "text"])
          .optional()
          .describe(
            "Grep/search: source (default) the exact stored bytes (the positions you'd edit); text the visible text a reader sees (HTML tags stripped).",
          ),
        context: z
          .number()
          .optional()
          .describe(
            "Grep/search: lines of surrounding context around each match (default 0, max 5).",
          ),
        max_matches: z
          .number()
          .optional()
          .describe("Grep/search: cap on matches per artifact (default 40, max 200)."),
        version: z
          .number()
          .optional()
          .describe("Grep within a past version (short_id mode). Defaults to the current one."),
        workspace: wsArg,
      },
    },
    async ({
      query,
      short_id,
      tag,
      skills,
      case_sensitive,
      in: scope,
      context,
      max_matches,
      version,
      workspace,
    }) => {
      // MODE 1 — GREP WITHIN ONE ARTIFACT. Byte-for-byte the former search(short_id):
      // matching lines, line numbers, in:'source'|'text', context lines, a chosen version.
      if (short_id) {
        if (!query) return err("`query` is required to grep within an artifact (short_id).")
        const re = searchMatcher(query, case_sensitive ?? false)
        const ctxLines = Math.min(Math.max(context ?? 0, 0), 5)
        const cap = Math.min(Math.max(max_matches ?? 40, 1), 200)
        const where = scope ?? "source"
        const r = await reach(short_id, workspace)
        if (r && "error" in r) return err(r.error)
        if (!r) return notFound(short_id)
        const a = r.a
        const n = version ?? a.current_version
        if (n < 1 || n > a.current_version)
          return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
        const v = await ctx.meta.getVersion(a.id, n)
        if (!v) return err(`Version ${n} of "${short_id}" is unavailable.`)
        const { groups, total, note } = await searchArtifactVersion(
          ctx,
          v,
          re,
          where,
          ctxLines,
          cap,
        )
        return text(searchReport(short_id, query, where, total, cap, groups, note))
      }

      // MODE 2 — SEARCH THE WORKSPACE (ranked artifacts + a snippet each), plus any askable
      // context whose NAME matches the query. Typed rows: {type:"match"} + {type:"context"}.
      if (query) {
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const re = searchMatcher(query, case_sensitive ?? false)
        const ctxLines = Math.min(Math.max(context ?? 0, 0), 5)
        const cap = Math.min(Math.max(max_matches ?? 40, 1), 200)
        const where = scope ?? "source"
        const { results, note } = await searchWorkspace(ctx, {
          orgId: t.org,
          viewerId: actingFor?.id ?? agent.id,
          query,
          re,
          where,
          ctxLines,
          cap,
        })
        const matchRows = toSearchHits(results, query).map((h) => ({
          type: "match" as const,
          ...h,
        }))
        const q = query.toLowerCase()
        const contextRows = await contextFindRows(t.org, (name) => name.toLowerCase().includes(q))
        return json({
          workspace: t.org,
          query,
          where,
          count: matchRows.length + contextRows.length,
          results: [...matchRows, ...contextRows],
          ...(note ? { note } : {}),
          ...(actingFor ? {} : { contexts_note: CONTEXTS_NEED_HUMAN }),
        })
      }

      // MODE 3 — BROWSE the library: list_artifacts rows (skills:/tag facets), plus every
      // askable context. A tag filter resolves to an id set first (mirrors the HTTP ?tag=
      // path); viewerId keeps private rows scoped to the agent's human (mirrors `reach`).
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      const ids = tag ? await ctx.meta.artifactIdsByTag(tag.trim().toLowerCase()) : undefined
      const arts =
        ids && ids.length === 0
          ? []
          : await ctx.meta.listArtifacts({ orgId: t.org, ids, viewerId: actingFor?.id ?? agent.id })
      // Skill-ness isn't a store-level filter (it's the denormalized content type).
      const rows = skills ? arts.filter((a) => a.current_content_type === SKILL_CONTENT_TYPE) : arts
      const tagMap = await ctx.meta.tagsForArtifacts(rows.map((a) => a.id))
      const artifactRows = rows.map((a) => ({
        type: "artifact" as const,
        ...summarizeArtifact(a),
        tags: tagMap[a.id] ?? [],
      }))
      const contextRows = await contextFindRows(t.org)
      return json({
        workspace: t.org,
        count: artifactRows.length + contextRows.length,
        results: [...artifactRows, ...contextRows],
        ...(actingFor ? {} : { contexts_note: CONTEXTS_NEED_HUMAN }),
      })
    },
  )

  // READ CONTENT --------------------------------------------------------------
  server.registerTool(
    "read",
    {
      description:
        "Read an artifact's CONTENT by short_id. A small doc returns whole; a LARGE doc returns its heading OUTLINE first — call again with a `section` slug (or a `lines` range) for just that part. Markdown by default; a styled HTML page is FLATTENED to text here, so pass render:'top' or 'full' to SEE it as a viewer does (do this after publishing a designed page to catch visual breakage). Bundle: omit `section` for the page list, then pass a page path (optionally `page.html#slug`). Pass format:'html' for the exact source (required BEFORE publish `edits`), or a past `version` for history. For what CHANGED or the comment threads, use catch_up instead.",
      inputSchema: {
        short_id: z
          .string()
          .describe(
            "The artifact's short id, e.g. nk0dsral. Also accepts a Brandprint URI — derive://brandprint/reference or /template (the static build guide), /profile (this workspace's live brand profile), or /<short_id> (a source doc) — or a CORE SKILL URI (derive://skills/loop, /publishing, /assets, /contexts, /checkpoint, /organize), so the strings the instructions name are readable here even where MCP resources aren't.",
          ),
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
        wait: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe(
            "With `render`: when the screenshot isn't computed yet (a publish is seconds old), block up to this many seconds (max 30) for it to land instead of returning the not-ready message. Returns at once when it's already ready or has failed.",
          ),
        version: z.number().optional().describe("Defaults to the current version."),
        workspace: wsArg,
      },
    },
    async ({ short_id, section, format, version, lines, render, wait, workspace }) => {
      const fmt: ReadFormat = format ?? "markdown"
      // `derive://brandprint/*` URIs are readable through `read`, not only as MCP
      // resources — the exact strings the server instructions name, reachable by every
      // client even where resource support is weak or was never negotiated (the failure
      // this fixes: a session that connected before the Brandprint existed caches "no
      // resources" for its whole life). `reference`/`template` are the static build guide;
      // `profile` is the live brand profile; any other segment is a source-doc short_id
      // that falls through to the normal read path (so `section`/`lines`/`version` work).
      // `derive://skills/<name>` resolves the same way, so the core-skill strings the
      // instructions index names are readable through `read` even where MCP resources
      // aren't — same response shape as the Brandprint reference below.
      const SK = "derive://skills/"
      if (short_id.startsWith(SK)) {
        const name = short_id.slice(SK.length)
        const skill = CORE_SKILLS.find((s) => s.name === name)
        if (!skill)
          return err(
            `No core skill "${name}". Available: ${CORE_SKILLS.map((s) => s.name).join(", ")}.`,
          )
        return json({ uri: short_id, mimeType: "text/markdown", content: skill.body })
      }
      const BP = "derive://brandprint/"
      let docId = short_id
      if (short_id.startsWith(BP)) {
        const seg = short_id.slice(BP.length)
        if (seg === "reference")
          return json({ uri: short_id, mimeType: "text/markdown", content: BRANDPRINT_REFERENCE })
        if (seg === "template")
          return json({ uri: short_id, mimeType: "text/html", content: BRANDPRINT_TEMPLATE })
        if (seg === "profile") {
          if (!(bpProfile?.state === "live" && profileArt))
            return err(
              "This workspace has no live brand profile yet. Read derive://brandprint/reference and derive://brandprint/template, build the profile, then publish it to derive://brandprint/profile (an Admin's first publish there scaffolds the slot; it lands as a proposal a human approves).",
            )
          const pv = await ctx.meta.getVersion(profileArt.id, profileArt.current_version)
          const body = pv ? await ctx.sourceText(pv) : null
          return json({
            uri: short_id,
            mimeType: "text/html",
            version: profileArt.current_version,
            content: body ?? "",
          })
        }
        docId = seg
      }
      const r = await reach(docId, workspace)
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(docId)
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
        const pick = (ver: VersionRecord) =>
          render === "top"
            ? { key: ver.preview_key, status: ver.preview_status, error: ver.preview_error }
            : render === "full"
              ? {
                  key: ver.preview_full_key,
                  status: ver.preview_full_status,
                  error: ver.preview_full_error,
                }
              : {
                  key: ver.preview_marked_key,
                  status: ver.preview_marked_status,
                  error: ver.preview_marked_error,
                }
        const label =
          render === "top"
            ? "the top of the page, 1200x630"
            : render === "full"
              ? "the whole page"
              : "the whole page, with the region map's @N refs drawn on it"
        let variant = pick(v)
        // Long-poll: the screenshot lands a few seconds after a publish. When it's neither
        // ready nor failed and the caller passed `wait`, block up to that many seconds
        // (max 30), re-reading the version, before returning the not-ready message — a
        // bounded retry loop so the agent gets the render in one call after a fresh push.
        if (wait && !(variant.status === "ready" && variant.key) && variant.status !== "failed") {
          const deadline = Date.now() + Math.min(Math.max(wait, 0), 30) * 1000
          while (
            Date.now() < deadline &&
            !(variant.status === "ready" && variant.key) &&
            variant.status !== "failed"
          ) {
            await sleep(Math.min(1500, Math.max(0, deadline - Date.now())))
            const refreshed = await ctx.meta.getVersion(a.id, n)
            if (refreshed) variant = pick(refreshed)
          }
        }
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
          `The render:${render} of "${short_id}" v${n} isn't ready yet — screenshots are computed a few seconds after publish. Try again shortly, or pass \`wait\` (seconds, max 30) to block for it.`,
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

  // (GREP + workspace SEARCH now live in `find` — same engine, discriminated by short_id.)

  // ORGANIZE — ONE tool for the library's findability metadata: tags + collections,
  // read + write. No short_ids ⇒ the workspace overview (vocabulary + collections).
  // short_ids alone ⇒ inspect them (current tags/collections + tag suggestions). Any of
  // add/remove/set/collection ⇒ write. Replaces the old list_tags/suggest_tags/tag/
  // list_collections/collect point-tools.
  server.registerTool(
    "organize",
    {
      description:
        "Tags and collections in one tool — the library's findability layer. READ (no `short_ids`) returns the workspace's tag vocabulary + collections; READ with `short_ids` returns their tags/collections plus suggested tags. WRITE (`add`/`remove`/`set` tags, and/or `collection`) changes them — each artifact is authorized on its own, so ones you can't touch come back skipped, never failing the batch. Tag freely and reuse the vocabulary; a collection is for when a set is a real unit. For the read-vs-write modes and the tags-vs-collections call, read derive://skills/organize.",
      inputSchema: {
        short_ids: z
          .array(z.string())
          .optional()
          .describe("Artifacts to inspect or organize. Omit for the workspace overview."),
        add: z.array(z.string()).optional().describe("Tags to add (union; never drops existing)."),
        remove: z.array(z.string()).optional().describe("Tags to remove."),
        set: z
          .array(z.string())
          .optional()
          .describe("Replace the whole tag set (overrides add/remove)."),
        collection: z
          .string()
          .optional()
          .describe("Fold `short_ids` into this collection — an id, or a name (created if new)."),
        workspace: wsArg,
      },
    },
    async ({ short_ids, add, remove, set, collection, workspace }) => {
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      const actorId = actingFor?.id ?? agent.id
      const sortVocab = (v: { tag: string; count: number }[]) =>
        v.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))

      // ---- WRITE: add/remove/set tags and/or fold into a collection ----
      if (add || remove || set || collection) {
        if (!short_ids?.length)
          return err("Pass `short_ids` to organize (with add/remove/set and/or collection).")
        const out: Record<string, unknown> = {}
        if (add || remove || set) {
          const removeSet = new Set(normalizeTags(remove ?? []))
          let updated = 0
          let skipped = 0
          const results: { short_id: string; tags: string[] }[] = []
          for (const shortId of [...new Set(short_ids)]) {
            const reached = await reach(shortId, workspace)
            // Not found or not editable → skipped, never fails the batch.
            if (!reached || "error" in reached || !roleAllows(reached.role, "publish")) {
              skipped++
              continue
            }
            const next = set
              ? normalizeTags(set)
              : normalizeTags([
                  ...((await ctx.meta.tagsForArtifacts([reached.a.id]))[reached.a.id] ?? []),
                  ...(add ?? []),
                ]).filter((x) => !removeSet.has(x))
            await ctx.meta.setArtifactTags(reached.a.id, next)
            updated++
            results.push({ short_id: shortId, tags: next })
          }
          out.tagged = { updated, skipped, results }
        }
        if (collection) {
          // Resolve the target collection: an id, else a name (matched team-visible, else
          // created). Then the caller must be able to MANAGE it (mirrors the HTTP route).
          const ref = collection.trim()
          if (!ref) return err("Pass a non-empty collection name or id.")
          let col = await ctx.meta.getCollection(ref)
          if (col && col.org_id !== t.org) return err("That collection is in another workspace.")
          if (!col) {
            const existing = (
              await Promise.all(
                (
                  await ctx.meta.listCollections(t.org)
                ).map(async (x) => ({
                  x,
                  visible:
                    x.workspace_access === "member" ||
                    x.created_by === actorId ||
                    !!(await ctx.meta.getCollectionMember(x.id, actorId)),
                })),
              )
            ).find(({ x, visible }) => x.title.toLowerCase() === ref.toLowerCase() && visible)?.x
            if (existing) col = existing
            else {
              col = await ctx.meta.createCollection({
                id: newId("col"),
                org_id: t.org,
                title: ref.slice(0, 120),
                created_by: actorId,
                workspace_access: "member",
              })
              await ctx.meta.setCollectionMember({
                id: newId("cm"),
                collection_id: col.id,
                user_id: actorId,
                role: "owner",
              })
            }
          }
          const canManage =
            col.workspace_access === "member"
              ? roleAllows(t.role, "publish")
              : roleAllows(
                  (await ctx.meta.getCollectionMember(col.id, actorId))?.role ?? "viewer",
                  "publish",
                )
          if (!canManage) return err("You can't add to that collection.")
          let added = 0
          let skipped = 0
          for (const shortId of [...new Set(short_ids)]) {
            const reached = await reach(shortId, workspace)
            // Adding to a shared collection re-shares the artifact → needs share standing.
            // `reach` may roam across the grant when `workspace` is omitted, but a collection
            // can contain only artifacts from its own workspace (the HTTP bulk route has the
            // same guard). Without this check, a default-workspace collection could reference
            // an artifact from another workspace the grant can reach.
            if (
              !reached ||
              "error" in reached ||
              reached.org !== t.org ||
              !roleAllows(reached.role, "share")
            ) {
              skipped++
              continue
            }
            await ctx.meta.addCollectionItem(col.id, reached.a.id)
            added++
          }
          out.collected = { collection: { id: col.id, title: col.title }, added, skipped }
        }
        return json(out)
      }

      // ---- READ: inspect specific artifacts (current tags + collections + suggestions) --
      if (short_ids?.length) {
        const artifacts: {
          short_id: string
          tags?: string[]
          collections?: string[]
          error?: string
        }[] = []
        let firstReached: ArtifactRecord | null = null
        for (const shortId of short_ids) {
          const reached = await reach(shortId, workspace)
          if (!reached || "error" in reached) {
            artifacts.push({ short_id: shortId, error: "not reachable" })
            continue
          }
          if (!firstReached) firstReached = reached.a
          const [tagMap, colIds] = await Promise.all([
            ctx.meta.tagsForArtifacts([reached.a.id]),
            ctx.meta.collectionIdsForArtifact(reached.a.id),
          ])
          artifacts.push({
            short_id: shortId,
            tags: tagMap[reached.a.id] ?? [],
            collections: colIds,
          })
        }
        // Suggestions only for a SINGLE artifact — aggregating across many is ambiguous.
        const suggested =
          short_ids.length === 1 && firstReached
            ? (
                await computeTagSuggestions(
                  { meta: ctx.meta, search: ctx.search, sourceText: ctx.sourceText },
                  firstReached,
                  actorId,
                )
              ).suggested
            : undefined
        return json({
          artifacts,
          ...(suggested ? { suggested } : {}),
          vocabulary: sortVocab(await ctx.meta.tagCounts(t.org)).slice(0, 50),
        })
      }

      // ---- READ: workspace overview (vocabulary + collections) ----
      const [tags, cols] = await Promise.all([
        ctx.meta.tagCounts(t.org),
        ctx.meta.listCollections(t.org),
      ])
      const visibleCols = await Promise.all(
        cols.map(async (col) => ({
          col,
          visible:
            col.workspace_access === "member" ||
            col.created_by === actorId ||
            !!(await ctx.meta.getCollectionMember(col.id, actorId)),
        })),
      )
      return json({
        workspace: t.org,
        vocabulary: sortVocab(tags),
        collections: visibleCols
          .filter(({ visible }) => visible)
          .map(({ col }) => ({ id: col.id, title: col.title, count: col.count })),
      })
    },
  )

  // CATCH UP — state, feedback, history, and diffs all in one ------------------
  server.registerTool(
    "catch_up",
    {
      description:
        "With a `short_id`: START HERE on an artifact — its state in one call: a one-line summary, the versions that landed since `since_version`, which pages changed, the open (and outdated) comment threads, the review round you're waiting on, and the full version history. Pass `comments` (open/addressed/resolved/outdated) for that filtered thread list instead — your feedback to-do queue. Pass `response_format='detailed'` (optionally with `since_version`/`to_version`) for a line-by-line diff of the two versions' readable Markdown form. WITHOUT a short_id: your WORK QUEUE — pending requests teammates handed you by @mentioning you in a comment (the ask-agent and Rework buttons); pass `ack:[id,…]` to clear the ones you finished. WAITING ON SOMETHING? Pass `wait` (seconds, max 50) to block until the human acts (or, in queue mode, until new work lands), then return the fresh state — chain waits instead of sleeping between polls. For the diff, review states, working a request, and the wait loop, read derive://skills/loop.",
      inputSchema: {
        short_id: z
          .string()
          .optional()
          .describe("The artifact to catch up on. Omit it to pull your work queue instead."),
        ack: z
          .array(z.string())
          .optional()
          .describe(
            "Work-queue mode (no short_id): request ids you have HANDLED — acknowledges them off the queue. Ack after the work lands (a publish or a reply), not on read; an unknown or already-acked id is skipped, never an error.",
          ),
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
    async ({
      short_id,
      ack,
      since_version,
      to_version,
      comments,
      response_format,
      wait,
      workspace,
    }) => {
      // No short_id ⇒ the WORK QUEUE mode (absorbs the former check_requests): the
      // @mention inbox, its ack, and its own request.created long-poll.
      if (!short_id) return workQueue(ack, wait)
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
        "Leave feedback on an artifact, reply in a thread, react, and/or resolve or reopen a thread — all in one tool. Anchor a NEW comment to a quoted span of the rendered text with `quote`; reply by passing the thread id as `reply_to`; `react` (with `reply_to`) is the lightweight ack. Pass `set_state` (with the thread's id in `reply_to`) to RESOLVE that thread, or reopen it. Thread ids come from catch_up. For quoting, the ack, and review-round etiquette, read derive://skills/loop.",
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

  // STAGE — one tool, two out-of-band upload URLs, each spent with curl so bytes never
  // enter the model's context. target:'asset' = the former stage_asset (a binary a doc
  // embeds); target:'doc' = the former stage_publish (a whole big document/bundle). The
  // blessed paths are POST /v1/assets and POST /v1/artifacts, but a hosted-OAuth
  // connection's credential lives inside this transport — the shell has no bearer to curl
  // with — so these mint short-lived signed URLs that need none. The doc path is scoped
  // tighter because publishing writes artifacts (see lib/publish-token.ts).
  server.registerTool(
    "stage",
    {
      description:
        "Upload out-of-band — mint a SHORT-LIVED, no-bearer upload URL, then curl the file's bytes to it from your shell (zero tokens through context). target:'doc' for a whole big document or bundle more than ~a page (returns a publish URL — curl the file, or a zipped dir which becomes a bundle; omit short_id to CREATE, pass it to REVISE that exact target; read derive://skills/publishing). target:'asset' for an image or font a document EMBEDS (returns a permanent url for single-file content + an asset:<hash> ref for a bundle `files` map; raster images and WOFF/WOFF2 only, max 25MB; read derive://skills/assets). Staging alone does not publish an artifact. NEVER base64 a binary through a tool call — a pasted image is already a file on disk.",
      inputSchema: {
        target: z
          .enum(["doc", "asset"])
          .describe(
            "doc: a whole document/bundle too big to inline (returns a publish URL). asset: an image or font a doc embeds (returns a permanent asset url + ref).",
          ),
        short_id: z
          .string()
          .optional()
          .describe(
            "target:'doc' ONLY — revise THIS artifact; omit to create a new one (the token is scoped to it). Rejected with target:'asset' (an asset isn't versioned).",
          ),
        workspace: wsArg,
      },
    },
    async ({ target, short_id, workspace }) => {
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)

      if (target === "asset") {
        // A binary an embedding doc references — the former stage_asset path, verbatim.
        if (short_id)
          return err("`short_id` applies only to target:'doc'. An asset isn't versioned — omit it.")
        // Same bar as POST /v1/assets itself: staging is a publish-side capability.
        if (!roleAllows(t.role, "publish"))
          return err("Your role in this workspace can't stage assets (publishing required).")
        const secret = ctx.deps.encryptionKey
        if (!secret)
          return err(
            "This server has no signing secret configured, so it can't mint upload URLs. POST the bytes to /v1/assets with a bearer token instead (DERIVE_TOKEN, or `derive login`).",
          )
        // Bind the token to the granting user so the spend side can re-check live
        // membership — revoking or demoting them kills outstanding URLs mid-TTL.
        // An ownerless legacy agent has no user to bind; it mints an unbound token.
        const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_MS
        const tok = await signUploadToken(secret, t.org, ownerId ?? "", expiresAt)
        const uploadUrl = `${ctx.deps.baseUrl.replace(/\/$/, "")}/v1/assets/t/${tok}`
        return json({
          target: "asset",
          upload_url: uploadUrl,
          workspace: t.org,
          expires_in_minutes: Math.round(UPLOAD_TOKEN_TTL_MS / 60_000),
          max_bytes: MAX_ASSET_BYTES,
          accepts: [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "font/woff",
            "font/woff2",
          ],
          how: `curl -sS -X POST --data-binary @<file> "${uploadUrl}" → {url, ref, ...}. Paste \`url\` into content, or use \`ref\` ("asset:<hash>") as a bundle files value. Repeat for each file until expiry.`,
        })
      }

      // target === "doc" — a whole document/bundle, the former stage_publish path, verbatim.
      // A publish is attributed to a person and its URL is re-checked against their live
      // rights — so it needs a known granting user. A static agent token (dk_agt_/
      // DERIVE_TOKEN) has none, but it also isn't trapped in this transport: it can POST
      // to /v1/artifacts with that bearer directly.
      if (!ownerId)
        return err(
          "stage target:'doc' needs a signed-in user to attribute the publish to. With a static agent token, POST to /v1/artifacts with that token in the Authorization header instead.",
        )
      const secret = ctx.deps.encryptionKey
      if (!secret)
        return err(
          "This server has no signing secret configured, so it can't mint publish URLs. POST to /v1/artifacts with a bearer token instead (DERIVE_TOKEN, or `derive login`).",
        )
      // The workspace the token is minted for. For a REVISE it must be the artifact's
      // ACTUAL workspace — reach() may auto-roam a bare short_id to another workspace in
      // the grant, and the spend-side org guard would 403 a token minted against default.
      let org = t.org
      if (short_id) {
        const reached = await reach(short_id, workspace)
        if (reached && "error" in reached) return err(reached.error)
        if (!reached) return notFound(short_id)
        org = reached.org
        // Revising needs artifact-level publish STANDING (share + seat), the same right
        // the spend-side re-checks — not the workspace seat role, which on a private
        // artifact grants nothing. Fail at mint for a clear message.
        if (!(await ctx.authorizeUserStanding(ownerId, "publish", reached.a)))
          return err("You don't have permission to publish a new version of that artifact.")
      } else if (!roleAllows(t.role, "publish")) {
        // Creating is a workspace-level right.
        return err("Your role in this workspace can't publish (publishing required).")
      }
      const expiresAt = Date.now() + PUBLISH_TOKEN_TTL_MS
      const targetName = short_id ?? PUBLISH_TARGET_CREATE
      const tok = await signPublishToken(secret, org, ownerId, targetName, expiresAt)
      const base = ctx.deps.baseUrl.replace(/\/$/, "")
      const uploadUrl = short_id
        ? `${base}/v1/artifacts/${short_id}/versions/t/${tok}`
        : `${base}/v1/artifacts/t/${tok}`
      return json({
        target: "doc",
        upload_url: uploadUrl,
        workspace: org,
        mode: short_id ? `revise ${short_id}` : "create",
        expires_in_minutes: Math.round(PUBLISH_TOKEN_TTL_MS / 60_000),
        max_bytes: MAX_UPLOAD_BYTES,
        how: `Single file: curl -sS -F file=@<path> ${short_id ? "" : "-F title='<title>' "}"${uploadUrl}". Bundle: zip the dir (zip -r /tmp/b.zip .) then curl -sS -F file=@/tmp/b.zip "${uploadUrl}" — a .zip becomes a multi-page bundle. Returns the artifact {short_id, url, ...}.`,
      })
    },
  )

  // Resolve derive://brandprint/profile to the workspace's brand-profile artifact,
  // scaffolding it (conventions collection + "Brand profile" placeholder + settings
  // pointer) on first use. This is the former setup_brandprint, folded in so the brand
  // profile is a publish TARGET rather than a separate tool. INVARIANT (critical safety):
  // the scaffold's WRITES fire ONLY when the caller holds `manage` (Owner/Admin); a
  // non-manage caller for whom nothing is set up yet gets an actionable error naming an
  // Admin, and NO write happens. Reusing an already-set-up profile needs no manage (a
  // normal for_review revision). Body copied verbatim from setup_brandprint.
  const resolveBrandprintProfileTarget = async (
    targetOrg: string,
    role: Role,
    uid: string,
  ): Promise<{ profileShortId: string } | { error: string }> => {
    const settings = await ctx.meta.getOrgSettings(targetOrg)
    const bp = settings.brandprint
    // Reuse an in-tenant profile pointer if one exists — no scaffold, so no manage gate.
    let profileShortId = bp?.profileId
    if (profileShortId) {
      const art = await ctx.meta.getByShortId(profileShortId)
      if (!(art && art.org_id === targetOrg)) profileShortId = undefined
    }
    if (profileShortId) return { profileShortId }

    // Nothing set up yet ⇒ SCAFFOLD, which writes. Owner/Admin only — the gate is BEFORE
    // any create/publish, so a non-manage caller leaves the workspace untouched.
    if (!roleAllows(role, "manage"))
      return {
        error:
          "This workspace has no Brandprint profile yet, and only an Admin/Owner can set one up. Ask an Admin to publish to derive://brandprint/profile once (that scaffolds it); after that anyone with publish rights can propose revisions.",
      }
    // Reuse an in-tenant collection pointer; otherwise create the conventions collection
    // (workspace-open so teammates read the docs + the reveal).
    let collectionId = bp?.collectionId
    if (collectionId) {
      const col = await ctx.meta.getCollection(collectionId)
      if (!col || col.org_id !== targetOrg) collectionId = undefined
    }
    if (!collectionId) {
      const col = await ctx.meta.createCollection({
        id: newId("col"),
        org_id: targetOrg,
        title: "Brandprint",
        created_by: uid,
        workspace_access: "member",
      })
      await ctx.meta.setCollectionMember({
        id: newId("cm"),
        collection_id: col.id,
        user_id: uid,
        role: "owner",
      })
      collectionId = col.id
    }
    // Publish the placeholder (v1 stub) into the collection. Deliberately UNstamped: this
    // auto-scaffolded placeholder is not the user's "first agent publish" — stamping 'mcp'
    // here would flip the onboarding signal (and welcome celebration) on an empty stub.
    const { artifact } = await publishVersion(ctx.meta, ctx.blobs, {
      bytes: new TextEncoder().encode(PROFILE_PLACEHOLDER_HTML),
      filename: "Brand profile.html",
      isBundle: false,
      title: "Brand profile",
      message: "Brand profile placeholder — your agent fills this in.",
      author: agent.name,
      authorId: uid,
      orgId: targetOrg,
      workspaceAccess: "member",
      linkRole: "none",
      listed: "none",
    })
    await ctx.meta.addCollectionItem(collectionId, artifact.id)
    await ctx.meta.setOrgSettings(targetOrg, {
      ...settings,
      brandprint: { collectionId, profileId: artifact.short_id },
    })
    return { profileShortId: artifact.short_id }
  }

  // WRITE — publish live, or file a proposal for review -----------------------
  server.registerTool(
    "publish",
    {
      description:
        "Publish a document: pass `short_id` to UPDATE an existing one, omit it to CREATE a new one (`title` required). Choose ONE payload by what you're changing. DEFAULT to `edits` for any change to an existing doc — it is the safe, precise option: exact find/replace against the stored source, so read format:'html' FIRST or it won't match, and it fails unless each search string hits exactly once (add surrounding text to make it unique). Use `content` to write or fully replace a single file, or `files` for a multi-page bundle. Do NOT inline anything past ~a page or any image/font — use stage (target:'doc' for a whole big doc/bundle, target:'asset' for an image/font) instead; oversized inline payloads are rejected. Publishes go LIVE at your role; pass for_review:true to file a PROPOSAL a human approves instead (nothing changes until they do). Pass `addresses` (thread ids from catch_up) to resolve the feedback this revision answers. As a short_id you may pass derive://brandprint/profile to file this workspace's brand profile (an Admin's first publish there scaffolds the slot). Read derive://skills/publishing before bundles or edits, and derive://skills/assets before embedding images or fonts.",
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe(
            "The complete content for a SINGLE-FILE artifact (HTML or Markdown). Use this OR `files`, not both. Stage images and fonts, then embed the upload response's permanent url (never upload_url or a base64 data: URI here) — see derive://skills/assets. Push a large document via stage target:'doc' rather than inlining it — see derive://skills/publishing.",
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "A MULTI-PAGE bundle as a map of path → content — the whole site. Each value is a text page (plain string), a base64 data: URI for a small inline binary, or — PREFERRED for real images/fonts — the exact \"asset:<hash>\" ref returned after uploading through stage target:'asset'. The root index.html (else the shallowest .html) becomes the entry page; a plain republish REPLACES the bundle, so include every page and asset (or use `merge`). See derive://skills/assets for staged refs and derive://skills/publishing for bundle semantics.",
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
            "Add/overwrite the given `files` INTO the existing bundle instead of replacing it (default false). Requires `short_id` of a bundle; same-path files overwrite, the rest are kept. See derive://skills/publishing.",
          ),
        message: z.string().optional().describe("What changed — recorded as the version message."),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Browse tags to set on the artifact — workspace-wide labels that make it findable (organize shows the vocabulary and proposes tags from similar docs). Reuse an existing tag over a near-duplicate. Given ⇒ REPLACES the set (normalized: trimmed, lowercased, deduped, capped 20); [] clears; omitted leaves existing tags untouched on a republish.",
          ),
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
            "Surgical revision of a SINGLE-FILE artifact without resending it: exact-match search/replace against the current stored source, applied in order (each edit sees the previous one's result). Requires `short_id`; use INSTEAD of `content`, and read format:'html' first so old_str matches the raw source. See derive://skills/publishing. A miss applies nothing and returns why.",
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
      tags,
      filename,
      for_review,
      addresses,
      request_review,
      workspace,
      edits,
      base_version,
    }) => {
      let content = contentIn
      const BP = "derive://brandprint/"
      // The brand profile is never published LIVE — its reveal/revision is always a
      // human-approved proposal. Also its exemption from the total-inline cap below (it has
      // no out-of-band path to its URI). Computed from the RAW target, before resolution.
      const isProfileTarget = short_id === `${BP}profile`

      // GUARDRAILS — reject inline payloads that belong out-of-band, BEFORE any write or
      // scaffold, naming the `stage` mode to use. (a) A single base64 data: URI past ~32KB
      // is a binary pasted through the call — stage it as an asset. (b) Total inline
      // content/files past ~64KB is a whole big document — curl it via stage target:'doc'.
      // `edits` publishes carry neither content nor files, so they never trip these; the
      // brand profile is exempt from the total-size cap but still may not smuggle an
      // oversized binary inline.
      const inlineStrings: string[] = []
      if (typeof contentIn === "string") inlineStrings.push(contentIn)
      if (files) inlineStrings.push(...Object.values(files))
      if (inlineStrings.length) {
        const biggestDataUri = Math.max(0, ...inlineStrings.map(largestInlineDataUriBytes))
        if (biggestDataUri > MAX_INLINE_DATA_URI_BYTES)
          return err(
            `An inline base64 data: URI is ~${Math.round(biggestDataUri / 1024)}KB — too big to carry through a tool call. Upload the binary with stage target:'asset' and reference the returned url/ref instead (a pasted image is already a file on disk).`,
          )
        const totalBytes = inlineStrings.reduce((n, s) => n + new TextEncoder().encode(s).length, 0)
        if (!isProfileTarget && totalBytes > MAX_INLINE_CONTENT_BYTES)
          return err(
            `This inline payload is ~${Math.round(totalBytes / 1024)}KB — past the ~${Math.round(
              MAX_INLINE_CONTENT_BYTES / 1024,
            )}KB inline ceiling. Push the whole document/bundle with stage target:'doc' (curl the file, or a zipped dir for a bundle) instead of inlining it.`,
          )
      }

      // Resolve a derive:// target — publish accepts the same URI strings `read` does. The
      // only WRITEABLE one is the brand profile; the static build guide and core skills are
      // read-only, and any other derive:// string is rejected rather than silently treated
      // as a short_id. The profile's reveal is always a proposal (profileForReview).
      let profileForReview = false
      if (short_id?.startsWith("derive://")) {
        if (isProfileTarget) {
          const t = await resolveWs(workspace)
          if ("error" in t) return text(t.error)
          const uid = actingFor?.id ?? ownerId
          if (!uid)
            return err(
              "Publishing the brand profile needs a signed-in user to attribute it to. Connect with an OAuth agent grant rather than a static agent token.",
            )
          const resolved = await resolveBrandprintProfileTarget(t.org, t.role, uid)
          if ("error" in resolved) return err(resolved.error)
          short_id = resolved.profileShortId
          profileForReview = true
        } else if (short_id.startsWith(BP)) {
          const seg = short_id.slice(BP.length)
          if (seg === "reference" || seg === "template")
            return err(
              `${short_id} is a read-only build guide — you can't publish to it. Build the profile and publish it to derive://brandprint/profile instead.`,
            )
          // derive://brandprint/<short_id> — a source doc; strip to the bare short_id.
          short_id = seg
        } else if (short_id.startsWith("derive://skills/")) {
          return err("Core skills are read-only — you can't publish to a derive://skills/ URI.")
        } else {
          return err(
            `Can't publish to "${short_id}" — the only writeable derive:// target is derive://brandprint/profile.`,
          )
        }
      }
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
      // grant — or anyone asking for_review, or a publish to the brand profile (whose
      // reveal is always human-approved) — is routed to a human-reviewed proposal, so a
      // low-privilege agent still can't push live content.
      const review = for_review === true || profileForReview || !roleAllows(actRole, "publish")
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
            source: "mcp",
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
            // Thread the dense arm too — agents publish primarily through this tool, so omitting
            // `search` here would leave the bulk of new content lexically-indexed but never embedded.
            search: ctx.search,
          },
          artifact,
          version,
          { isNew: !short_id, onBehalf: actingFor?.id ?? null, resolves: addresses ?? [] },
        )
        // Tag at publish time — the one-step "auto-tag on create". `tags` given ⇒ set them
        // (normalized, deduped, capped); an empty array clears; omitted leaves them be, so
        // a republish that doesn't mention tags keeps the artifact's existing set.
        if (tags !== undefined) await ctx.meta.setArtifactTags(artifact.id, normalizeTags(tags))
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

  // CHECKPOINT -----------------------------------------------------------------
  // Commit a one-page LAYER of working state to a lineage artifact, so a later
  // session — anyone's, on any machine — continues the work cold. Deliberately a
  // thin composition over the same live-publish path as `publish`: each checkpoint
  // REPLACES the page (artifact versions are the layer history, pinned by name),
  // and the content itself carries the paste-able resume command, so it travels
  // everywhere the artifact does (page, read tool, Slack unfurl) with no bespoke
  // UI. The first version can name its own id because create pre-mints it.
  const LINEAGE_MARKER = "<!-- derive:lineage -->"
  const MAX_LAYER_CHARS = 8000
  // Agent-supplied text must not counterfeit the template's own affordances:
  // collapse code-fence runs (a smuggled fenced block renders with the copy
  // affordance humans are trained to paste from the real resume block) and
  // escape heading lines (a forged "## Continue from here" section). The write
  // capability isn't new — `publish` accepts arbitrary content — but this
  // template frames its page as tool-authored, so the body can't fake the frame.
  const cleanField = (s: string): string =>
    s
      .replace(/[`~]{3,}/g, "``")
      .split("\n")
      .map((l) => l.replace(/^(\s*)(#{1,6}\s)/, "$1\\$2"))
      .join("\n")
  const layerSection = (heading: string, items?: string[]): string => {
    const kept = (items ?? []).map((i) => cleanField(i.trim())).filter(Boolean)
    return kept.length ? `\n## ${heading}\n\n${kept.map((i) => `- ${i}`).join("\n")}\n` : ""
  }
  server.registerTool(
    "checkpoint",
    {
      description:
        "Commit a compact LAYER of working state to this work's lineage — a one-page, human-readable checkpoint (state / decisions / open threads / next steps / refs) that lets ANY later session continue the work cold, on any machine. Call it at task boundaries: a task just completed, before a risky step, when wrapping up a session. FIRST call for a piece of work: pass `work` (a short name); the result names a short_id — record it (e.g. in a .derive/lineage file) and pass it as `short_id` on every checkpoint after. Each checkpoint REPLACES the page (versions keep the history), so restate what still matters and prefer refs over restated detail — the tool rejects more than a page. See derive://skills/checkpoint.",
      inputSchema: {
        work: z
          .string()
          .optional()
          .describe(
            "Short name for the work (becomes the lineage's title), e.g. the feature or branch name. Required on the FIRST checkpoint; ignored after.",
          ),
        short_id: z
          .string()
          .optional()
          .describe("The lineage to update — the short_id a previous checkpoint returned."),
        state: z
          .string()
          .describe("Where the work stands right now, a few plain sentences — the cold open."),
        decisions: z
          .array(z.string())
          .optional()
          .describe("Decisions currently in force, each with its why — including rejected paths."),
        open: z
          .array(z.string())
          .optional()
          .describe("Unresolved questions or threads a continuing session must not drop."),
        next: z.array(z.string()).optional().describe("Concrete next steps, most immediate first."),
        refs: z
          .array(z.string())
          .optional()
          .describe(
            "Pointers a continuing session should follow — artifact short_ids, PR/issue URLs, key file paths.",
          ),
        workspace: wsArg,
      },
    },
    async ({ work, short_id, state, decisions, open, next, refs, workspace }) => {
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
      // Live-only, by design: a checkpoint queue awaiting human approval defeats
      // the point (the layer must be current when the next session pulls it).
      if (!roleAllows(actRole, "publish"))
        return text(
          "Checkpointing needs publish rights (a Creator/Admin grant). Re-authorize with a publish scope.",
        )
      if (!existing && !work?.trim())
        return text(
          "First checkpoint of a piece of work — pass `work` (a short name). The result returns the lineage's short_id to pass on every checkpoint after.",
        )
      if (existing) {
        if (existing.kind !== "file")
          return text(`"${short_id}" is a bundle — a lineage is a single-page document.`)
        // A checkpoint REPLACES the whole page, so it only ever writes pages the
        // tool itself authored — never a doc someone reached with a mistyped id.
        const v = await ctx.meta.getVersion(existing.id, existing.current_version)
        const src = v ? await ctx.sourceText(v) : null
        if (!src?.startsWith(LINEAGE_MARKER))
          return text(
            `"${short_id}" doesn't start with the lineage marker (not a page this tool maintains, or its content is unreadable) — refusing to replace it. Omit short_id to start a new lineage.`,
          )
      }
      const shortId = existing ? existing.short_id : newShortId()
      const title = existing ? (existing.title ?? "Untitled work") : (work as string).trim()
      // No layer number in the body or the pinned name: the artifact's version IS
      // the layer number, and only the store knows it race-free — two concurrent
      // checkpoints would both compute current_version+1 and one would mislabel.
      // Concurrent layers are last-writer-wins on the page; both survive as versions.
      const stamp = new Date().toISOString()
      const content = `${LINEAGE_MARKER}\n\n# ${title}\n\n_Checkpointed ${stamp} by ${agent.name}_\n\n## State\n\n${cleanField(state.trim())}\n${layerSection("Decisions", decisions)}${layerSection("Open", open)}${layerSection("Next", next)}${layerSection("Refs", refs)}\n## Continue from here\n\nPaste in a terminal on any machine with the Derive MCP connected:\n\n\`\`\`\nclaude "Read Derive artifact ${shortId} with the read tool, continue the work it describes, and checkpoint back to ${shortId} at each task boundary."\n\`\`\`\n`
      if (content.length > MAX_LAYER_CHARS)
        return text(
          `A layer is one page — ${MAX_LAYER_CHARS} chars max, this is ${content.length}. Trim to what a cold session needs; replace detail with refs.`,
        )
      const bytes = new TextEncoder().encode(content)
      // Same workspace storage cap the HTTP routes and the publish `edits` path
      // enforce — checkpoint fires repeatedly by design, so it's the MCP path
      // most likely to accrete blobs past an exceeded quota.
      if (await ctx.overStorage(targetOrg, bytes.length))
        return text("The workspace's storage quota is exceeded — checkpoint not saved.")
      try {
        const settings = existing ? null : await ctx.meta.getOrgSettings(targetOrg)
        const { artifact, version } = await publishVersion(
          ctx.meta,
          ctx.blobs,
          {
            bytes,
            filename: "lineage.md",
            isBundle: false,
            title: existing ? undefined : title,
            message: state.trim().slice(0, 80),
            author: agent.name,
            authorId: actingFor?.id ?? null,
            source: "mcp",
            name: `layer ${stamp.slice(0, 16)}Z`,
            orgId: targetOrg,
            workspaceAccess: settings?.defaultWorkspaceAccess,
            linkRole: settings?.defaultLinkRole,
            // Never auto-list working state: a lineage carries decisions, open
            // threads, and file paths. Teammates reach it via workspace access /
            // the pasted link; it must not surface in the library or public
            // directory by org default — a human promotes it deliberately.
            // (Also moots publish's two listed-invariant checks: nothing listed.)
            listed: "none",
            mintShortId: existing ? undefined : shortId,
          },
          existing ? shortId : undefined,
        )
        if (!existing)
          await ctx.meta.setArtifactMember({
            id: newId("am"),
            artifact_id: artifact.id,
            user_id: actingFor?.id ?? agent.id,
            role: "owner",
          })
        // Same fan-out as a publish (realtime, render, webhooks, search) — a
        // lineage is an ordinary artifact everywhere downstream.
        await afterPublish(
          {
            meta: ctx.meta,
            blobs: ctx.blobs,
            bus: ctx.bus,
            notify: ctx.notify,
            notifyRender: ctx.notifyRender,
            background: ctx.background,
            search: ctx.search,
          },
          artifact,
          version,
          { isNew: !existing, onBehalf: actingFor?.id ?? null, resolves: [] },
        )
        return json({
          checkpointed: true,
          short_id: artifact.short_id,
          version: version.n,
          url: artifactUrl(ctx.deps.baseUrl, artifact),
          note: existing
            ? "Layer replaced — versions keep the history."
            : `Lineage created. Pass short_id "${artifact.short_id}" on every future checkpoint (record it, e.g. in .derive/lineage).`,
        })
      } catch (e) {
        const msg = e instanceof PublishError ? e.message : "could not checkpoint"
        return text(`Checkpoint failed: ${msg}`)
      }
    },
  )

  // USE A CONTEXT — query a workspace's live data agents ------------------------
  // Contexts are askable agent setups (a registered agent wired to a manifest, answering
  // through an owner-run runner). `use` is the agent-side surface, acting FOR the
  // connection's on-behalf human: the human's own ask-grant (membership + ask_policy/
  // roster, re-checked per call via canUserAskContext) is the ONLY gate, so an agent can
  // reach exactly what its human can, and nothing more. Discovery is `find` (contexts ride
  // the browse/search results); a connection with no known human is refused at call time.
  // Management (create/rewire/delete) deliberately has no MCP path. (askableContexts /
  // runnerOnline defined here are ALSO used by find's context rows above.)

  // The console's liveness window: a runner is "online" while its last queue
  // poll (stamped at most once a minute) is within this.
  const RUNNER_ONLINE_MS = 90_000
  const NO_HUMAN =
    "Using a context opens a session on a human's behalf, and this connection has no acting human. " +
    "Reconnect with an OAuth login (or a token registered by a user) to use one."

  // The contexts `userId` may ask in `org`, each with its manifest (identity +
  // the current version a new session pins). One listContexts + one batched
  // artifact read; the per-context grant checks are membership/roster lookups.
  const askableContexts = async (org: string, userId: string) => {
    const rows = await ctx.meta.listContexts(org)
    const mine: ContextRecord[] = []
    for (const x of rows) if (await ctx.canUserAskContext(userId, x)) mine.push(x)
    const manifests = await ctx.meta.getArtifactsByIds(mine.map((x) => x.manifest_artifact_id))
    const byId = new Map(manifests.map((a) => [a.id, a]))
    return mine.map((x) => ({ x, manifest: byId.get(x.manifest_artifact_id) ?? null }))
  }
  const runnerOnline = (x: ContextRecord) =>
    !!x.runner_seen_at && Date.now() - new Date(x.runner_seen_at).getTime() < RUNNER_ONLINE_MS

  // Session messages are uncapped short of the write path's 100k/message, so a
  // maximal check-mode reply is megabytes through the calling agent's context.
  // Bound it like every read here (truncate-and-steer): a generous cap on the
  // answer, a tight one per transcript entry — together they stay under clip()'s
  // MAX_CHARS ceiling — and the steer names the console, which always holds the
  // full transcript.
  const ANSWER_MAX = 40_000
  const ENTRY_MAX = 1_500
  const clipSessionText = (s: string, max: number, consoleUrl: string): string =>
    s.length > max
      ? `${s.slice(0, max)}\n\n…[truncated ${s.length - max} of ${s.length} chars — full transcript in the console: ${consoleUrl}]`
      : s

  // (Listing the askable contexts now lives in `find` — they ride the browse/search rows.)

  server.registerTool(
    "use",
    {
      description:
        "Use a context (a live data agent — discover them with find) ON YOUR USER'S BEHALF " +
        "(rate-limited): ask it a question or hand it a commission — one session. OPEN: `context` " +
        "(id or name) + `question`. FOLLOW UP: `session_id` + `question`. CHECK/RESUME: `session_id` " +
        "alone. The call waits up to `wait` seconds (default 25) for the answer; real runs often " +
        "take minutes, so a still-open response is NORMAL, not an error — re-call with the returned " +
        "session_id until it settles. For the modes and wait semantics, read derive://skills/contexts.",
      inputSchema: {
        context: z
          .string()
          .optional()
          .describe(
            "The context to use — its id or name from a find context row. Opens a NEW session; omit when passing session_id.",
          ),
        question: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            "Your question (Markdown). With `context` it opens a session; with `session_id` it is a follow-up turn. Omit it to just check a session.",
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "An existing session of yours (from an earlier use, or a find context row) to follow up on or check.",
          ),
        wait: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            "Seconds to wait for the runner's answer before returning (default 25; 0 = return at once). An expired wait leaves the session open — re-call with session_id.",
          ),
        workspace: wsArg,
      },
    },
    async ({ context, question, session_id, wait, workspace }) => {
      if (!actingFor) return err(NO_HUMAN)
      // Session WRITES are capped per acting human — each one triggers a model
      // run on the context owner's runner, so a looping agent is the realistic
      // flood. The check mode is a read and stays uncapped.
      const overAskCap = async () => {
        if (!ctx.askLimiter) return null
        const r = await ctx.askLimiter(`id:${actingFor.id}`)
        return r.ok ? null : err(`Rate limit exceeded — retry in ${r.retryAfter}s.`)
      }

      // Every mode ends here: wait out the runner while the session is open,
      // then shape the reply from a FRESH read — the event is only a wake
      // (check_requests' pattern), so a missed/raced wake is never a wrong
      // answer. The channel wakes for ANY of this human's sessions settling;
      // the loop re-checks ours and waits out the remainder.
      const reply = async (start: SessionRecord, x: ContextRecord, checkOnly: boolean) => {
        let s = start
        const deadline = Date.now() + Math.min(Math.max(wait ?? 25, 0), 50) * 1000
        while (s.state === "open" && ctx.bus.waitFor) {
          const left = deadline - Date.now()
          if (left <= 0) break
          const release = new AbortController()
          const woke = ctx.bus
            .waitFor(`u:${actingFor.id}`, ["session.settled"], left, release.signal)
            .catch(() => null)
          // Close the check-then-wait gap: the settle may have landed since the
          // last read, before our subscription existed.
          const fresh = await ctx.meta.getSession(s.id)
          if (fresh && fresh.state !== "open") {
            release.abort()
            await woke
            s = fresh
            break
          }
          const e = await woke
          s = (await ctx.meta.getSession(s.id)) ?? s
          if (!e) break // timed out — s holds one last fresh read
        }

        const transcript = await ctx.meta.listSessionMessages(s.id)
        const answerRow =
          s.state !== "open"
            ? transcript.filter((m) => m.author_kind === "agent").at(-1)
            : undefined
        // Stored as TEXT (see ports); a hand-edited row must not 500 the tool —
        // unparseable meta reads as absent, the same tolerance the route shows.
        let answerMeta: unknown = null
        if (answerRow?.meta) {
          try {
            answerMeta = JSON.parse(answerRow.meta)
          } catch {
            answerMeta = null
          }
        }
        const note =
          s.state === "open"
            ? runnerOnline(x)
              ? "Still thinking — real runs take minutes. Re-call use with this session_id (+ wait) to collect the answer."
              : "Queued, but the context's runner looks OFFLINE — it answers when it comes back. Re-call use with this session_id later."
            : s.state === "escalated"
              ? "The runner escalated this to a human — a draft went to review. Check back later."
              : s.state === "failed"
                ? "The run crashed; the context's owner sees the failure. You can ask again."
                : s.state === "closed"
                  ? "This session was closed."
                  : undefined
        const consoleUrl = `${ctx.deps.baseUrl.replace(/\/$/, "")}/contexts/${x.id}`
        return json({
          session_id: s.id,
          context: x.name,
          state: s.state,
          ...(answerRow
            ? {
                answer: {
                  body_md: clipSessionText(answerRow.body_md, ANSWER_MAX, consoleUrl),
                  meta: answerMeta,
                  created_at: answerRow.created_at,
                },
              }
            : {}),
          ...(checkOnly
            ? {
                transcript: transcript.slice(-20).map((m) => ({
                  author: m.author_kind,
                  body_md: clipSessionText(m.body_md, ENTRY_MAX, consoleUrl),
                  created_at: m.created_at,
                })),
              }
            : {}),
          ...(note ? { note } : {}),
        })
      }

      // CHECK or FOLLOW UP an existing session.
      if (session_id) {
        if (context)
          return err(
            "Pass `context` OR `session_id`, not both — a follow-up already knows its context.",
          )
        const found = await ctx.meta.getSession(session_id)
        const linked = found ? await ctx.meta.getContext(found.context_id) : null
        // Ownership + the LIVE grant, re-checked per call (a human removed from
        // the workspace/roster loses ask-through-agent the moment they lose
        // ask-directly), and the OAuth grant's workspace clamp. Any miss reads
        // the same as a missing id — a session's existence never leaks.
        const allowed =
          !!found &&
          !!linked &&
          found.asker_id === actingFor.id &&
          inGrant(linked.org_id) &&
          (await ctx.canUserAskContext(actingFor.id, linked))
        if (!found || !linked || !allowed)
          return err(
            `No session "${session_id}" you can reach. find (a context row) shows your open sessions.`,
          )
        if (!question) return reply(found, linked, true)
        if (found.state === "closed")
          return err("That session is closed — open a new one by passing `context` + `question`.")
        const capped = await overAskCap()
        if (capped) return capped
        await ctx.meta.addSessionMessage(
          {
            id: newId("sm"),
            session_id: found.id,
            author_kind: "asker",
            author_id: actingFor.id,
            body_md: question,
          },
          "open",
        )
        // Re-read: the follow-up just flipped the session back to open.
        return reply((await ctx.meta.getSession(found.id)) ?? found, linked, false)
      }

      // OPEN a new session.
      if (!context)
        return err(
          "Pass `context` (+ `question`) to open a session, or `session_id` to check/resume. find surfaces the contexts you can use and your open sessions.",
        )
      if (!question) return err("Opening a session needs a `question`.")
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      const rows = await askableContexts(t.org, actingFor.id)
      const ref = context.trim()
      const hit =
        rows.find((r) => r.x.id === ref) ??
        rows.find((r) => r.x.name.toLowerCase() === ref.toLowerCase())
      // Naming the askable set leaks nothing (each entry is askable by this
      // human, by definition); with nothing askable there is nothing to name.
      if (!hit)
        return err(
          rows.length
            ? `No context "${context}" you can ask here. You can ask: ${rows.map((r) => r.x.name).join(", ")}.`
            : "No contexts you can ask in this workspace.",
        )
      if (!hit.manifest)
        return err(`Context "${hit.x.name}" has lost its manifest and can't be asked.`)
      const capped = await overAskCap()
      if (capped) return capped
      const opened = await ctx.meta.createSession({
        id: newId("ses"),
        context_id: hit.x.id,
        org_id: hit.x.org_id,
        asker_id: actingFor.id,
        context_version: hit.manifest.current_version,
      })
      await ctx.meta.addSessionMessage(
        {
          id: newId("sm"),
          session_id: opened.id,
          author_kind: "asker",
          author_id: actingFor.id,
          body_md: question,
        },
        "open",
      )
      return reply(opened, hit.x, false)
    },
  )

  // (SET UP THE BRANDPRINT is dissolved into `publish`: publishing to
  // derive://brandprint/profile scaffolds the slot on first write — see
  // resolveBrandprintProfileTarget above.)

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
    const server = await buildServer(
      ctx,
      agent,
      actingFor,
      ownerId,
      scopeForCap,
      !grant,
      boundWorkspaces,
    )
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return transport.handleRequest(c)
  })
}
