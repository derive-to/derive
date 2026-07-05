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
}
/** A public profile, by handle. Email is private and never returned here. */
export interface PublicProfile {
  username: string
  name: string | null
  image: string | null
  /** Coarse team role; null if unset. (People-search results omit `about`.) */
  profession?: string | null
  /** One-line "what you do" blurb; only present on the full /users/:handle profile. */
  about?: string | null
  /** GitHub login, when known (the full /users/:handle profile only); null otherwise. */
  github_login?: string | null
  /** Work / follower / following counts (the full /users/:handle profile only). */
  stats?: { works: number; followers: number; following: number }
  /** Whether the signed-in viewer already follows this person (full profile only). */
  followed_by_me?: boolean
}
export interface VersionSession {
  n: number
  from_n: number
  count: number
  author: string
  name: string | null
  created_at: string
}
export type Role = "viewer" | "commenter" | "editor" | "owner"
/** What general access (the link) grants a reacher: view-only or comment. */
export type GeneralRole = "viewer" | "commenter"
export interface Artifact {
  short_id: string
  url: string
  title: string | null
  kind: "file" | "bundle"
  current_content_type?: string | null
  /** Locked: direct publishes are rejected; even editors must propose changes. */
  locked?: boolean
  visibility: string
  /** The role the general-access link grants (view vs comment). Anonymous reachers are
   *  always clamped to view regardless; commenting requires signing in. */
  general_role?: GeneralRole
  current_version: number
  versions: {
    n: number
    content_type?: string
    author: string
    /** The GitHub identity behind this version (sync only): login, avatar URL, numeric
     *  user id (text). Null for manual/anonymous/unmappable publishes. */
    author_login?: string | null
    author_avatar?: string | null
    author_gh_id?: string | null
    /** The Derive handle of this version's GitHub author, when they signed in with GitHub
     *  (single-artifact detail only); null otherwise. */
    handle?: string | null
    message: string | null
    name: string | null
    created_at: string
  }[]
  /** Time-grouped view of versions for display; newest-first. */
  sessions?: VersionSession[]
  views?: number
  /** The current caller's effective role on this artifact (null = no access). */
  my_role?: Role | null
  /** Browse tags (workspace-wide). */
  tags?: string[]
  /** Whether the current user has starred this artifact. */
  favorite?: boolean
  /** Count of proposals awaiting review. */
  open_proposals?: number
  /** Count of non-withdrawn proposals (open + decided) — gates the Proposals entry. */
  proposals_total?: number
  /** Open comment threads on this artifact (drives the inline comment indicator). */
  open_threads?: number
  /** An open thread on this artifact @mentions the current user — "needs your feedback". */
  mentions_me?: boolean
  /** The current user authored a comment in an open thread on this artifact. */
  i_participated?: boolean
  /** Collection ids this artifact belongs to (detail endpoint). */
  collections?: string[]
  /** Taken down by a moderator: the content is gone (410), the record stays. */
  removed?: boolean
  /** Mirrored from a GitHub sync source → read-only in Derive (Edit/Propose hidden). */
  managed?: boolean
  /** Present when this bundle's entry is markdown — a skill (entry SKILL.md) or a
   *  plain docs folder. Drives the file tree + (for skills) the identity chrome.
   *  Detail endpoint only; absent for HTML "site" bundles. */
  bundle?: {
    /** True when it's a Claude Code skill (entry SKILL.md) — gates the "Skill" badge. */
    isSkill: boolean
    /** Skill frontmatter name/description; null for a plain docs bundle. */
    name: string | null
    description: string | null
    /** Entry document path, sans leading slash (e.g. "SKILL.md", "README.md"). */
    entry: string
    files: { path: string; type: string }[]
  }
  /** Repo path for a synced artifact (e.g. "docs/plans/foo.md") — drives the folder view. */
  source_path?: string | null
  /** First-published time. */
  created_at?: string
  /** Last-updated time (set on each new version; null until versioned). Read as
   *  `updated_at ?? created_at`. Drives the recency sort + the "updated X" label. */
  updated_at?: string | null
  /** The CURRENT (last) author, denormalized — for a GitHub-synced artifact these mirror
   *  the last commit's author. Drives "who last changed this" + the ?author= filter. */
  author_name?: string | null
  author_login?: string | null
  author_avatar?: string | null
  author_gh_id?: string | null
  /** The current author resolved to a profile: the raw GitHub identity plus the Derive
   *  `handle` (username) when the committer signed in with GitHub. Null when there's no
   *  recorded author. Prefer this over the raw fields for rendering. */
  author?: {
    name: string | null
    login: string | null
    avatar: string | null
    handle: string | null
  } | null
}
export interface Report {
  id: string
  artifact_id: string
  artifact_short_id: string
  reason: string
  detail: string | null
  reporter: string | null
  state: "open" | "actioned" | "dismissed"
  created_at: string
}
export interface Collection {
  id: string
  title: string
  created_by: string
  created_at: string
  count: number
  /** Where the collection came from: "repo" = a GitHub repo mirror, "pr" = a
   *  read-only PR preview nested under its repo, "manual" = user-created. Absent on
   *  older responses → treat as "manual". */
  kind?: "manual" | "repo" | "pr"
  /** For a PR preview: the repo collection it nests under (when that repo is still
   *  connected). Drives the sidebar hierarchy. */
  parentId?: string
  /** For a PR preview: the pull-request number. */
  prNumber?: number
  /** For repo/PR collections: "owner/name". */
  repo?: string
}
export type FollowKind = "author" | "path" | "user"
/** A per-user follow: a GitHub author (kind="author", target=login), a repo path
 *  prefix (kind="path", target=path prefix), or a person (kind="user", target=username
 *  on the wire). Drives the `scope=following` feed. */
