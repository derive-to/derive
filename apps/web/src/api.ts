import type { LinkRole, Listed, Role, SortMode, WorkspaceAccess } from "@derive/core"
import type { components, paths } from "./api-types"
import { guestQuery } from "./lib/guest-id"

/** The role vocabulary and the v2 access model's three single-purpose fields are
 *  canonical in @derive/core (roles.ts); imported here as type-only (clients never
 *  import core at runtime — see .dependency-cruiser.mjs) and re-exported so this
 *  stays the one place other web modules name them from. */
export type { LinkRole, Listed, Role, WorkspaceAccess }

/** A pointer to the conventions collection a workspace or an account likes its
 *  artifacts built from. Mirrors packages/core/src/ports.ts Brandprint, minus
 *  `profileId`: the brand profile is workspace scope and rides the generated
 *  OrgSettings.brandprint. Not itself a named OpenAPI schema; the personal copy is
 *  a Better Auth additionalField (a JSON string) surfaced through the hand-mapped
 *  `Me`, same as profession/about below. */
export interface Brandprint {
  collectionId?: string | null
  /** Personal-layer only: false turns the workspace Brandprint off for this user
   *  (their agents skip the org's conventions and profile; a personal collection
   *  above still applies). Absent or true: the workspace layer applies. A
   *  workspace's own settings never carry this field. */
  useWorkspaceBrandprint?: boolean
}
/** Parse a Me.brandprint / SessionUser.brandprint JSON string; null if absent/malformed. */
export const parseBrandprint = (raw: string | null | undefined): Brandprint | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Brandprint
  } catch {
    return null
  }
}

export interface Me {
  id: string
  email: string
  name: string | null
  /** Public handle; null until claimed (Profiles & Accounts v1). */
  username: string | null
  /** Avatar URL; null until a photo is set. */
  image: string | null
  /** Opt-in: findable in people search when true. */
  discoverable: boolean
  role: string
  /** Coarse team role (Product / Engineering / Design / Marketing / …); null if unset. */
  profession: string | null
  /** One-line "what you do" blurb; null if unset. */
  about: string | null
  /** Finished/skipped first-run onboarding? Server-authoritative (syncs across devices). */
  onboarded: boolean
  /** Has the account's email been verified? Soft-nudge only (never gates anything); drives
   *  the dismissible "verify your email" banner. */
  emailVerified: boolean
  /** Is TOTP two-factor enabled? Drives the Security-hub enable/disable state. */
  twoFactorEnabled: boolean
  /** Your personal Brandprint (conventions collection); null if unset. Layers over
   *  the workspace's (yours wins) when an agent acts as you. */
  brandprint: Brandprint | null
}
/** What sign-in methods + auth flows THIS instance actually has (capability-adaptive:
 *  a bare self-host reports fewer than a fully-wired hosted deploy). Drives the login
 *  page + Security hub. Generated from the OpenAPI spec. */
export type AuthCapabilities = components["schemas"]["AuthCapabilities"]
/** An OAuth agent the user authorized to act on their behalf (the "Connected agents"
 *  list). Generated from the OpenAPI spec. */
export type ConnectedAgent = components["schemas"]["ConnectedAgent"]
/** The activation signals for first-run onboarding: whether an agent is connected and
 *  what it first published for this user. Generated from the OpenAPI spec. */
export type OnboardingStatus =
  paths["/v1/me/onboarding"]["get"]["responses"][200]["content"]["application/json"]
/** A public profile, by handle. Email is private and never returned here.
 *  Generated from the OpenAPI spec. */
export type PublicProfile = components["schemas"]["PublicProfile"]
/** Time-grouped view of an artifact's versions. Generated from the OpenAPI spec. */
export type VersionSession = components["schemas"]["VersionSession"]
/** The artifact view-model — the largest, most-composed shape in the client. Generated
 *  from the OpenAPI spec (apps/api/openapi.json). `my_role` is `Role | null`;
 *  workspace_access/link_role/listed are the v2 access enums (see access-model.md). */
export type Artifact = components["schemas"]["Artifact"]
/** An abuse report against an artifact. Generated from the OpenAPI spec. */
export type Report = components["schemas"]["Report"]
/** A collection: a shareable group of artifacts, tagged with its item count and origin
 *  (kind = manual / repo / pr). Generated from the OpenAPI spec (apps/api/openapi.json)
 *  — a backend shape change surfaces here at `tsc`. */
export type Collection = components["schemas"]["Collection"]
export type Folder = components["schemas"]["Folder"]
/** The result of a /v1/bulk/* op: counts per artifact (skipped = not yours to touch). */
export type BulkSummary = components["schemas"]["BulkSummary"]
/** A collection whose sharing reaches an artifact (workspace-open, or invite-only with
 *  members) — the share dialog's disclosure rows. Generated from the OpenAPI spec. */
export type CollectionGrant = components["schemas"]["CollectionGrant"]
/** A per-user follow: a GitHub author (kind="author", target=login), a repo path
 *  prefix (kind="path", target=path prefix), or a person (kind="user", target=username
 *  on the wire). Drives the `scope=following` feed. Generated from the API's OpenAPI
 *  spec (apps/api/openapi.json) — a backend shape change surfaces here at `tsc`, so the
 *  web client and server can't silently drift. */
export type Follow = components["schemas"]["Follow"]
export type FollowKind = Follow["kind"]
/** A proposal: a candidate version awaiting review. Generated from the OpenAPI spec. */
export type Proposal = components["schemas"]["Proposal"]
export type ProposalState = Proposal["state"]
/** A quote-scoped edit (the inline editor's wire shape): replace the text located by
 *  {exact, prefix, suffix}, resolved server-side against the stored source. */
export interface QuoteEditInput {
  quote: { exact: string; prefix?: string; suffix?: string }
  new_text: string
}
/** A collaborator on an artifact or collection — by public @handle, never email.
 *  Generated from the OpenAPI spec (one shared schema across sharing + collections). */
export type ArtifactMember = components["schemas"]["ArtifactMember"]
/** A DNS record the customer adds to validate a custom domain. */
/** A DNS record to add when validating a custom domain. Generated from the OpenAPI spec. */
export type DomainDnsRecord = components["schemas"]["DomainDnsRecord"]
/** A vanity subdomain bound to one artifact (the per-artifact share section). */
/** A vanity subdomain claimed for an artifact. Generated from the OpenAPI spec. */
export type ArtifactDomain = components["schemas"]["ArtifactDomain"]
/** A workspace custom domain (managed in settings; Cloudflare for SaaS). */
/** A workspace custom domain (Cloudflare for SaaS). Generated from the OpenAPI spec. */
export type WorkspaceDomain = components["schemas"]["WorkspaceDomain"]
/** The workspace: its name, the caller's role, and the member directory. */
export type Workspace = components["schemas"]["Workspace"]
/** A pending workspace invitation (Admin view; the token is never exposed). */
export type Invite = components["schemas"]["Invite"]
/** The result of inviting by email: either the person was an existing Derive account
 *  (added straight to the roster) or a pending, emailed invitation was created. */
export type InviteResult = components["schemas"]["InviteResult"]
/** What the accept page shows before you join. */
export type InvitePreview = components["schemas"]["InvitePreview"]
export type ArtifactInvite = components["schemas"]["ArtifactInvite"]
export type ArtifactInvitePreview = components["schemas"]["ArtifactInvitePreview"]
/** What the claim page shows before an anonymous draft is claimed. Hand-declared:
 *  the draft-claim routes aren't in the OpenAPI spec. */
export interface DraftClaimPreview {
  short_id: string
  title: string | null
  kind: string
  expires_at: string
  /** The live expiring page on the usercontent domain; null if no host is bound. */
  draft_url: string | null
}
/** PUT members result: shared directly (existing account) or invited by email. */
export type ShareResult = components["schemas"]["ShareResult"]
/** Per-workspace integration switches. Generated from the OpenAPI spec. */
export type OrgSettings = components["schemas"]["OrgSettings"]
/** The workspace's billing truth: plan, Stripe status, seats, storage. Hand-declared:
 *  routes/billing.ts is plain Hono (no OpenAPI contract — a fast-moving internal
 *  surface, not the documented public API), matching this file's other
 *  hand-declared shapes (e.g. DraftClaimPreview above). */
