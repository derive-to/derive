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
//
// STRUCTURE — buildServer stays thin: it constructs the McpServer, registers the
// resources (skills + Brandprint conventions), resolves the Brandprint, writes the
// `instructions`, and fetches the pending-request inbox. It then builds `base`, makes the
// per-request ToolContext (mcp-tool-context.ts), and calls one register<Name>Tool per
// tool IN ORDER — each lives in its own mcp-tools/<name>.ts, sourcing shared refs from
// the context and pure helpers from mcp-util.ts. The registration ORDER here is load-
// bearing: the surface-budget test and clients depend on tool order.

import {
  AGENT_INBOX_PAGE,
  type AgentRecord,
  type ArtifactRecord,
  brandprintInstructions,
  bundleDoc,
  parseFrontmatter,
  pendingRequestsPointer,
  profileState,
  type Role,
  SKILL_CONTENT_TYPE,
} from "@derive/core"
import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import { BRANDPRINT_REFERENCE, BRANDPRINT_TEMPLATE } from "./brandprint-reference"
import type { AppContext } from "./context"
import { resolveActorBrandprint } from "./lib/brandprint"
import { makeToolContext, type ToolContextBase } from "./mcp-tool-context"
import { registerAutomateTool } from "./mcp-tools/automate"
import { registerCatchUpTool } from "./mcp-tools/catch-up"
import { registerCheckpointTool } from "./mcp-tools/checkpoint"
import { registerCodeTool } from "./mcp-tools/code"
import { registerCommentTool } from "./mcp-tools/comment"
import { registerFindTool } from "./mcp-tools/find"
import { registerListWorkspacesTool } from "./mcp-tools/list-workspaces"
import { registerOrganizeTool } from "./mcp-tools/organize"
import { registerPublishTool } from "./mcp-tools/publish"
import { registerReadTool } from "./mcp-tools/read"
import { registerStageTool } from "./mcp-tools/stage"
import { registerUseTool } from "./mcp-tools/use"
import { manifestOf } from "./mcp-util"
import { CORE_SKILLS } from "./skills-reference.gen"

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
  // The OAuth client behind this connection ("" for a registered dk_agt_ token).
  // Recorded into tokens minted by `stage target:'api'` as their provenance.
  clientId: string,
  // This connection is itself authenticated by a minted dkapi_ token — the mint
  // refuses to chain off one (it would renew its own TTL indefinitely).
  mintedToken: boolean,
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
      // Advertise that this server's tool list can CHANGE. Clients cache the surface at
      // connect, so a capability shipped afterwards is invisible — and worse, unusable:
      // the client validates arguments against its cached schema and refuses before the
      // request is ever sent (a new enum value never reaches us). Declaring listChanged
      // is the protocol's own answer and costs nothing. It is not the WHOLE answer here,
      // because this server is stateless — a fresh instance per request — so it can never
      // wake an idle client. Hence the other two halves: the growth-prone discriminators
      // validate server-side rather than by enum (so a stale client's argument still
      // arrives), and list_workspaces reports the live surface (so staleness is
      // diagnosable instead of looking like a missing feature).
      capabilities: { tools: { listChanged: true } },
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

  // Assemble the per-request context, then register each tool IN ORDER. The order is
  // load-bearing — the surface-budget test and clients depend on tool order — so it
  // mirrors the historical inline sequence exactly. Gating (the `use` runner behavior,
  // the `catch_up` inbox) lives inside each tool's handler, unchanged.
  const base: ToolContextBase = {
    server,
    ctx,
    agent,
    actingFor,
    ownerId,
    scopeForCap,
    registered,
    boundWorkspaces,
    clientId,
    mintedToken,
    defaultOrg,
    defaultRole,
    pendingRequests,
    bpProfile,
    profileArt,
  }
  const tc = makeToolContext(base)
  // The LIVE tool surface, captured as each tool registers, in two shapes because two
  // callers need different things from it. Wrapping the registrar rather than maintaining a
  // second list is what keeps them from drifting: a tool added tomorrow appears in both the
  // moment it registers, with nothing to remember.
  //
  // `registry` maps name -> handler so derive_code can invoke a tool BY NAME without any of
  // the tool modules knowing it exists. `toolNames` is the answer to "is my cached tool list
  // stale?" — which only means anything if it reflects what the server actually serves, so a
  // hand-kept list would eventually lie about the very thing it reports on.
  const registry = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
  const toolNames = new Set<string>()
  const originalRegister = server.registerTool.bind(server)
  server.registerTool = ((
    name: string,
    config: Parameters<typeof originalRegister>[1],
    handler: Parameters<typeof originalRegister>[2],
  ) => {
    registry.set(name, handler as (input: Record<string, unknown>) => Promise<unknown>)
    toolNames.add(name)
    return originalRegister(name, config, handler)
  }) as typeof server.registerTool

  // Read at CALL time (every tool has registered by then), never at registration time.
  registerListWorkspacesTool(tc, () => [...toolNames].sort())
  registerFindTool(tc)
  registerReadTool(tc)
  registerOrganizeTool(tc)
  registerCatchUpTool(tc)
  registerCommentTool(tc)
  registerStageTool(tc)
  registerPublishTool(tc)
  registerCheckpointTool(tc)
  registerUseTool(tc)
  registerAutomateTool(tc)
  // LAST, so the registry it reads is complete. Registers only when an isolate exists: the Node
  // entry injects a worker-thread sandbox, and the Cloudflare entry injects nothing until the
  // Worker Loader is out of beta — so the tool is absent there rather than present and broken.
  if (ctx.deps.codeSandbox) registerCodeTool(tc, registry, ctx.deps.codeSandbox)

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
    // A minted dkapi_ bearer resolves to the same principal shape as its grant, so the
    // mint has to be told explicitly not to run off one (self-renewal — see
    // isMintedApiToken).
    const mintedToken = ctx.isMintedApiToken(c)
    const server = await buildServer(
      ctx,
      agent,
      actingFor,
      ownerId,
      scopeForCap,
      !grant,
      boundWorkspaces,
      grant?.clientId ?? "",
      mintedToken,
    )
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return transport.handleRequest(c)
  })
}