export interface Follow {
  id: string
  org_id: string
  user_id: string
  kind: FollowKind
  /** For author/path: the login / path prefix. For user: the followed person's id. */
  target: string
  created_at: string
  /** Present for kind="user": the followed person's public handle/name/avatar, resolved
   *  server-side so the client renders them (and matches follow-state) without raw ids. */
  handle?: string | null
  name?: string | null
  image?: string | null
}
export type ProposalState = "open" | "approved" | "changes_requested" | "withdrawn"
export interface Proposal {
  id: string
  state: ProposalState
  author: string
  message: string | null
  base_version: number
  kind: "file" | "bundle"
  decided_by: string | null
  decided_version: number | null
  /** The reviewer's feedback when approving or requesting changes. */
  decision_note: string | null
  decided_at: string | null
  created_at: string
  /** The proposed experience, rendered exactly like a live version. */
  preview_url: string
  /** Present on the single-proposal fetch: line diff vs the base version. */
  diff?: { base_version: number; ops: DiffOp[] }
}
export interface ArtifactMember {
  user_id: string
  /** Public handle; null only for a legacy account not yet backfilled. No email —
   *  the member list identifies collaborators by handle, never by address. */
  handle: string | null
  name: string | null
  /** Coarse team role (Product / Engineering / …); null if unset. Shown in member
   *  lists; absent on artifact/collection member payloads that don't join it. */
  profession?: string | null
  role: Role
}
/** A DNS record the customer adds to validate a custom domain. */
export interface DomainDnsRecord {
  type: string
  name: string
  value: string
}
/** A vanity subdomain bound to one artifact (the per-artifact share section). */
export interface ArtifactDomain {
  host: string
  url: string
  kind: string
  status: string
  created_at: string
}
/** A workspace custom domain (managed in settings; Cloudflare for SaaS). */
export interface WorkspaceDomain {
  host: string
  status: string
  /** DNS records to add while pending (undefined once active). */
  records?: DomainDnsRecord[]
  created_at: string
}
/** The workspace: its name, the caller's role, and the member directory. */
export interface Workspace {
  id: string
  name: string
  role: Role
  members: ArtifactMember[]
}
/** Per-workspace integration switches (mirrors the server's OrgSettings). */
export interface OrgSettings {
  emailNotifications: boolean
  githubPostComments: boolean
  githubMirrorComments: boolean
  githubPreviewLink: boolean
  slackPost: boolean
}
/** Slack connection status for the Settings UI. */
export interface SlackStatus {
  available: boolean
  connected: boolean
  team_name: string | null
  default_channel: string | null
}
/** One entry in the workspace switcher. */
export interface WorkspaceSummary {
  id: string
  name: string
  role: Role
}
/** The switcher payload: whether multi-workspace is on, the active id, the list. */
export interface Workspaces {
  multi: boolean
  active: string
  workspaces: WorkspaceSummary[]
}
export interface Analytics {
  total: number
  unique: number
  anonViewers: number
  perVersion: { version: number; count: number }[]
  daily: { day: string; count: number }[]
  recent: { viewer: string; kind: "user" | "anon"; at: string; avatar?: string | null }[]
}
/** A resolved @mention: the picked user's id + the display name shown inline. */
export interface Mention {
  id: string
  name: string
}
/** A review round: the agent asked this person to review a version, and polls for
 *  the answer. `pending` = waiting; `sent_back` = they returned answers; `approved`. */