export type BillingInfo = {
  tier: "free" | "team" | "business"
  status: string | null
  interval: "month" | "year" | null
  quantity: number | null
  seats: number
  current_period_end: string | null
  storage: { used_bytes: number; cap_bytes: number | null }
  enforce_at: string | null
  beta: boolean
  subscribed: boolean
}
/** Slack connection status for a workspace. Generated from the OpenAPI spec. */
export type SlackStatus = components["schemas"]["SlackStatus"]
/** One entry in the workspace switcher. */
export type WorkspaceSummary = components["schemas"]["WorkspaceSummary"]
/** The switcher payload: whether multi-workspace is on, the active id, the list. */
export type Workspaces = components["schemas"]["Workspaces"]
/** The one display rule for workspace names: the personal workspace renders as
 *  "Personal" everywhere — its stored name is provisioning plumbing, not a name
 *  the user chose. */
export const workspaceDisplayName = (w: { name: string; personal: boolean }): string =>
  w.personal ? "Personal" : w.name
/** Per-artifact view stats. Generated from the OpenAPI spec. */
export type Analytics = components["schemas"]["Analytics"]
/** A resolved @mention: the picked user's id + the display name shown inline. */
/** A person/agent @mentioned in a comment. Generated from the OpenAPI spec. */
export type Mention = components["schemas"]["Mention"]
/** A review round: the agent asked this person to review a version, and polls for
 *  the answer. `pending` = waiting; `sent_back` = they returned answers; `approved`. */
/** A review round on an artifact (the /derive loop). Generated from the OpenAPI spec. */
export type ReviewRound = components["schemas"]["ReviewRound"]

/** A comment: threaded, anchored to a text quote, with reactions/edits/soft-delete.
 *  Generated from the OpenAPI spec. */
export type Comment = components["schemas"]["Comment"]
/** A person/agent offered by the @mention picker — by @handle, never email.
 *  Generated from the OpenAPI spec. */
export type DirUser = components["schemas"]["DirUser"]
/** An in-app notification (the header bell). Generated from the API's OpenAPI spec
 *  (apps/api/openapi.json) — a backend shape change surfaces here at `tsc`. */
export type Notification = components["schemas"]["Notification"]
/** An outbound webhook, without its signing secret. Generated from the OpenAPI spec. */
export type Webhook = components["schemas"]["Webhook"]
/** A workspace-registered agent. Generated from the OpenAPI spec. */
export type Agent = components["schemas"]["Agent"]

/** How an automation fires. Manual = a Run button; schedule = a cron in a timezone;
 *  event = a subscription. Hand-typed: the automation routes are the agent-facing plain
 *  surface, not the OpenAPI web spec. */
export interface AutomationTrigger {
  kind: "manual" | "schedule" | "event"
  cron?: string
  tz?: string
  on?: string
}
/** A connected model-plan credential, as the settings UI sees it — never the secret. */
export interface ModelCredentialHint {
  provider: "claude-code" | "codex"
  kind: "oauth" | "api_key" | "login"
  hint: string
  updated_at: string
}
/** A ref is a selector — one generic way to point at a set of artifacts: a specific
 *  doc (revise it), a collection (file new work into it), or a tag (stamped on every
 *  write the run makes). The API accepts a bare short-id string as artifact shorthand
 *  and always RETURNS the canonical object form. */
export type AutomationRef =
  | { kind: "artifact"; id: string; mode?: "publish" | "propose" }
  | { kind: "collection"; id: string; mode?: "publish" | "propose" }
  | { kind: "tag"; tag: string; mode?: "publish" | "propose" }
/** A standing agent job: an agent + a trigger + a free-form instruction (+ optional refs).
 *  Every firing is a Run. */
export interface Automation {
  id: string
  agent_id: string
  trigger: AutomationTrigger
  instruction: string
  refs: AutomationRef[]
  enabled: boolean
  created_at: string
  /** When this automation's agent last polled the run claim endpoint (list responses
   *  only). Null = no executor has ever polled — the automation is inert. */
  executor_seen_at?: string | null
}
/** One execution — the queue (queued/running) and the ledger (succeeded/failed) in one row. */
export interface Run {
  id: string
  automation_id: string | null
  agent_id: string
  reason: string
  status: "queued" | "running" | "succeeded" | "failed"
  cost_micro_usd: number | null
  meta: string | null
  created_at: string
  finished_at: string | null
  /** Derived server-side (never stored): where this run is and why. Lets the activity view
   *  answer "nothing is happening — is it broken?" without anyone opening server logs. */
  timeline?: {
    phase: Run["status"]
    /** Set when a queued run isn't due yet: a schedule, or a retry backoff. */
    waiting_until: string | null
    queued_ms: number | null
    ran_ms: number | null
    /** Attempts already spent (0 = first try); each one costs the initiator's model plan. */
    retries: number
    last_error: string | null
    outcome: string | null
    writes: unknown[]
  }
}
/** An askable agent setup: a registered agent wired to a manifest artifact.
 *  Generated from the OpenAPI spec. */
export type ContextInfo = components["schemas"]["ContextInfo"]
/** The runner's structured payload on an agent message. Generated from the spec. */
export type SessionMeta = components["schemas"]["SessionMeta"]
export type SessionMessage = components["schemas"]["SessionMessage"]
/** An ask-conversation with a context's agent. Generated from the OpenAPI spec. */
export type Session = components["schemas"]["Session"]
export type SessionState = Session["state"]
/** A live viewer of an artifact (presence). Identified by a handle-style `name`
 *  (never email — presence is broadcast to anonymous co-viewers); `role` is their
 *  effective role here. */
export type Viewer = components["schemas"]["Viewer"]
/** A webhook delivery attempt. Generated from the OpenAPI spec. */
export type Delivery = components["schemas"]["Delivery"]
/** A GitHub repo mirrored into a collection (token redacted, file map collapsed
 *  to a count by the API). */
/** A GitHub repo source (branch mirror), client-safe (token redacted, files→count).
 *  Generated from the OpenAPI spec. */
export type RepoSource = components["schemas"]["RepoSource"]
/** Live, pollable sync progress — the engine writes this every batch; the UI bar +
 *  global chip read it. Parsed client-side from the `progress` string. */
export interface SyncProgress {
  phase: "queued" | "listing" | "mirroring" | "done" | "error"
  done: number
  total: number
  message?: string
  updatedAt: string
}
/** Parse a RepoSource.progress / SyncStatus.progress string; null if absent/malformed. */
export const parseProgress = (raw: string | null | undefined): SyncProgress | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as SyncProgress
  } catch {
    return null
  }
}
/** The cheap status-poll response that drives the progress bar. Generated from the spec. */
export type SyncStatus = components["schemas"]["SyncStatus"]
/** A GitHub App installation on a workspace. Generated from the OpenAPI spec. */
export type GithubInstallation = components["schemas"]["GithubInstallation"]
/** A read-only preview of an open pull request's changed docs. Generated from the spec. */
export type PrPreview = components["schemas"]["PrPreview"]
/** GitHub sync connection status (sources + PR previews + App + installations).
 *  Generated from the OpenAPI spec. */
export type GithubSyncStatus = components["schemas"]["GithubSyncStatus"]
/** A repo an installation can mirror (the picker). Generated from the OpenAPI spec. */
export type InstallationRepo = components["schemas"]["InstallationRepo"]
/** A repo+scope preview: how many docs would mirror, split by type. Generated from the spec. */
export type SyncPreview = components["schemas"]["SyncPreview"]
/** One line of a unified diff. Generated from the OpenAPI spec. */
export type DiffOp = components["schemas"]["DiffOp"]
export interface Diff {
  from: number
  to: number
  ops: DiffOp[]
}

// Same-origin by default (dev proxy / embedded self-host). Set VITE_DERIVE_API to
// the API origin when the SPA is served from a CDN separate from the container.
export const API_BASE = (import.meta.env.VITE_DERIVE_API ?? "").replace(/\/$/, "")
const u = (path: string) => API_BASE + path
const f = (path: string, init?: RequestInit) => fetch(u(path), init)