export interface ReviewRound {
  id: string
  artifact_id: string
  version: number
  requested_by: string
  requested_for: string
  state: "pending" | "sent_back" | "approved"
  note: string | null
  created_at: string
  resolved_at: string | null
}

export interface Comment {
  id: string
  thread_id: string
  base_version: number
  path: string | null
  anchor: string | null
  body_md: string
  author: string
  // `addressed` = a proposed revision citing this thread is pending review.
  // `outdated` = the quoted text this thread anchored to changed in a later
  // version (set by the server's re-anchor sweep); the feedback may no longer apply.
  state: "open" | "addressed" | "resolved" | "outdated"
  created_at: string
  anchored?: boolean
  reactions?: Record<string, string[]>
  edited?: boolean
  edited_at?: string | null
  deleted?: boolean
  mentions?: Mention[]
}
/** A person/agent offered by the @mention picker — identified by @handle, never email. */
export interface DirUser {
  id: string
  name: string | null
  handle: string | null
}
export interface Notification {
  id: string
  user_id: string
  /** Who triggered it. For `follow`/`publish` this is the person's @handle. */
  actor: string
  kind: "mention" | "comment" | "share" | "follow" | "publish"
  artifact_id: string
  artifact_short_id: string
  artifact_title: string | null
  thread_id: string
  comment_id: string
  preview: string
  read: 0 | 1
  created_at: string
}
export interface Webhook {
  id: string
  artifact_id: string | null
  url: string
  kind: "generic" | "slack"
  events: string
  label: string | null
  active: 0 | 1
  created_at: string
}
export interface Agent {
  id: string
  name: string
  role: Role
  created_at: string
}
/** An askable agent setup: a registered agent wired to a manifest artifact. */
export interface ContextInfo {
  id: string
  name: string
  agent_id: string
  manifest_short_id: string | null
  created_by: string
  created_at: string
}
export type SessionState = "open" | "answered" | "escalated" | "failed" | "closed"
/** The runner's structured payload on an agent message (parsed server-side). */
export interface SessionMeta {
  query?: string | null
  confidence?: number | null
  caveats?: string[]
  escalation_reason?: string | null
}
export interface SessionMessage {
  id: string
  author_kind: "asker" | "agent"
  author_id: string
  body_md: string
  meta: SessionMeta | null
  created_at: string
}
export interface Session {
  id: string
  context_id: string
  asker_id: string
  context_version: number
  state: SessionState
  created_at: string
  updated_at: string
}
/** A live viewer of an artifact (presence). Identified by a handle-style `name`
 *  (never email — presence is broadcast to anonymous co-viewers); `role` is their
 *  effective role here. */
export interface Viewer {
  id: string
  name: string
  role: string | null
}
export interface Delivery {
  id: string
  event_type: string
  status: "pending" | "delivered" | "dead"
  attempts: number
  last_error: string | null
  created_at: string
}
/** A GitHub repo mirrored into a collection (token redacted, file map collapsed
 *  to a count by the API). */
export interface RepoSource {
  id: string
  collection_id: string
  repo: string
  ref: string
  includes: string
  token: string | null
  installation_id: string | null
  last_synced_at: string | null
  last_status: string | null
  created_by: string
  created_at: string
  file_count: number
  /** Live sync state as a JSON string (parse with `parseProgress`); null when idle. */
  progress: string | null
}
/** Live, pollable sync progress — the engine writes this every batch; the UI bar +
 *  global chip read it. `done`/`total` are doc counts; `phase` drives the wording. */
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
/** The cheap status-poll response (no GitHub round-trip) that drives the progress bar. */
export interface SyncStatus {
  id: string
  repo: string
  progress: string | null
  last_status: string | null
  last_synced_at: string | null
  file_count: number
}
export interface GithubInstallation {
  installation_id: string
  account_login: string | null
}
/** A read-only preview of an open pull request's changed docs, mirrored into its own
 *  collection ("PR #<n>: <title>"). Links out to the PR and into the Derive collection. */