// Thrown error carries the HTTP status so callers can branch (e.g. a 401 on a
// password artifact means "prompt for the password", not "not found"), plus the
// server's machine-readable `code` when fail() attached one — branch on that,
// never on the human-readable message, which is free to be reworded.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}
const j = async (r: Response) => {
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new ApiError(body.error ?? `HTTP ${r.status}`, r.status, body.code)
  }
  return r.json()
}
// The high-churn read methods (lists, typeahead search) accept this so React Query's
// per-fetch AbortSignal reaches the wire: a superseded keystroke CANCELS its request
// instead of running an authenticated Worker + Postgres round trip nobody will read.
// Display-level races were already guarded (query keys / alive flags) — forwarding the
// signal is about not paying for abandoned work.
type FetchInit = Pick<RequestInit, "signal">
const opts = (body?: unknown, init?: FetchInit): RequestInit => ({
  ...init,
  credentials: "include",
  headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
})

// Better Auth lives under /api/auth; get-session returns { user } | null.
const authJson = async (r: Response) => {
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.message ?? data?.error?.message ?? `HTTP ${r.status}`)
  return data
}

// Map Better Auth's session user onto our Me (discoverable defaults on). Used by
// session() so the mapping lives in one place.
type SessionUser = {
  id: string
  email: string
  name?: string | null
  username?: string | null
  image?: string | null
  discoverable?: boolean
  profession?: string | null
  about?: string | null
  onboarded?: boolean
  emailVerified?: boolean
  twoFactorEnabled?: boolean
  /** JSON string ({ collectionId?, theme? }); the Better Auth additionalField. */
  brandprint?: string | null
}
const mapMe = (u: SessionUser): Me => ({
  id: u.id,
  email: u.email,
  name: u.name ?? null,
  username: u.username ?? null,
  image: u.image ?? null,
  // On by default: discoverable unless explicitly opted out.
  discoverable: u.discoverable !== false,
  role: "member",
  profession: u.profession ?? null,
  about: u.about ?? null,
  // Off by default: onboarded only when explicitly set (unset = not yet).
  onboarded: u.onboarded === true,
  emailVerified: u.emailVerified === true,
  twoFactorEnabled: u.twoFactorEnabled === true,
  brandprint: parseBrandprint(u.brandprint),
})

// A workspace content-search hit. Hand-written (not generated): the search endpoint's
// `?format=json` shape is a plain route, not part of the OpenAPI contract.
export interface SearchHit {
  short_id: string
  title: string
  current_version: number
  /** One line of the matching text, windowed around the match (server-side). */
  snippet: string
  /** True when this matched by MEANING only (no literal occurrence) — the UI badges it. */
  semantic: boolean
}

// A per-user connected external account (WO3) — a Source. Always the caller's own.
export interface Connection {
  id: string
  user_id: string
  broker: string
  toolkit: string
  /** How it authenticates. `mcp` is a Model Context Protocol server connected by URL — it needs
   *  no vendor account and no broker plan, which is why it is the one kind you can add here. */
  kind?: "oauth" | "secret" | "github_app" | "slack" | "mcp"
  /** kind `mcp`: the server URL. Display only — the credential never comes back. */
  base_url?: string | null
  scopes_label: string | null
  status: "active" | "pending" | "revoked"
  created_at: string
}