export interface PrPreview {
  id: string
  collection_id: string
  repo: string
  pr_number: number
  title: string
  last_status: string | null
  last_synced_at: string | null
  file_count: number
  progress: string | null
}
export interface GithubSyncStatus {
  sources: RepoSource[]
  prs: PrPreview[]
  app: {
    configured: boolean
    slug?: string
    /** False when the live App lacks a permission/event Derive now requires. */
    upToDate?: boolean
    /** The scopes/events still to grant: { permissions: {scope: level}, events: [] }. */
    missing?: { permissions: Record<string, string>; events: string[] }
    /** Deep-link to the App's GitHub permissions editor (owner toggles + saves). */
    permissionsUrl?: string
    /** Deep-link that surfaces the pending-approval prompt on an existing install. */
    approveUrl?: string
  }
  installations: GithubInstallation[]
}
export interface InstallationRepo {
  full_name: string
  private: boolean
  default_branch: string
  /** Last push (ISO), or null. Server returns repos sorted most-recent-first. */
  pushed_at: string | null
}
/** A repo+scope preview: how many docs would mirror, split by type. */
export interface SyncPreview {
  total: number
  md: number
  html: number
  other: number
  truncated: boolean
}
export interface SyncResult {
  added: number
  updated: number
  removed: number
  renamed: number
  skipped: number
  /** Matching docs still pending after this batch (>0 → call run again). */
  remaining: number
}
export interface DiffOp {
  t: "ctx" | "add" | "del"
  line: string
}
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
// password artifact means "prompt for the password", not "not found").
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
const j = async (r: Response) => {
  if (!r.ok)
    throw new ApiError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`, r.status)
  return r.json()
}
const opts = (body?: unknown): RequestInit => ({
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

// Map Better Auth's session user onto our Me (discoverable defaults on). Shared
// by session() and me() so the shape is defined once.
type SessionUser = {
  id: string
  email: string
  name?: string | null
  username?: string | null
  image?: string | null
  discoverable?: boolean
  profession?: string | null
  about?: string | null
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
})

export const api = {
  // The session read behind meQuery. Prerender-safe (null at build — no document);
  // a resolved null for an anon visitor (401, or a 200 with no user); a mapped Me
  // when signed in; and a THROWN transient ApiError on a 5xx so the query's retry
  // can self-heal. Distinguishing anon (null) from a blip (throw) is what lets the
  // auth query resolve cleanly instead of dead-ending — unlike me(), which throws
  // for both.
  async session(): Promise<Me | null> {
    if (typeof document === "undefined") return null
    const r = await f("/api/auth/get-session", { credentials: "include" })
    if (r.status === 401) return null
    if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status)
    const s = await r.json().catch(() => null)
    return s?.user ? mapMe(s.user) : null
  },
  async me(): Promise<{ user: Me }> {
    const s = await f("/api/auth/get-session", { credentials: "include" }).then((r) =>
      r.ok ? r.json() : null,
    )
    if (!s?.user) throw new Error("unauthenticated")
    return { user: mapMe(s.user) }
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
  ): Promise<{ artifacts: Artifact[]; next_cursor: string | null }> => {
    const qs = new URLSearchParams()
    if (cursor) qs.set("cursor", cursor)
    if (limit) qs.set("limit", String(limit))
    const s = qs.toString()
    return f(`/v1/users/${encodeURIComponent(handle)}/artifacts${s ? `?${s}` : ""}`, {
      credentials: "include",
    }).then(j)
  },
  // People who follow / are followed by this user (public profiles; no ids or email).
  profileFollowers: (handle: string): Promise<{ users: PublicProfile[] }> =>
    f(`/v1/users/${encodeURIComponent(handle)}/followers`, { credentials: "include" }).then(j),
  profileFollowing: (handle: string): Promise<{ users: PublicProfile[] }> =>
    f(`/v1/users/${encodeURIComponent(handle)}/following`, { credentials: "include" }).then(j),
  // Set your team role + "what you do" blurb (onboarding + Settings → Profile).
  // Omitted fields are left untouched; "" clears a field.
  setProfile: (fields: {
    profession?: string
    about?: string
  }): Promise<{ profession: string | null; about: string | null }> =>
    f("/v1/me/profile", opts(fields)).then(j),
  // Opt in/out of people search.
  setDiscoverable: (discoverable: boolean): Promise<{ discoverable: boolean }> =>
    f("/v1/me/discoverable", opts({ discoverable })).then(j),
  // Find opted-in people by @handle or name (signed-in; empty q → []).
  searchPeople: (q: string): Promise<{ users: PublicProfile[] }> =>
    f(`/v1/users/search?query=${encodeURIComponent(q)}`, opts()).then(j),
  // The People directory: browse opted-in people (empty q) or search them (signed-in).
  // Unlike searchPeople, an empty query BROWSES the discoverable set.
  people: (q?: string): Promise<{ users: PublicProfile[] }> =>
    f(`/v1/people${q ? `?query=${encodeURIComponent(q)}` : ""}`, opts()).then(j),
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
  // Which social providers are configured server-side (drives the login buttons).
  authProviders: (): Promise<{ google: boolean; github: boolean }> =>
    f("/v1/auth/providers", opts()).then(j),
  // Better Auth social sign-in: POST returns the provider authorize URL, then we
  // navigate there. callbackURL is where the provider lands the user afterwards.
  async socialSignIn(provider: "google" | "github", callbackURL = "/app/home"): Promise<void> {
    const data = await f("/api/auth/sign-in/social", opts({ provider, callbackURL })).then(authJson)
    if (data?.url) window.location.href = data.url
  },

  listArtifacts: (params?: {
    q?: string
    tag?: string
    collection?: string
    favorite?: boolean
    /** Narrow to artifacts last changed by this GitHub login. */
    author?: string
    /** "shared" → only artifacts explicitly shared with you (across workspaces).
     *  "following" → artifacts in the active workspace matching your follows
     *  (followed GitHub authors + repo path prefixes) — the activity feed.
     *  "needs_feedback" → artifacts with an open thread you're tagged in or commented on. */
    scope?: "shared" | "following" | "needs_feedback"
    cursor?: string
    limit?: number
  }): Promise<{
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
    const s = qs.toString()
    return f(`/v1/artifacts${s ? `?${s}` : ""}`, opts()).then(j)
  },
  browseSummary: (): Promise<{
    total: number
    favorites: number
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
  // Change general access from the Share dialog: visibility + the general-access role
  // (view vs comment). A password is required when enabling `password` visibility for
  // the first time. Anonymous reachers stay view-only regardless of generalRole.
  setVisibility: (
    id: string,
    visibility: string,
    generalRole?: GeneralRole,
    password?: string,
  ): Promise<{ visibility: string; general_role: GeneralRole }> =>
    f(`/v1/artifacts/${id}/visibility`, {
      ...opts({ visibility, generalRole, password }),
      method: "PATCH",
    }).then(j),
  setLocked: (id: string, locked: boolean): Promise<{ locked: boolean }> =>
    f(`/v1/artifacts/${id}/locked`, {
      ...opts({ locked }),
      method: "PATCH",
    }).then(j),
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

  listMembers: (id: string): Promise<{ default_role: Role; members: ArtifactMember[] }> =>
    f(`/v1/artifacts/${id}/members`, opts()).then(j),
  // `user` is a @username or an email; the server resolves either to the account.
  setMember: (id: string, user: string, role: Role): Promise<ArtifactMember> =>
    f(`/v1/artifacts/${id}/members`, { ...opts({ user, role }), method: "PUT" }).then(j),
  removeMember: (id: string, userId: string): Promise<void> =>
    f(`/v1/artifacts/${id}/members/${userId}`, { method: "DELETE", credentials: "include" }).then(
      () => undefined,
    ),

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
  // Identity is derived server-side from the session/cookie, so we send nothing.
  heartbeat: (id: string): Promise<{ viewers: Viewer[] }> =>
    f(`/v1/artifacts/${id}/presence`, opts({})).then(j),

  favorite: (id: string, on: boolean): Promise<{ favorite: boolean }> =>
    f(`/v1/artifacts/${id}/favorite`, { ...opts(), method: on ? "PUT" : "DELETE" }).then(j),
  setTags: (id: string, tags: string[]): Promise<{ tags: string[] }> =>
    f(`/v1/artifacts/${id}/tags`, { ...opts({ tags }), method: "PUT" }).then(j),

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
  deleteAgent: (id: string): Promise<void> =>
    f(`/v1/agents/${id}`, { method: "DELETE", credentials: "include" }).then(() => undefined),

  // Contexts + sessions (the ask loop; see routes/contexts.ts server-side).
  listContexts: (): Promise<{ contexts: ContextInfo[] }> => f("/v1/contexts", opts()).then(j),
  getContext: (id: string): Promise<ContextInfo> => f(`/v1/contexts/${id}`, opts()).then(j),
  createContext: (input: {
    name: string
    agent_id: string
    manifest_short_id: string
  }): Promise<ContextInfo> => f("/v1/contexts", opts(input)).then(j),
  askContext: (
    id: string,
    body_md: string,
  ): Promise<{ session: Session; messages: SessionMessage[] }> =>
    f(`/v1/contexts/${id}/sessions`, opts({ body_md })).then(j),
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

  // Slack App: status, set default channel, disconnect. Connect is a redirect to
  // /v1/slack/install (a full-page navigation, not a fetch).
  getSlack: (): Promise<SlackStatus> => f("/v1/slack", opts()).then(j),
  setSlackChannel: (default_channel: string | null): Promise<{ default_channel: string | null }> =>
    f("/v1/slack", { ...opts({ default_channel }), method: "PATCH" }).then(j),
  disconnectSlack: (): Promise<void> =>
    f("/v1/slack", { method: "DELETE", credentials: "include" }).then(() => undefined),

  // Workspace name + members (Admin / Creator / Viewer = owner / editor / commenter)
  getWorkspace: (): Promise<Workspace> => f("/v1/workspace", opts()).then(j),
  renameWorkspace: (name: string): Promise<{ name: string }> =>
    f("/v1/workspace", { ...opts({ name }), method: "PATCH" }).then(j),
  addWorkspaceMember: (user: string, role: Role): Promise<ArtifactMember> =>
    f("/v1/workspace/members", { ...opts({ user, role }), method: "PUT" }).then(j),
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
  addToCollection: (collectionId: string, shortId: string): Promise<void> =>
    f(`/v1/collections/${collectionId}/items/${shortId}`, { ...opts(), method: "PUT" }).then(
      () => undefined,
    ),
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
}