export const api = {
  // The ONE identity read — behind meQuery, and re-read after login/signup to seed the
  // auth cache. Prerender-safe (null at build — no document); a resolved null for an
  // anon visitor (401, or a 200 with no user); a mapped Me when signed in; and a THROWN
  // transient ApiError on a 5xx so the query's retry can self-heal. Distinguishing anon
  // (null) from a blip (throw) is what lets the auth query resolve cleanly instead of
  // dead-ending.
  async session(): Promise<Me | null> {
    if (typeof document === "undefined") return null
    const r = await f("/api/auth/get-session", { credentials: "include" })
    if (r.status === 401) return null
    if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status)
    const s = await r.json().catch(() => null)
    return s?.user ? mapMe(s.user) : null
  },
  // Claim or change your handle (onboarding + rename). 409 when taken, 400 on a
  // bad shape — both surface their message via ApiError.
  setUsername: (username: string): Promise<{ username: string }> =>
    f("/v1/me/username", opts({ username })).then(j),
  // A public profile by handle (no email). Readable without a session; for a signed-in
  // viewer it also carries stats + followed_by_me.
  profile: (handle: string): Promise<{ user: PublicProfile }> =>
    f(`/v1/users/${encodeURIComponent(handle)}`, { credentials: "include" }).then(j),
  // A person's work — public artifacts they authored, plus shared-workspace work for a
  // signed-in viewer. Keyset-paginated; readable without a session.
  profileArtifacts: (
    handle: string,
    cursor?: string,
    limit?: number,
    init?: FetchInit,
  ): Promise<{ artifacts: Artifact[]; next_cursor: string | null }> => {
    const qs = new URLSearchParams()
    if (cursor) qs.set("cursor", cursor)
    if (limit) qs.set("limit", String(limit))
    const s = qs.toString()
    return f(`/v1/users/${encodeURIComponent(handle)}/artifacts${s ? `?${s}` : ""}`, {
      ...init,
      credentials: "include",
    }).then(j)
  },
  // People who follow / are followed by this user (public profiles; no ids or email).
  // Set your team role + "what you do" blurb (onboarding + Settings → Profile), and/or
  // your personal Brandprint (Settings → Brandprint). Omitted fields are left untouched;
  // "" clears profession/about, null clears brandprint.
  setProfile: (fields: {
    profession?: string
    about?: string
    brandprint?: Brandprint | null
  }): Promise<{ profession: string | null; about: string | null; brandprint: Brandprint | null }> =>
    f("/v1/me/profile", opts(fields)).then(j),
  // Opt in/out of people search.
  setDiscoverable: (discoverable: boolean): Promise<{ discoverable: boolean }> =>
    f("/v1/me/discoverable", opts({ discoverable })).then(j),
  // Mark first-run onboarding finished/skipped — server-authoritative, so the /welcome
  // gate stays consistent across devices (the localStorage flag is only a fast-path cache).
  setOnboarded: (): Promise<{ onboarded: boolean }> => f("/v1/me/onboarded", opts({})).then(j),
  // Connected agents: the OAuth clients (MCP agents like Claude) you've authorized to act on
  // your behalf, and one-tap revocation — delegation made legible + reversible.
  connectedAgents: (): Promise<{ agents: ConnectedAgent[] }> =>
    f("/v1/me/connected-agents", opts()).then(j),
  // The activation signals first-run onboarding reads: agent connected + what it first
  // published for you. Polled by /welcome; read lazily by the getting-started checklist.
  onboarding: (): Promise<OnboardingStatus> => f("/v1/me/onboarding", opts()).then(j),
  revokeConnectedAgent: (clientId: string): Promise<void> =>
    f(`/v1/me/connected-agents/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
      credentials: "include",
    }).then(() => undefined),
  // Find opted-in people by @handle or name (signed-in; empty q → []).
  searchPeople: (q: string, init?: FetchInit): Promise<{ users: PublicProfile[] }> =>
    f(`/v1/users/search?query=${encodeURIComponent(q)}`, opts(undefined, init)).then(j),
  // Content search across the workspace via the persisted index: hits ranked by
  // relevance, each with a one-line snippet of WHERE it matched (visible text, so the
  // snippet reads as prose). Empty q → []. A small `limit` keeps the palette's debounced
  // typeahead to a few blob reads. Same visibility rules as list_artifacts.
  searchContent: (
    q: string,
    limit = 6,
    init?: FetchInit,
  ): Promise<{ hits: SearchHit[]; truncated: boolean }> => {
    const term = q.trim()
    return term
      ? f(
          `/v1/artifacts/search?format=json&in=text&limit=${limit}&query=${encodeURIComponent(term)}`,
          opts(undefined, init),
        ).then(j)
      : Promise.resolve({ hits: [], truncated: false })
  },
  // The People directory: browse opted-in people (empty q) or search them (signed-in).
  // Unlike searchPeople, an empty query BROWSES the discoverable set.
  people: (q?: string, init?: FetchInit): Promise<{ users: PublicProfile[] }> =>
    f(`/v1/people${q ? `?query=${encodeURIComponent(q)}` : ""}`, opts(undefined, init)).then(j),
  // The people you share a workspace with — the directory's leading section.
  workspacePeople: (): Promise<{ users: PublicProfile[] }> =>
    f("/v1/people?scope=workspace", opts()).then(j),
  // Upload a profile picture (raster image; server validates + stores it and sets
  // user.image to the served URL). Returns the new image URL.
  uploadAvatar: (file: File): Promise<{ image: string }> => {
    const fd = new FormData()
    fd.append("file", file)
    return f("/v1/me/avatar", {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j)
  },
  login: (email: string, password: string): Promise<unknown> =>
    f("/api/auth/sign-in/email", opts({ email, password })).then(authJson),
  signup: (email: string, password: string, name: string): Promise<unknown> =>
    f("/api/auth/sign-up/email", opts({ email, password, name: name || email })).then(authJson),
  logout: () => f("/api/auth/sign-out", opts({})).then((r) => r.json().catch(() => ({}))),
  // The auth capabilities of THIS instance — which sign-in methods + flows are live
  // here (drives the login page + Security hub; capability-adaptive).
  capabilities: (): Promise<AuthCapabilities> => f("/v1/auth/capabilities", opts()).then(j),
  // Better Auth social sign-in: POST returns the provider authorize URL, then we
  // navigate there. callbackURL is where the provider lands the user afterwards
  // (default home; the login page passes the resume/return_to target explicitly).
  async socialSignIn(provider: "google" | "github", callbackURL = "/"): Promise<void> {
    const data = await f("/api/auth/sign-in/social", opts({ provider, callbackURL })).then(authJson)
    if (data?.url) window.location.href = data.url
  },
  // Enterprise SSO (generic OIDC) sign-in via Better Auth's genericOAuth plugin — same
  // navigate-to-authorize-URL shape as social; providerId comes from capabilities().oidc.
  async ssoSignIn(providerId: string, callbackURL = "/"): Promise<void> {
    const data = await f("/api/auth/sign-in/oauth2", opts({ providerId, callbackURL })).then(
      authJson,
    )
    if (data?.url) window.location.href = data.url
  },
  // "Forgot password" — email a reset link. The reply is a neutral OK even for an unknown
  // address (the server simulates the work), so it can't be used to probe which emails have
  // accounts. `redirectTo` is where the emailed link lands (our /reset-password page, which
  // reads ?token=). Gated by capabilities.passwordReset (hidden with no mail transport).
  requestPasswordReset: (email: string, redirectTo: string): Promise<unknown> =>
    f("/api/auth/request-password-reset", opts({ email, redirectTo })).then(authJson),
  // Complete a reset: the emailed token + the chosen new password.
  resetPassword: (token: string, newPassword: string): Promise<unknown> =>
    f("/api/auth/reset-password", opts({ token, newPassword })).then(authJson),
  // Change your password while signed in (revokes every OTHER session).
  changePassword: (currentPassword: string, newPassword: string): Promise<unknown> =>
    f(
      "/api/auth/change-password",
      opts({ currentPassword, newPassword, revokeOtherSessions: true }),
    ).then(authJson),
  // Change your account email; a confirmation link goes to the NEW address, and the change
  // only takes effect once it's clicked.
  changeEmail: (newEmail: string, callbackURL: string): Promise<unknown> =>
    f("/api/auth/change-email", opts({ newEmail, callbackURL })).then(authJson),
  // Re-send the verification email to your address (the soft-nudge banner's action).
  sendVerificationEmail: (email: string, callbackURL: string): Promise<unknown> =>
    f("/api/auth/send-verification-email", opts({ email, callbackURL })).then(authJson),

  listArtifacts: (
    params?: {
      q?: string
      tag?: string
      collection?: string
      favorite?: boolean
      /** Narrow to artifacts last changed by this GitHub login. */
      author?: string
      /** "shared" → only artifacts explicitly shared with you (across workspaces).
       *  "following" → artifacts in the active workspace matching your follows
       *  (followed GitHub authors + repo path prefixes) — the activity feed.
       *  "needs_feedback" → artifacts with an open thread you're tagged in or commented on.
       *  "mine" → everything you published by hand in the active workspace, any
       *  visibility included — the library's "Created by me" filter. */
      scope?: "shared" | "following" | "needs_feedback" | "mine"
      cursor?: string
      limit?: number
      /** Grid order. Omit to get the route's default, created-desc (the library always sends
       *  this explicitly); the library's own default is `updated`. */
      sort?: SortMode
    },
    init?: FetchInit,
  ): Promise<{
    artifacts: Artifact[]
    next_cursor: string | null
    /** Present when listing by `collection` — the collection's id + title, so the
     *  view can label itself even for a collection in another workspace. */
    collection?: { id: string; title: string }
  }> => {
    const qs = new URLSearchParams()
    if (params?.q) qs.set("query", params.q)
    if (params?.tag) qs.set("tag", params.tag)
    if (params?.collection) qs.set("collection", params.collection)
    if (params?.favorite) qs.set("favorite", "true")
    if (params?.author) qs.set("author", params.author)
    if (params?.scope) qs.set("scope", params.scope)
    if (params?.cursor) qs.set("cursor", params.cursor)
    if (params?.limit) qs.set("limit", String(params.limit))
    if (params?.sort) qs.set("sort", params.sort)
    const s = qs.toString()
    return f(`/v1/artifacts${s ? `?${s}` : ""}`, opts(undefined, init)).then(j)
  },
  browseSummary: (): Promise<{
    total: number
    favorites: number
    /** The caller's owned artifacts — badges the library's "Created by me" filter. */
    mine: number
    /** How many of those are still private — the pending signal. */
    mine_private: number
    tags: { tag: string; count: number }[]
    workspace: string
  }> => f("/v1/tags", opts()).then(j),
  getArtifact: (id: string): Promise<Artifact> => f(`/v1/artifacts/${id}`, opts()).then(j),
  getContent: (id: string, v?: number): Promise<string> =>
    f(`/v1/artifacts/${id}/content${v ? `?v=${v}` : ""}`, { credentials: "include" }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    }),
  // Render a markdown draft to the exact published HTML, for the live editor
  // preview (markdown only; HTML drafts preview in-browser).
  renderPreview: (source: string, title: string | null): Promise<{ html: string }> =>
    f("/v1/preview", opts({ source, title })).then(j),
  // Verify a password artifact's password; on success the server sets the unlock
  // cookie and subsequent reads of this artifact succeed.
  unlock: (id: string, password: string): Promise<{ ok: true }> =>
    f(`/v1/artifacts/${id}/unlock`, opts({ password })).then(j),
  // Change access from the Share dialog: the three fields (workspace access, the
  // world link role, and where it's listed). Omitted fields keep the artifact's
  // current values. Anonymous reachers stay view-only regardless. A password string
  // (re)sets the lock on the world link; "" clears it; undefined keeps it.
  setAccess: (
    id: string,
    access: {
      workspaceAccess?: WorkspaceAccess
      linkRole?: LinkRole
      listed?: Listed
      password?: string
      /** Owner opt-in: the anonymous public page shows version history. */
      publicHistory?: boolean
    },
  ): Promise<{
    workspace_access: WorkspaceAccess
    link_role: LinkRole
    listed: Listed
    locked: boolean
    public_history: boolean
  }> =>
    f(`/v1/artifacts/${id}/access`, {
      ...opts(access),
      method: "PATCH",
    }).then(j),
  setLocked: (id: string, locked: boolean): Promise<{ locked: boolean }> =>
    f(`/v1/artifacts/${id}/locked`, {
      ...opts({ locked }),
      method: "PATCH",
    }).then(j),
  // Move to a different workspace you belong to. Owner-only server-side.
  moveArtifact: (id: string, targetOrgId: string): Promise<{ org_id: string }> =>
    f(`/v1/artifacts/${id}/move`, opts({ targetOrgId })).then(j),
  diff: (id: string, from: number, to: number): Promise<Diff> =>
    f(`/v1/artifacts/${id}/diff?from=${from}&to=${to}&format=json`, opts()).then(j),
  restore: (id: string, version: number): Promise<Artifact> =>
    f(`/v1/artifacts/${id}/restore`, opts({ version })).then(j),

  listProposals: (id: string, state?: ProposalState): Promise<{ proposals: Proposal[] }> =>
    f(`/v1/artifacts/${id}/proposals${state ? `?state=${state}` : ""}`, opts()).then(j),
  getProposal: (id: string, proposalId: string): Promise<Proposal> =>
    f(`/v1/artifacts/${id}/proposals/${proposalId}`, opts()).then(j),
  propose(id: string, text: string, filename: string, message: string): Promise<Proposal> {
    const fd = new FormData()
    fd.append("file", new File([text], filename))
    if (message) fd.append("message", message)
    return f(`/v1/artifacts/${id}/proposals`, {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j)
  },
  approveProposal: (
    id: string,
    proposalId: string,
    note?: string,
  ): Promise<Proposal & { published: number }> =>
    f(`/v1/artifacts/${id}/proposals/${proposalId}/approve`, opts({ note })).then(j),
  requestChanges: (id: string, proposalId: string, note?: string): Promise<Proposal> =>
    f(`/v1/artifacts/${id}/proposals/${proposalId}/request-changes`, opts({ note })).then(j),
  withdrawProposal: (id: string, proposalId: string): Promise<Proposal> =>
    f(`/v1/artifacts/${id}/proposals/${proposalId}/withdraw`, opts({})).then(j),

  listMembers: (
    id: string,
  ): Promise<{ default_role: Role; members: ArtifactMember[]; invites: ArtifactInvite[] }> =>
    f(`/v1/artifacts/${id}/members`, opts()).then(j),
  // `user` is a @username or an email; an email with no account behind it becomes a
  // pending emailed invite (kind: "invite") instead of a member.
  setMember: (id: string, user: string, role: Role): Promise<ShareResult> =>
    f(`/v1/artifacts/${id}/members`, { ...opts({ user, role }), method: "PUT" }).then(j),
  revokeArtifactInvite: (id: string, inviteId: string): Promise<void> =>
    f(`/v1/artifacts/${id}/invites/${inviteId}`, {
      method: "DELETE",
      credentials: "include",
    }).then(() => undefined),
  // The artifact-invite accept page: preview by token, then accept into the share.
  previewArtifactInvite: (token: string): Promise<ArtifactInvitePreview> =>
    f(`/v1/artifact-invites/${encodeURIComponent(token)}`, opts()).then(j),
  acceptArtifactInvite: (
    token: string,
    confirmMismatch?: boolean,
  ): Promise<{ short_id: string; role: Role }> =>
    f(
      `/v1/artifact-invites/${encodeURIComponent(token)}/accept`,
      opts(confirmMismatch ? { confirm_mismatch: true } : {}),
    ).then(j),
  removeMember: (id: string, userId: string): Promise<void> =>
    f(`/v1/artifacts/${id}/members/${userId}`, { method: "DELETE", credentials: "include" }).then(
      () => undefined,
    ),

  // The draft-claim page (/claim/$token): an agent published an anonymous expiring
  // draft and handed the human a claim link. Preview is public — the token itself
  // is the proof of standing; claiming moves the draft into the active workspace.
  previewDraftClaim: (token: string): Promise<DraftClaimPreview> =>
    f(`/v1/drafts/claim/${encodeURIComponent(token)}`, opts()).then(j),
  claimDraft: (token: string): Promise<{ short_id: string; url: string; org_id: string }> =>
    f("/v1/drafts/claim", opts({ token })).then(j),

  // Per-artifact vanity subdomains (`base` null when off) + the workspace's custom
  // domains shown read-only as the artifact's URL on each.
  listDomains: (
    id: string,
  ): Promise<{
    base: string | null
    domains: ArtifactDomain[]
    workspace_domains: { host: string; url: string }[]
  }> => f(`/v1/artifacts/${id}/domains`, opts()).then(j),
  setDomain: (id: string, label: string): Promise<ArtifactDomain> =>
    f(`/v1/artifacts/${id}/domains`, { ...opts({ label }), method: "PUT" }).then(j),
  removeDomain: (id: string, host: string): Promise<void> =>
    f(`/v1/artifacts/${id}/domains/${host}`, { method: "DELETE", credentials: "include" }).then(
      () => undefined,
    ),

  // Workspace custom domains (Cloudflare for SaaS), managed in settings.
  listWorkspaceDomains: (): Promise<{
    enabled: boolean
    cname_target: string | null
    domains: WorkspaceDomain[]
  }> => f("/v1/workspace/domains", opts()).then(j),
  addWorkspaceDomain: (host: string): Promise<WorkspaceDomain & { cname_target: string }> =>
    f("/v1/workspace/domains", opts({ host })).then(j),
  refreshWorkspaceDomain: (host: string): Promise<WorkspaceDomain> =>
    f(`/v1/workspace/domains/${host}/refresh`, opts({})).then(j),
  removeWorkspaceDomain: (host: string): Promise<void> =>
    f(`/v1/workspace/domains/${host}`, { method: "DELETE", credentials: "include" }).then(
      () => undefined,
    ),
  // Presence identity: a signed-in caller is resolved from their session server-side; an
  // anonymous caller carries their stable guest token (`?g=`) so the heartbeat and the SSE
  // stream agree on ONE viewer per browser (see lib/guest-id).
  heartbeat: (id: string): Promise<{ viewers: Viewer[] }> =>
    f(`/v1/artifacts/${id}/presence${guestQuery()}`, opts({})).then(j),

  favorite: (id: string, on: boolean): Promise<{ favorite: boolean }> =>
    f(`/v1/artifacts/${id}/favorite`, { ...opts(), method: on ? "PUT" : "DELETE" }).then(j),
  setTags: (id: string, tags: string[]): Promise<{ tags: string[] }> =>
    f(`/v1/artifacts/${id}/tags`, { ...opts({ tags }), method: "PUT" }).then(j),

  // Bulk organize — the library multi-select bar. Each is ONE call over a set of
  // short_ids; the server authorizes every artifact on its own and returns a
  // {ok, skipped, failed} tally (skipped = not yours to touch), so the client sends the
  // whole selection and shows what actually landed. Tags ADD (never replace); the server
  // computes the per-artifact union, so the client sends only the tags to add.
  bulkTags: (shortIds: string[], add: string[]): Promise<BulkSummary> =>
    f("/v1/bulk/tags", opts({ shortIds, add })).then(j),
  bulkFavorite: (shortIds: string[], favorite: boolean): Promise<BulkSummary> =>
    f("/v1/bulk/favorite", opts({ shortIds, favorite })).then(j),
  bulkAddToCollections: (shortIds: string[], collectionIds: string[]): Promise<BulkSummary> =>
    f("/v1/bulk/collections", opts({ shortIds, collectionIds })).then(j),
  bulkDelete: (shortIds: string[]): Promise<BulkSummary> =>
    f("/v1/bulk/delete", opts({ shortIds })).then(j),

  // Follows (track GitHub authors + repo path prefixes) — the activity feed is
  // listArtifacts({ scope: "following" }). All scoped to the active workspace.
  listFollows: (): Promise<{ follows: Follow[] }> => f("/v1/follows", opts()).then(j),
  // keepalive: a follow toggle is optimistic fire-and-forget, and the click often
  // immediately precedes a navigation (a palette result row navigates on select) —
  // without keepalive a full-document load aborts the POST mid-flight and the
  // follow silently never lands. Tiny body, well under the keepalive 64KB cap.
  addFollow: (kind: FollowKind, target: string): Promise<{ follow: Follow }> =>
    f("/v1/follows", { ...opts({ kind, target }), keepalive: true }).then(j),
  removeFollow: (kind: FollowKind, target: string): Promise<void> =>
    f("/v1/follows", {
      ...opts({ kind, target }),
      method: "DELETE",
      keepalive: true,
    }).then(() => undefined),

  deleteArtifact: (id: string): Promise<void> =>
    f(`/v1/artifacts/${id}`, { method: "DELETE", credentials: "include" }).then(() => undefined),

  report: (id: string, reason: string, detail?: string): Promise<{ ok: boolean }> =>
    f(`/v1/artifacts/${id}/report`, opts({ reason, detail })).then(j),
  listReports: (): Promise<{ reports: Report[]; open: number }> => f("/v1/reports", opts()).then(j),
  takedown: (id: string, note?: string): Promise<{ removed: boolean }> =>
    f(`/v1/artifacts/${id}/takedown`, opts({ note })).then(j),
  reinstate: (id: string): Promise<{ removed: boolean }> =>
    f(`/v1/artifacts/${id}/reinstate`, opts({})).then(j),
  dismissReport: (id: string): Promise<{ ok: boolean }> =>
    f(`/v1/reports/${id}/dismiss`, opts({})).then(j),

  listAgents: (): Promise<{ agents: Agent[] }> => f("/v1/agents", opts()).then(j),
  createAgent: (name: string, role?: Role): Promise<Agent & { token: string }> =>
    f("/v1/agents", opts({ name, role })).then(j),
  // Rotation is a credential event, never an identity event: the old bearer dies at
  // once; id, role, hosting, and attribution are untouched. Token shown only here.
  rotateAgent: (id: string): Promise<Agent & { token: string }> =>
    f(`/v1/agents/${id}/rotate`, opts({})).then(j),
  deleteAgent: (id: string): Promise<void> =>
    f(`/v1/agents/${id}`, { method: "DELETE", credentials: "include" }).then(() => undefined),

  // Automations + runs (the standing-agent-work surface; see routes/automations.ts).
  listAutomations: (): Promise<{ automations: Automation[] }> =>
    f("/v1/automations", opts()).then(j),
  // agentId omitted → the server auto-mints a MANAGED agent for this automation and
  // returns its bearer as agent_token, exactly once on this response.
  createAutomation: (input: {
    agentId?: string
    trigger: AutomationTrigger
    instruction: string
    /** Bare strings are artifact shorthand; the server stores canonical selectors. */
    refs?: (string | AutomationRef)[]
  }): Promise<Automation & { agent_token?: string }> => f("/v1/automations", opts(input)).then(j),
  updateAutomation: (
    id: string,
    input: {
      agentId?: string
      trigger?: AutomationTrigger
      instruction?: string
      refs?: (string | AutomationRef)[] | null
      enabled?: boolean
    },
  ): Promise<Automation> => f(`/v1/automations/${id}`, { ...opts(input), method: "PATCH" }).then(j),
  deleteAutomation: (id: string): Promise<void> =>
    f(`/v1/automations/${id}`, { method: "DELETE", credentials: "include" }).then(() => undefined),
  runAutomation: (id: string): Promise<{ id: string; status: string }> =>
    f(`/v1/automations/${id}/run`, opts({})).then(j),
  listRuns: (): Promise<{ runs: Run[] }> => f("/v1/workspace/runs", opts()).then(j),

  // Per-user model-plan credentials (the caller's own; see routes/model-credentials.ts).
  listModelCredentials: (): Promise<{ credentials: ModelCredentialHint[] }> =>
    f("/v1/me/model-credentials", opts()).then(j),
  connectModelCredential: (input: {
    provider: "claude-code" | "codex"
    kind: "oauth" | "api_key" | "login"
    token: string
  }): Promise<{ ok: true; provider: string; hint: string }> =>
    f("/v1/me/model-credentials", opts(input)).then(j),
  disconnectModelCredential: (provider: string): Promise<void> =>
    f(`/v1/me/model-credentials/${provider}`, { method: "DELETE", credentials: "include" }).then(
      () => undefined,
    ),

  // The workspace's SHARED model-plan pool (admin only) — the fallback billed when a run's
  // initiator has no plan and the agent isn't owner-lent. Same hints-only discipline.
  listPoolCredentials: (): Promise<{ credentials: ModelCredentialHint[] }> =>
    f("/v1/workspace/model-credentials", opts()).then(j),
  connectPoolCredential: (input: {
    provider: "claude-code" | "codex"
    kind: "oauth" | "api_key" | "login"
    token: string
  }): Promise<{ ok: true; provider: string; hint: string }> =>
    f("/v1/workspace/model-credentials", opts(input)).then(j),
  disconnectPoolCredential: (provider: string): Promise<void> =>
    f(`/v1/workspace/model-credentials/${provider}`, {
      method: "DELETE",
      credentials: "include",
    }).then(() => undefined),
  // Toggle whether an agent may fall back to its OWNER's plan (only the owner may set it).
  setAgentOwnerLend: (agentId: string, enabled: boolean): Promise<{ ok: true }> =>
    f(`/v1/workspace/owner-lend/${agentId}`, { ...opts({ enabled }), method: "PUT" }).then(j),

  // Contexts + sessions (the ask loop; see routes/contexts.ts server-side).
  listContexts: (): Promise<{ contexts: ContextInfo[] }> => f("/v1/contexts", opts()).then(j),
  getContext: (id: string): Promise<ContextInfo> => f(`/v1/contexts/${id}`, opts()).then(j),
  // agent_id omitted → the server auto-mints a MANAGED agent for this context and
  // returns its bearer as agent_token, exactly once on this response.
  createContext: (input: {
    name: string
    agent_id?: string
    manifest_short_id: string
  }): Promise<ContextInfo & { agent_token?: string }> => f("/v1/contexts", opts(input)).then(j),
  askContext: (
    id: string,
    body_md: string,
  ): Promise<{ session: Session; messages: SessionMessage[] }> =>
    f(`/v1/contexts/${id}/sessions`, opts({ body_md })).then(j),
  // Who may ask — workspace-scoped, never the manifest's artifact sharing.
  setContextAskPolicy: (id: string, ask_policy: "workspace" | "invited"): Promise<void> =>
    f(`/v1/contexts/${id}/access`, opts({ ask_policy })).then(() => undefined),
  listContextAskers: (
    id: string,
  ): Promise<{ askers: { user_id: string; username: string | null; added_at: string }[] }> =>
    f(`/v1/contexts/${id}/askers`, opts()).then(j),
  addContextAsker: (
    id: string,
    email: string,
  ): Promise<{ user_id: string; username: string | null; added_at: string }> =>
    f(`/v1/contexts/${id}/askers`, opts({ email })).then(j),
  removeContextAsker: (id: string, userId: string): Promise<void> =>
    f(`/v1/contexts/${id}/askers/${userId}`, { ...opts(), method: "DELETE" }).then(() => undefined),
  listContextSessions: (id: string): Promise<{ sessions: Session[] }> =>
    f(`/v1/contexts/${id}/sessions`, opts()).then(j),
  getSession: (
    id: string,
  ): Promise<{
    session: Session
    context: { id: string; name: string }
    messages: SessionMessage[]
  }> => f(`/v1/sessions/${id}`, opts()).then(j),
  postSessionMessage: (id: string, body_md: string): Promise<{ message: SessionMessage }> =>
    f(`/v1/sessions/${id}/messages`, opts({ body_md })).then(j),
  closeSession: (id: string): Promise<{ session: Session }> =>
    f(`/v1/sessions/${id}`, { ...opts({ state: "closed" }), method: "PATCH" }).then(j),

  // GitHub sync: mirror a repo's Markdown/HTML into a collection (one-way).
  // Status carries the connected sources, whether the instance GitHub App is set
  // up, and this workspace's installations (so the UI can jump to the picker).
  githubSync: (): Promise<GithubSyncStatus> => f("/v1/sync/github", opts()).then(j),
  connectRepoSource: (input: {
    repo: string
    ref?: string
    includes?: string
    token?: string
    installation_id?: string
  }): Promise<RepoSource> => f("/v1/sync/github", opts(input)).then(j),
  // The GitHub App install URL; navigate the browser there to pick repos.
  githubInstallUrl: (): Promise<{ url: string }> => f("/v1/sync/github/install", opts({})).then(j),
  // Re-seed github_installation rows from GitHub's live install list (recovery path).
  resyncInstallations: (): Promise<{ synced: number }> =>
    f("/v1/sync/github/resync-installations", opts({})).then(j),
  // Repos a given installation can mirror (drives the repo picker).
  listInstallationRepos: (installationId: string): Promise<{ repos: InstallationRepo[] }> =>
    f(`/v1/sync/github/installations/${installationId}/repos`, opts()).then(j),
  // How many docs a repo+scope would mirror (live count in the picker).
  previewRepo: (installationId: string, repo: string, includes?: string): Promise<SyncPreview> => {
    const qs = new URLSearchParams({ repo })
    if (includes) qs.set("includes", includes)
    return f(`/v1/sync/github/installations/${installationId}/preview?${qs}`, opts()).then(j)
  },
  // Trigger a sync. The work runs on the server (a Durable Object on the edge, a
  // detached loop on Node), so this returns at once — poll `syncStatus` for the bar.
  runRepoSync: (id: string): Promise<RepoSource> =>
    f(`/v1/sync/github/${id}/run`, opts({})).then(j),
  // Cheap status poll for the live progress bar (no GitHub round-trip).
  syncStatus: (id: string): Promise<SyncStatus> =>
    f(`/v1/sync/github/${id}/status`, opts()).then(j),
  // Sources currently mid-sync in this workspace (drives the global progress chip).
  activeSyncs: (): Promise<{ active: RepoSource[] }> => f("/v1/sync/github/active", opts()).then(j),
  deleteRepoSource: (id: string, wipe?: boolean): Promise<void> =>
    f(`/v1/sync/github/${id}${wipe ? "?wipe=true" : ""}`, {
      method: "DELETE",
      credentials: "include",
    }).then(() => undefined),

  // Integration switches (enable/disable each channel) — Admin to change.
  getWorkspaceSettings: (): Promise<OrgSettings> => f("/v1/workspace/settings", opts()).then(j),
  updateWorkspaceSettings: (patch: Partial<OrgSettings>): Promise<OrgSettings> =>
    f("/v1/workspace/settings", { ...opts(patch), method: "PATCH" }).then(j),

  // Billing: plan truth (any member can read), checkout, and the Stripe portal
  // (both Admin only).
  getBilling: (): Promise<BillingInfo> => f("/v1/billing", opts()).then(j),
  startCheckout: (
    tier: "team" | "business",
    interval: "month" | "year",
  ): Promise<{ url: string }> =>
    f("/v1/billing/checkout", { ...opts({ tier, interval }), method: "POST" }).then(j),
  openBillingPortal: (): Promise<{ url: string }> =>
    f("/v1/billing/portal", { ...opts({}), method: "POST" }).then(j),

  // Slack App: status, set default channel, disconnect. Connect is a redirect to
  // /v1/slack/install (a full-page navigation, not a fetch).
  getSlack: (): Promise<SlackStatus> => f("/v1/slack", opts()).then(j),
  setSlackChannel: (default_channel: string | null): Promise<{ default_channel: string | null }> =>
    f("/v1/slack", { ...opts({ default_channel }), method: "PATCH" }).then(j),
  disconnectSlack: (): Promise<void> =>
    f("/v1/slack", { method: "DELETE", credentials: "include" }).then(() => undefined),
  setSlackDm: (slack_dm: boolean): Promise<{ slack_dm: boolean }> =>
    f("/v1/slack/prefs", { ...opts({ slack_dm }), method: "PATCH" }).then(j),
  sendSlackTestDm: (): Promise<{ ok: boolean }> =>
    f("/v1/slack/test-dm", { ...opts({}), method: "POST" }).then(j),
  // Link is a redirect to /v1/slack/link (full-page navigation); only unlink is a fetch.
  unlinkSlack: (): Promise<void> =>
    f("/v1/slack/link", { method: "DELETE", credentials: "include" }).then(() => undefined),

  // Workspace name + members (Admin / Creator / Viewer = owner / editor / commenter)
  getWorkspace: (): Promise<Workspace> => f("/v1/workspace", opts()).then(j),
  renameWorkspace: (name: string): Promise<{ name: string }> =>
    f("/v1/workspace", { ...opts({ name }), method: "PATCH" }).then(j),
  addWorkspaceMember: (user: string, role: Role): Promise<ArtifactMember> =>
    f("/v1/workspace/members", { ...opts({ user, role }), method: "PUT" }).then(j),
  // Bring someone in by @handle or email: an existing account joins directly, an unknown
  // email gets a pending, emailed invitation (accept_url returned so it's copyable too).
  inviteToWorkspace: (email: string, role: Role): Promise<InviteResult> =>
    f("/v1/workspace/invites", opts({ email, role })).then(j),
  listWorkspaceInvites: (): Promise<{ invites: Invite[] }> =>
    f("/v1/workspace/invites", opts()).then(j),
  revokeWorkspaceInvite: (id: string): Promise<void> =>
    f(`/v1/workspace/invites/${id}`, { method: "DELETE", credentials: "include" }).then(
      () => undefined,
    ),
  // The accept page: preview an invite by token, then join.
  previewInvite: (token: string): Promise<InvitePreview> =>
    f(`/v1/invites/${encodeURIComponent(token)}`, opts()).then(j),
  // confirmMismatch: the holder is signed in under a different email than the
  // invite named — the server 409s until they explicitly accept anyway.
  acceptInvite: (
    token: string,
    confirmMismatch?: boolean,
  ): Promise<{ org_id: string; role: Role }> =>
    f(
      `/v1/invites/${encodeURIComponent(token)}/accept`,
      opts(confirmMismatch ? { confirm_mismatch: true } : {}),
    ).then(j),
  setWorkspaceMemberRole: (userId: string, role: Role): Promise<{ user_id: string; role: Role }> =>
    f(`/v1/workspace/members/${userId}`, { ...opts({ role }), method: "PATCH" }).then(j),
  removeWorkspaceMember: (userId: string): Promise<void> =>
    f(`/v1/workspace/members/${userId}`, { method: "DELETE", credentials: "include" }).then(
      () => undefined,
    ),

  // Multi-workspace: list / create / switch (the switcher; dormant in single mode)
  listWorkspaces: (): Promise<Workspaces> => f("/v1/workspaces", opts()).then(j),
  createWorkspace: (name: string): Promise<WorkspaceSummary> =>
    f("/v1/workspaces", opts({ name })).then(j),
  switchWorkspace: (id: string): Promise<{ active: string }> =>
    f("/v1/workspace/switch", opts({ id })).then(j),
  deleteWorkspace: (id: string): Promise<{ deleted: string; active: string | null }> =>
    f(`/v1/workspaces/${id}`, { method: "DELETE", credentials: "include" }).then(j),

  // Collections (shareable groups; sharing grants the role on every item)
  listCollections: (): Promise<{ collections: Collection[] }> =>
    f("/v1/collections", opts()).then(j),
  createCollection: (title: string): Promise<Collection> =>
    f("/v1/collections", opts({ title })).then(j),
  renameCollection: (id: string, title: string): Promise<Collection> =>
    f(`/v1/collections/${id}`, { ...opts({ title }), method: "PATCH" }).then(j),
  deleteCollection: (id: string): Promise<void> =>
    f(`/v1/collections/${id}`, { method: "DELETE", credentials: "include" }).then(() => undefined),
  // Change a collection's share experience — the Share dialog's Invited/Workspace
  // toggle. Same one-question shape as an artifact's setAccess, no link_role/listed.
  setCollectionAccess: (
    id: string,
    workspaceAccess: WorkspaceAccess,
  ): Promise<{ workspace_access: WorkspaceAccess }> =>
    f(`/v1/collections/${id}/access`, { ...opts({ workspaceAccess }), method: "PATCH" }).then(j),
  addToCollection: (collectionId: string, shortId: string): Promise<void> =>
    f(`/v1/collections/${collectionId}/items/${shortId}`, { ...opts(), method: "PUT" }).then(
      () => undefined,
    ),
  // Folders organize a collection's artifacts (grant no access). Management is gated on
  // the collection's editor role server-side — the UI hides it for non-editors.
  collectionFolders: (
    collectionId: string,
  ): Promise<{ folders: Folder[]; assignments: Record<string, string> }> =>
    f(`/v1/collections/${collectionId}/folders`, opts()).then(j),
  createFolder: (collectionId: string, name: string): Promise<Folder> =>
    f(`/v1/collections/${collectionId}/folders`, opts({ name })).then(j),
  renameFolder: (id: string, name: string): Promise<Folder> =>
    f(`/v1/folders/${id}`, { ...opts({ name }), method: "PATCH" }).then(j),
  deleteFolder: (id: string): Promise<void> =>
    f(`/v1/folders/${id}`, { method: "DELETE", credentials: "include" }).then(() => undefined),
  // File an artifact (within a collection) under a folder, or null to unfile.
  setItemFolder: (collectionId: string, shortId: string, folderId: string | null): Promise<void> =>
    f(`/v1/collections/${collectionId}/items/${shortId}/folder`, {
      ...opts({ folderId }),
      method: "PUT",
    }).then(() => undefined),
  removeFromCollection: (collectionId: string, shortId: string): Promise<void> =>
    f(`/v1/collections/${collectionId}/items/${shortId}`, {
      method: "DELETE",
      credentials: "include",
    }).then(() => undefined),
  listCollectionMembers: (id: string): Promise<{ created_by: string; members: ArtifactMember[] }> =>
    f(`/v1/collections/${id}/members`, opts()).then(j),
  setCollectionMember: (id: string, user: string, role: Role): Promise<ArtifactMember> =>
    f(`/v1/collections/${id}/members`, { ...opts({ user, role }), method: "PUT" }).then(j),
  removeCollectionMember: (id: string, userId: string): Promise<void> =>
    f(`/v1/collections/${id}/members/${userId}`, {
      method: "DELETE",
      credentials: "include",
    }).then(() => undefined),

  listWebhooks: (): Promise<{ webhooks: Webhook[] }> => f("/v1/webhooks", opts()).then(j),
  createWebhook: (body: {
    url: string
    kind: "generic" | "slack"
    events?: string[]
    label?: string
    artifact?: string
  }): Promise<Webhook> => f("/v1/webhooks", opts(body)).then(j),
  deleteWebhook: (id: string): Promise<void> =>
    f(`/v1/webhooks/${id}`, { method: "DELETE", credentials: "include" }).then(() => undefined),
  testWebhook: (id: string): Promise<unknown> => f(`/v1/webhooks/${id}/test`, opts({})).then(j),
  webhookDeliveries: (id: string): Promise<{ deliveries: Delivery[] }> =>
    f(`/v1/webhooks/${id}/deliveries`, opts()).then(j),
  recordView: (id: string, version?: number): Promise<void> =>
    f(`/v1/artifacts/${id}/view`, opts({ version })).then(() => undefined),
  analytics: (id: string): Promise<Analytics> => f(`/v1/artifacts/${id}/analytics`, opts()).then(j),
  listComments: (id: string): Promise<{ comments: Comment[] }> =>
    f(`/v1/artifacts/${id}/comments`, opts()).then(j),
  comment: (
    id: string,
    body: {
      body_md: string
      thread_id?: string
      anchor?: unknown
      mentions?: Mention[]
    },
  ): Promise<Comment> => f(`/v1/artifacts/${id}/comments`, opts(body)).then(j),
  // Review rounds (the /derive loop). getReview → the pending round + history;
  // sendBack / approve settle the pending round (the sidebar review card's buttons).
  getReview: (id: string): Promise<{ pending: ReviewRound | null; rounds: ReviewRound[] }> =>
    f(`/v1/artifacts/${id}/review`, opts()).then(j),
  sendBackReview: (id: string, note?: string): Promise<{ round: ReviewRound }> =>
    f(`/v1/artifacts/${id}/review/send-back`, opts({ note })).then(j),
  approveReview: (id: string, note?: string): Promise<{ round: ReviewRound }> =>
    f(`/v1/artifacts/${id}/review/approve`, opts({ note })).then(j),
  resolve: (id: string, commentId: string, state: "open" | "resolved") =>
    f(`/v1/artifacts/${id}/comments/${commentId}/resolve`, opts({ state })).then(j),
  react: (id: string, commentId: string, emoji: string): Promise<Comment> =>
    f(`/v1/artifacts/${id}/comments/${commentId}/react`, opts({ emoji })).then(j),
  editComment: (id: string, commentId: string, body_md: string): Promise<Comment> =>
    f(`/v1/artifacts/${id}/comments/${commentId}`, { ...opts({ body_md }), method: "PATCH" }).then(
      j,
    ),
  deleteComment: (id: string, commentId: string): Promise<Comment> =>
    f(`/v1/artifacts/${id}/comments/${commentId}`, {
      method: "DELETE",
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j),

  // Ask a registered agent to rework the artifact to match the Brandprint. The canned
  // instruction lives server-side; omit agentId when exactly one agent is registered.
  reworkArtifact: (shortId: string, agentId?: string): Promise<{ requestId: string }> =>
    f(`/v1/artifacts/${shortId}/rework`, opts(agentId ? { agentId } : {})).then(j),
  // Ask a registered agent to build the workspace's brand profile (shortId must be the
  // profile artifact). Same queue mechanics as reworkArtifact, different canned brief.
  generateProfile: (shortId: string, agentId?: string): Promise<{ requestId: string }> =>
    f(`/v1/artifacts/${shortId}/generate-profile`, opts(agentId ? { agentId } : {})).then(j),

  // ---- Mention directory + in-app notifications -------------------------
  // `artifact` (a short_id) scopes the directory to that thread's people —
  // workspace members + collaborators + everyone who has commented — so you can
  // @ someone on the thread even if they're not in your workspace.
  users: (q?: string, artifact?: string): Promise<{ users: DirUser[] }> => {
    const p = new URLSearchParams()
    if (q) p.set("query", q)
    if (artifact) p.set("artifact", artifact)
    const qs = p.toString()
    return f(`/v1/users${qs ? `?${qs}` : ""}`, opts()).then(j)
  },
  notifications: (): Promise<{ notifications: Notification[]; unread: number }> =>
    f("/v1/notifications", opts()).then(j),
  markNotificationsRead: (sel: { ids: string[] } | { all: true }): Promise<{ unread: number }> =>
    f("/v1/notifications/read", opts(sel)).then(j),
  notificationsStreamUrl: (): string => u("/v1/notifications/events"),

  async publish(file: File, fields: Record<string, string> = {}, id?: string): Promise<Artifact> {
    const fd = new FormData()
    fd.append("file", file)
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    const path = id ? `/v1/artifacts/${id}/versions` : "/v1/artifacts"
    return f(path, {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j)
  },
  // `title` renames the artifact on this republish (the editor's editable title);
  // omit it to leave the name unchanged.
  publishText(
    id: string,
    text: string,
    filename: string,
    message: string,
    title?: string,
  ): Promise<Artifact> {
    const fields: Record<string, string> = { message }
    if (title?.trim()) fields.title = title.trim()
    return this.publish(new File([text], filename), fields, id)
  },
  // Quote-scoped edits (the inline editor): each edit is located by the rendered
  // text ({exact, prefix, suffix}) and resolved server-side against the stored
  // source. base_version turns a concurrent publish into a 409 instead of a
  // silently mis-placed splice.
  publishEdits(
    id: string,
    edits: QuoteEditInput[],
    baseVersion: number,
    message: string,
  ): Promise<Artifact> {
    const fd = new FormData()
    fd.append("edits", JSON.stringify(edits))
    fd.append("base_version", String(baseVersion))
    if (message) fd.append("message", message)
    return f(`/v1/artifacts/${id}/versions`, {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j)
  },
  // The commenter path: the same quote edits, filed as a proposal for review.
  proposeEdits(
    id: string,
    edits: QuoteEditInput[],
    baseVersion: number,
    message: string,
  ): Promise<Proposal> {
    const fd = new FormData()
    fd.append("edits", JSON.stringify(edits))
    fd.append("base_version", String(baseVersion))
    if (message) fd.append("message", message)
    return f(`/v1/artifacts/${id}/proposals`, {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { accept: "application/json" },
    }).then(j)
  },

  // --- Connected sources (plain /v1 routes, hand-written client) ------------------------
  connections(): Promise<Connection[]> {
    return f("/v1/connections?mine=1", opts())
      .then(j)
      .then((r) => r.connections as Connection[])
  },
  connect(toolkit: string): Promise<Connection & { connect_url: string }> {
    return f("/v1/connections", opts({ toolkit })).then(j)
  },
  /** Connect an MCP server as a source. The server is contacted immediately and its tool list
   *  pinned, so a 201 here means it really answered — not that a row was stored hopefully. */
  connectMcp(input: {
    toolkit: string
    mcp_url: string
    mcp_secret?: string
  }): Promise<Connection> {
    return f("/v1/connections", opts(input)).then(j)
  },
  async revokeConnection(id: string): Promise<void> {
    const r = await f(`/v1/connections/${id}`, { credentials: "include", method: "DELETE" })
    if (!r.ok) throw new ApiError("Couldn't revoke the connection.", r.status)
  },
}
