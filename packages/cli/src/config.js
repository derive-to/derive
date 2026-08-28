// derive.json + scaffold logic, kept pure so it's unit-testable without a server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { deckTemplate } from "./deck-template.gen.js"

export const CONFIG_FILE = "derive.json"

// Where `derive` talks to by default: the hosted cloud. `--local` targets a dev
// server on this machine; `--server <url>` or DERIVE_SERVER override either.
export const CLOUD_SERVER = "https://derive.to"
export const LOCAL_SERVER = "http://localhost:8080"

const withoutTrailingSlashes = (value) => {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

/** Resolve the target server: `--server` wins, then `--local`, then a project's
 *  derive.json server, then DERIVE_SERVER, else the hosted cloud. */
export function resolveServer(opts = {}, config = null) {
  if (opts.server) return withoutTrailingSlashes(String(opts.server))
  if (opts.local) return LOCAL_SERVER
  return withoutTrailingSlashes(config?.server ?? process.env.DERIVE_SERVER ?? CLOUD_SERVER)
}

// ---- User-level credentials (`derive login`) --------------------------------
// Tokens are secrets, so they live in a user-level store (one entry per Derive
// origin), never in the project's derive.json. DERIVE_CONFIG_DIR overrides the dir.
//
// A Derive access token is scoped to a USER, not a workspace: it already reaches
// every workspace that user belongs to (the server picks one per request via the
// X-Derive-Workspace header). So this store holds one grant per signed-in ACCOUNT,
// each with the roster of workspaces it can target, and a default (account,
// workspace) pair. Multiple accounts (e.g. a personal + a work login) coexist
// side by side; switching between their workspaces never re-authenticates.
//
// On-disk shape, keyed by server origin:
//   {
//     client_id: string|null,        // this machine's registered OAuth client for
//                                     // this origin, reused across logins so a
//                                     // workspace picked at consent time can stick
//     defaultAccount: string|null,   // which account's token/workspace is used
//                                     // when a command names neither --account nor
//                                     // --workspace
//     accounts: {
//       [accountId]: {
//         handle: string|null,        // public handle, display only
//         auth: { token, refresh_token, client_id, expires_at, saved_at },
//         workspaces: { [workspaceId]: { name, role, description? } },
//         defaultWorkspace: string|null,
//       }
//     }
//   }
//
// `description` is local-only — never sent to or read from the server, set via
// `derive workspace describe`. It exists so a bare workspace name ("Client
// Demos") carries the WHY, not just the WHAT, when a human or an agent is
// deciding where to publish. Preserved across `setWorkspaces` re-syncs.

const configDir = () => process.env.DERIVE_CONFIG_DIR ?? join(homedir(), ".config", "derive")
const credsPath = () => join(configDir(), "credentials.json")

/** Normalize a server URL to its origin so one entry covers every path under it. */
const originOf = (server) => {
  try {
    return new URL(server).origin
  } catch {
    return server
  }
}

/** All saved credentials, keyed by server origin, in whatever shape is on disk
 *  (see `entryFor` for the normalized, migrated read). {} if none / unreadable. */
export function loadCredentials() {
  try {
    return JSON.parse(readFileSync(credsPath(), "utf8"))
  } catch {
    return {}
  }
}

const emptyEntry = () => ({ client_id: null, defaultAccount: null, accounts: {} })

/** Normalize whatever is stored for an origin into the current multi-account
 *  shape. A pre-multi-workspace grant (the flat `{token, refresh_token,
 *  client_id, expires_at, saved_at}` this store used before accounts existed) is
 *  read as one synthetic "legacy" account with an empty workspace map — so a
 *  `derive login` from before this change keeps publishing with zero action;
 *  `derive login --sync` fills in its real handle and workspace roster the first
 *  time it runs after upgrading. Idempotent: an already-migrated entry passes
 *  through unchanged. Pure — the migration isn't written back until the next
 *  save (saveAccount/setWorkspaces/etc all persist the normalized shape). */
function migrateEntry(raw) {
  if (!raw) return emptyEntry()
  if (raw.accounts)
    return {
      client_id: raw.client_id ?? null,
      defaultAccount: raw.defaultAccount ?? null,
      accounts: raw.accounts,
    }
  if (!raw.token) return emptyEntry()
  return {
    client_id: null,
    defaultAccount: "legacy",
    accounts: {
      legacy: {
        handle: null,
        auth: {
          token: raw.token,
          refresh_token: raw.refresh_token ?? null,
          client_id: raw.client_id ?? null,
          expires_at: raw.expires_at ?? null,
          saved_at: raw.saved_at ?? null,
        },
        workspaces: {},
        defaultWorkspace: null,
      },
    },
  }
}

/** The normalized, migrated entry for `server`'s origin. */
export function entryFor(server) {
  return migrateEntry(loadCredentials()[originOf(server)])
}

/** Persist `entry` as `server`'s origin entry (0600, owner-only). Returns the
 *  store path. Internal — callers go through the functions below, which each
 *  read-modify-write one normalized entry so a concurrent read never sees a
 *  half-migrated or half-updated shape. */
function persistEntry(server, entry) {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  const all = loadCredentials()
  all[originOf(server)] = entry
  writeFileSync(credsPath(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  return credsPath()
}

/** The OAuth client this machine has already registered for `server`, or null.
 *  Reused across logins (new accounts included) so a workspace choice made on
 *  the consent screen — bound server-side to (user, client) — actually sticks,
 *  instead of a fresh client id starting that binding over every time. */
export function getClientId(server) {
  return entryFor(server).client_id
}

/** Persist the client id this machine just registered for `server`. */
export function saveClientId(server, clientId) {
  const entry = entryFor(server)
  entry.client_id = clientId
  return persistEntry(server, entry)
}

/** Merge `handle` and/or an auth `grant` into `accountId` on `server`, creating
 *  the account if it's new. Grant shape matches the OAuth token endpoint's
 *  response: `{token, refresh_token, client_id, expires_in}` (expires_in is
 *  seconds from now, converted to an absolute expiry a minute early so an
 *  in-flight publish never races it). The first account ever saved on a server
 *  becomes its default automatically; its default workspace is set separately
 *  by `setWorkspaces` once the roster is known. Returns the store path. */
export function saveAccount(server, accountId, { handle, grant } = {}) {
  const entry = entryFor(server)
  const existing = entry.accounts[accountId] ?? {
    handle: null,
    auth: null,
    workspaces: {},
    defaultWorkspace: null,
  }
  if (handle !== undefined) existing.handle = handle
  if (grant) {
    existing.auth = {
      token: grant.token,
      refresh_token: grant.refresh_token ?? existing.auth?.refresh_token ?? null,
      client_id: grant.client_id ?? existing.auth?.client_id ?? null,
      expires_at: grant.expires_in
        ? new Date(Date.now() + (grant.expires_in - 60) * 1000).toISOString()
        : (existing.auth?.expires_at ?? null),
      saved_at: new Date().toISOString(),
    }
  }
  entry.accounts[accountId] = existing
  if (!entry.defaultAccount) entry.defaultAccount = accountId
  return persistEntry(server, entry)
}

/** Find `ref` (a workspace id, or its name — matched case-insensitively) in a
 *  `{[id]: {name, role}}` map. Ids are checked first since they never collide;
 *  names can. */
function findWorkspace(workspacesMap, ref) {
  if (workspacesMap[ref]) return { id: ref, name: workspacesMap[ref].name }
  const wanted = ref.toLowerCase()
  const hit = Object.entries(workspacesMap).find(([, w]) => w.name.toLowerCase() === wanted)
  return hit ? { id: hit[0], name: hit[1].name } : null
}

/** Pick a sensible default from a workspace map: the first "owner" role, else
 *  the first entry, else null (an empty roster). Used whenever a roster changes
 *  underneath a default that no longer resolves. */
const pickDefaultWorkspace = (workspacesMap) => {
  const ids = Object.keys(workspacesMap)
  return ids.find((id) => workspacesMap[id].role === "owner") ?? ids[0] ?? null
}

/** What `derive login` should hand `setWorkspaces()` after a sign-in discovers
 *  `chosen` workspaces (the full roster, or a `--workspace`/`--pick` subset).
 *  `setWorkspaces` replaces the roster outright — correct for a fresh account
 *  or a full discovery, but a NARROWED `chosen` against an account that
 *  already has other workspaces synced would read as "the rest were removed"
 *  and delete them locally. `narrowing` (true for `--workspace`/`--pick`) MERGES
 *  `chosen` into `existing` instead in that case; otherwise `chosen` is used
 *  as-is (there's nothing narrower-than-nothing to protect on a fresh account,
 *  and a full discovery is meant to replace/diff the whole roster). */
export function mergeChosenWorkspaces(existing, chosen, narrowing) {
  return narrowing && Object.keys(existing).length ? { ...existing, ...chosen } : chosen
}

/** Replace `accountId`'s workspace roster with `workspacesMap`, as returned by a
 *  fresh `GET /v1/workspaces`. Returns what changed since the last sync —
 *  `{added, renamed, removed}`, each a list of `{id, name}` (`renamed` also
 *  carries `from`) — for `derive login --sync` to report. If the account's
 *  default workspace no longer resolves in the new roster (first sync, or it
 *  was removed on the server), picks a new one so publishing is never left
 *  untargeted. A workspace's local `description` (set via `derive workspace
 *  describe`) carries forward for any id still present — the server has no
 *  concept of it, so a re-sync must not silently wipe it. */
export function setWorkspaces(server, accountId, workspacesMap) {
  const entry = entryFor(server)
  const account = entry.accounts[accountId]
  if (!account) throw new Error(`no such account: ${accountId}`)
  const before = account.workspaces ?? {}
  const added = []
  const renamed = []
  const removed = []
  const merged = {}
  for (const [id, w] of Object.entries(workspacesMap)) {
    const prev = before[id]
    if (!prev) added.push({ id, name: w.name })
    else if (prev.name !== w.name) renamed.push({ id, from: prev.name, to: w.name })
    merged[id] = prev?.description ? { ...w, description: prev.description } : w
  }
  for (const [id, w] of Object.entries(before)) {
    if (!workspacesMap[id]) removed.push({ id, name: w.name })
  }
  account.workspaces = merged
  if (!account.defaultWorkspace || !workspacesMap[account.defaultWorkspace]) {
    account.defaultWorkspace = pickDefaultWorkspace(workspacesMap)
  }
  persistEntry(server, entry)
  return { added, renamed, removed }
}

/** The accounts saved on `server`: `{id, handle, workspaceCount, isDefault}`. */
export function listAccounts(server) {
  const entry = entryFor(server)
  return Object.entries(entry.accounts).map(([id, a]) => ({
    id,
    handle: a.handle,
    workspaceCount: Object.keys(a.workspaces ?? {}).length,
    isDefault: entry.defaultAccount === id,
  }))
}

/** The full stored record for `accountId` on `server` (handle/auth/workspaces/
 *  defaultWorkspace), or null. */
export function getAccount(server, accountId) {
  return entryFor(server).accounts[accountId] ?? null
}

/** Resolve an `--account` ref — an account id, or its handle (with or without a
 *  leading `@`, case-insensitive) — to a known account id on `server`, or null. */
export function resolveAccountRef(server, ref) {
  const entry = entryFor(server)
  if (entry.accounts[ref]) return ref
  const wanted = ref.replace(/^@/, "").toLowerCase()
  const hit = Object.entries(entry.accounts).find(
    ([, a]) => a.handle && a.handle.toLowerCase() === wanted,
  )
  return hit?.[0] ?? null
}

/** Find `ref` (a workspace id, or name — case-insensitive) among `accountId`'s
 *  known workspaces on `server`, without changing anything. `{id, name}`, or
 *  null if the account or the workspace doesn't exist. */
export function findAccountWorkspace(server, accountId, ref) {
  const account = entryFor(server).accounts[accountId]
  if (!account) return null
  return findWorkspace(account.workspaces ?? {}, ref)
}

/** The `{account, workspace}` ids of the default publish target on `server`, or
 *  null if signed out entirely. `workspace` may be null (an account synced from
 *  a legacy grant, or one with an empty roster). */
export function getDefault(server) {
  const entry = entryFor(server)
  if (!entry.defaultAccount) return null
  const account = entry.accounts[entry.defaultAccount]
  if (!account) return null
  return { account: entry.defaultAccount, workspace: account.defaultWorkspace ?? null }
}

/** Make `accountId` the default for `server`. Throws if it isn't a known account. */
export function setDefaultAccount(server, accountId) {
  const entry = entryFor(server)
  if (!entry.accounts[accountId]) throw new Error(`no such account: ${accountId}`)
  entry.defaultAccount = accountId
  persistEntry(server, entry)
}

/** Resolve `ref` among `accountId`'s known workspaces and make it that account's
 *  default. Throws a clear error (never partially applies) if it isn't found —
 *  callers show that message and exit rather than silently keeping the old
 *  default. Returns the matched `{id, name}`. */
export function setDefaultWorkspace(server, accountId, ref) {
  const entry = entryFor(server)
  const account = entry.accounts[accountId]
  if (!account) throw new Error(`no such account: ${accountId}`)
  const found = findWorkspace(account.workspaces ?? {}, ref)
  if (!found) throw new Error(`no workspace "${ref}" for this account`)
  account.defaultWorkspace = found.id
  persistEntry(server, entry)
  return found
}

/** Drop `ref` from `accountId`'s local workspace roster (does not touch server
 *  membership — `derive login --sync` re-adds it if you're still a member).
 *  Re-picks the default workspace if the forgotten one was it. Returns the
 *  removed `{id, name}`, or null if `ref` didn't match anything. */
export function forgetWorkspace(server, accountId, ref) {
  const entry = entryFor(server)
  const account = entry.accounts[accountId]
  if (!account) throw new Error(`no such account: ${accountId}`)
  const found = findWorkspace(account.workspaces ?? {}, ref)
  if (!found) return null
  delete account.workspaces[found.id]
  if (account.defaultWorkspace === found.id) {
    account.defaultWorkspace = pickDefaultWorkspace(account.workspaces)
  }
  persistEntry(server, entry)
  return found
}

/** Set (`description` a non-empty string) or clear (`description` null/empty) a
 *  local note on `ref` describing what the workspace is FOR — never sent to or
 *  read from the server. This is the context a bare name can't carry: "Client
 *  Demos" doesn't say who shouldn't see it, "Sift AI" doesn't say it's the only
 *  one wired to send outbound. Preserved across `derive login --sync` (see
 *  `setWorkspaces`). Throws if the account or workspace isn't known (same
 *  contract as `setDefaultWorkspace`). Returns the matched `{id, name}`. */
export function describeWorkspace(server, accountId, ref, description) {
  const entry = entryFor(server)
  const account = entry.accounts[accountId]
  if (!account) throw new Error(`no such account: ${accountId}`)
  const found = findWorkspace(account.workspaces ?? {}, ref)
  if (!found) throw new Error(`no workspace "${ref}" for this account`)
  const workspace = Object.hasOwn(account.workspaces, found.id)
    ? Object.getOwnPropertyDescriptor(account.workspaces, found.id)?.value
    : null
  if (!workspace || typeof workspace !== "object")
    throw new Error(`workspace "${ref}" has an invalid local record`)
  if (description) workspace.description = description
  else delete workspace.description
  persistEntry(server, entry)
  return found
}

/** Remove `accountId` entirely from `server` (its grant and workspace map). If
 *  it was the default, the next remaining account (if any) becomes default.
 *  Returns whether it existed. */
export function removeAccount(server, accountId) {
  const entry = entryFor(server)
  if (!entry.accounts[accountId]) return false
  delete entry.accounts[accountId]
  if (entry.defaultAccount === accountId) {
    entry.defaultAccount = Object.keys(entry.accounts)[0] ?? null
  }
  persistEntry(server, entry)
  return true
}

/** Find `ref` (a workspace id, or name — case-insensitive) across every account
 *  saved on `server`, for a `--workspace` flag given with no `--account`. An id
 *  match resolves immediately: workspace ids are server-assigned and globally
 *  unique, so if it shows up under more than one of your accounts, that's
 *  shared membership in the same workspace, not a collision — prefer the
 *  default account among the matches, else the first. A NAME match is
 *  ambiguous when it resolves to more than one DISTINCT workspace id (two
 *  different workspaces that happen to share a name across your accounts): that
 *  case returns `{ambiguous: [{accountId, handle}, ...]}` for the caller to ask
 *  for `--account`. Returns null if nothing matches. */
export function resolveWorkspaceRef(server, ref) {
  const entry = entryFor(server)
  const idHits = Object.entries(entry.accounts).filter(([, a]) => a.workspaces?.[ref])
  if (idHits.length) {
    const [accountId, account] = idHits.find(([id]) => id === entry.defaultAccount) ?? idHits[0]
    return { accountId, workspaceId: ref, workspaceName: account.workspaces[ref].name }
  }
  const wanted = ref.toLowerCase()
  const nameHits = []
  for (const [accountId, a] of Object.entries(entry.accounts)) {
    for (const [workspaceId, w] of Object.entries(a.workspaces ?? {})) {
      if (w.name.toLowerCase() === wanted)
        nameHits.push({ accountId, workspaceId, workspaceName: w.name })
    }
  }
  const distinctIds = [...new Set(nameHits.map((h) => h.workspaceId))]
  if (distinctIds.length > 1) {
    return {
      ambiguous: distinctIds.map((workspaceId) => {
        const hit = nameHits.find((h) => h.workspaceId === workspaceId)
        return { accountId: hit.accountId, handle: entry.accounts[hit.accountId].handle }
      }),
    }
  }
  if (nameHits.length)
    return nameHits.find((h) => h.accountId === entry.defaultAccount) ?? nameHits[0]
  return null
}

/** A live access token for `accountId` on `server`: the saved one if still
 *  valid, else refreshed silently via the stored refresh token (rotating it).
 *  null if the account (or its grant) doesn't exist. This is what makes
 *  publishing zero-click after a one-time `derive login`, indefinitely. */
export async function freshToken(server, accountId) {
  if (!accountId) return null
  const account = entryFor(server).accounts[accountId]
  if (!account?.auth) return null
  const { auth } = account
  const valid = !auth.expires_at || new Date(auth.expires_at).getTime() > Date.now()
  if (valid || !auth.refresh_token || !auth.client_id) return auth.token ?? null
  try {
    const res = await fetch(`${originOf(server)}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refresh_token,
        client_id: auth.client_id,
      }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || !j.access_token) return auth.token ?? null
    saveAccount(server, accountId, {
      grant: {
        token: j.access_token,
        refresh_token: j.refresh_token ?? auth.refresh_token,
        client_id: auth.client_id,
        expires_in: j.expires_in,
      },
    })
    return j.access_token
  } catch {
    return auth.token ?? null
  }
}

/** The derive.json a fresh project starts with (no id until first publish).
 *  No `visibility` — a scaffolded project publishes at the workspace default (the
 *  "team draft": the workspace can open it at their seat role, so teammates and
 *  on-behalf agents reach it, but it's not listed in any library and has no world
 *  link). Add `visibility: public|org|private` to widen or narrow. */
export const defaultConfig = (title = "My artifact", entry = "index.md") => ({
  $schema: "./derive.schema.json",
  title,
  entry,
  spa: false,
  id: null,
})

export const TEMPLATES = ["md", "html", "workflow", "slides", "site", "skill", "context"]

/** Read derive.json from `dir`, or null if absent. Throws on malformed JSON. */
export function loadConfig(dir = ".") {
  const path = join(dir, CONFIG_FILE)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`)
  }
}

/**
 * Effective publish settings: CLI flags win over derive.json, which wins over
 * built-in defaults. Returns the values the publish command actually uses.
 *
 * Also resolves WHERE it publishes: `--workspace`/`--account` flags win over
 * `derive.json`'s `workspace`/`account` fields, which win over the stored
 * default. A `--workspace` alone is looked up across every saved account
 * (`resolveWorkspaceRef`); pass `--account` too when a name collides. Any
 * failure to resolve (unknown ref, or a name ambiguous across accounts) is
 * returned as `workspaceError` rather than thrown, so this stays a pure,
 * synchronous function — the caller prints it and exits before touching the
 * network. `token` is the resolved account's saved token, pre-refresh; the
 * caller awaits `freshToken(server, accountId)` afterward, same as today.
 */
export function resolvePublish(opts = {}, config = null) {
  const c = config ?? {}
  const spa = opts.spa != null ? opts.spa === "true" || opts.spa === true : !!c.spa
  const server = resolveServer(opts, c)

  let accountId = null
  let workspaceId = null
  let workspaceName = null
  let workspaceError = null
  const accountRef = opts.account ?? c.account ?? null
  const workspaceRef = opts.workspace ?? c.workspace ?? null

  if (workspaceRef && accountRef) {
    const aid = resolveAccountRef(server, accountRef)
    if (!aid) {
      workspaceError = { type: "no_account", ref: accountRef }
    } else {
      const found = findWorkspace(getAccount(server, aid).workspaces ?? {}, workspaceRef)
      if (!found) workspaceError = { type: "not_found", ref: workspaceRef }
      else {
        accountId = aid
        workspaceId = found.id
        workspaceName = found.name
      }
    }
  } else if (workspaceRef) {
    const resolved = resolveWorkspaceRef(server, workspaceRef)
    if (!resolved) workspaceError = { type: "not_found", ref: workspaceRef }
    else if (resolved.ambiguous)
      workspaceError = { type: "ambiguous", ref: workspaceRef, accounts: resolved.ambiguous }
    else ({ accountId, workspaceId, workspaceName } = resolved)
  } else if (accountRef) {
    const aid = resolveAccountRef(server, accountRef)
    if (!aid) {
      workspaceError = { type: "no_account", ref: accountRef }
    } else {
      accountId = aid
      const a = getAccount(server, aid)
      workspaceId = a.defaultWorkspace ?? null
      workspaceName = workspaceId ? (a.workspaces[workspaceId]?.name ?? null) : null
    }
  } else {
    const def = getDefault(server)
    accountId = def?.account ?? null
    workspaceId = def?.workspace ?? null
    if (accountId && workspaceId) {
      workspaceName = getAccount(server, accountId)?.workspaces?.[workspaceId]?.name ?? null
    }
  }
  const account = accountId ? getAccount(server, accountId) : null

  return {
    id: opts.id ?? c.id ?? null,
    target: opts.target ?? c.entry ?? null,
    title: opts.title ?? c.title,
    slug: opts.slug ?? c.slug,
    // The canonical v2 access fields (flag > derive.json). Each is independent;
    // omit all to inherit the workspace default (the team draft). `visibility` is
    // the deprecated single-axis alias — the server still maps it — kept so existing
    // derive.json files and muscle memory keep working. See docs/access-model.md.
    workspaceAccess: opts["workspace-access"] ?? c.workspace_access,
    linkRole: opts["link-role"] ?? c.link_role,
    listed: opts.listed ?? c.listed,
    visibility: opts.visibility ?? c.visibility,
    spa,
    message: opts.message,
    name: opts.name,
    server,
    accountId,
    accountHandle: account?.handle ?? null,
    workspaceId,
    workspaceName,
    workspaceError,
    // Explicit flag / env win; otherwise the resolved account's saved token
    // (pre-refresh — see the docstring above).
    token: opts.token ?? process.env.DERIVE_TOKEN ?? account?.auth?.token ?? null,
  }
}

/** Persist the server-assigned id back into derive.json (preserving other keys). */
export function writeId(dir, id) {
  const path = join(dir, CONFIG_FILE)
  const config = loadConfig(dir) ?? defaultConfig()
  config.id = id
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

/** Merge server-assigned context wiring (id, agent_id) into derive.json's
 *  context block, preserving everything else — the context-side twin of writeId. */
export function writeContextConfig(dir, patch) {
  const path = join(dir, CONFIG_FILE)
  const config = loadConfig(dir) ?? defaultConfig()
  config.context = { ...config.context, ...patch }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

/** Record (or replace) a skill pin in derive.json's top-level `skills` array — the
 *  lockfile `derive skill add` maintains, so a later `update` is an explicit, diffable
 *  act rather than silent drift. Same id ⇒ overwrite (a re-add repins). */
export function writeSkillPin(dir, { id, version, name }) {
  const path = join(dir, CONFIG_FILE)
  const config = loadConfig(dir) ?? defaultConfig()
  const kept = Array.isArray(config.skills) ? config.skills.filter((s) => s.id !== id) : []
  config.skills = [...kept, { id, version, ...(name ? { name } : {}) }]
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

// Each template's entry (what `derive publish` targets) + the starter file(s) it
// writes. `site` is a multi-file bundle (entry is a directory). derive.json,
// derive.schema.json, and AGENTS.md are added to every template.
const STARTERS = {
  md: { entry: "index.md", files: (t) => ({ "index.md": starterMd(t) }) },
  html: { entry: "index.html", files: (t) => ({ "index.html": starterHtml(t) }) },
  workflow: {
    entry: "workflow.html",
    files: (t) => ({ "workflow.html": starterWorkflow(t) }),
  },
  slides: { entry: "slides.html", files: (t) => ({ "slides.html": starterSlides(t) }) },
  site: {
    entry: "site",
    files: (t) => ({
      "site/index.html": starterSiteIndex(t),
      "site/about.html": starterSiteAbout(t),
      "site/style.css": SITE_CSS,
    }),
  },
  // A Claude Code skill: a SKILL.md (frontmatter + body) plus scripts/ + references/.
  // `derive publish skill/` zips the folder; Derive renders SKILL.md and recognizes it as
  // a skill (the project's derive.json/AGENTS.md stay outside the bundled `skill/` dir).
  skill: {
    entry: "skill",
    files: (t) => ({
      "skill/SKILL.md": starterSkill(t),
      "skill/scripts/example.sh": STARTER_SKILL_SCRIPT,
      "skill/references/example.md": STARTER_SKILL_REFERENCE,
    }),
  },
  // A Context project contains instructions, local references, MCP configuration, and an
  // ignored environment file. `derive context push` excludes `.env*`.
  context: {
    entry: "context",
    files: (t) => ({
      "context/MANIFEST.md": starterManifest(t),
      "context/references/example.md": STARTER_CONTEXT_REFERENCE,
      "context/.mcp.json": `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      "context/.env.example": STARTER_CONTEXT_ENV,
      ".gitignore": CONTEXT_GITIGNORE,
    }),
    extend: (config, title) => ({ ...config, context: { id: null, agent_id: null, name: title } }),
  },
}

/**
 * Files a new project gets for a template. derive.json drives publishing; AGENTS.md
 * is the loop convention for agents; the starter is publishable immediately. The
 * agent on-ramp ships too: one canonical skill in the native Codex and Claude
 * locations, plus each client's project MCP config.
 */
export function scaffoldFiles(title = "My artifact", template = "md") {
  // Projects scaffolded during the rename may still use the old template name.
  const canonicalTemplate = template === "agent" ? "context" : template
  const t = STARTERS[canonicalTemplate] ?? STARTERS.md
  const config = t.extend
    ? t.extend(defaultConfig(title, t.entry), title)
    : defaultConfig(title, t.entry)
  return {
    [CONFIG_FILE]: `${JSON.stringify(config, null, 2)}\n`,
    "derive.schema.json": `${JSON.stringify(DERIVE_SCHEMA, null, 2)}\n`,
    ...t.files(title),
    "AGENTS.md": AGENTS_MD,
    "CLAUDE.md": AGENTS_MD,
    ...agentScaffoldFiles(),
  }
}

const DERIVE_SKILL_PATHS = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/connect.md",
  "references/compatibility.md",
]

const WORKFLOW_SKILL_PATHS = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/protocol.md",
  "references/runtime.md",
]

const deriveSkillFiles = Object.fromEntries(
  DERIVE_SKILL_PATHS.map((path) => [
    path,
    readFileSync(new URL(`../skills/derive/${path}`, import.meta.url), "utf8"),
  ]),
)

const workflowSkillFiles = Object.fromEntries(
  WORKFLOW_SKILL_PATHS.map((path) => [
    path,
    readFileSync(new URL(`../skills/derive-workflows/${path}`, import.meta.url), "utf8"),
  ]),
)

/** The complete agent on-ramp for a project, shared by `derive init` and
 *  `derive agent setup`. The same canonical skill is installed in both native
 *  discovery locations. */
export function agentScaffoldFiles() {
  const files = {}
  for (const harnessRoot of [".agents/skills", ".claude/skills"])
    for (const [skill, skillFiles] of [
      ["derive", deriveSkillFiles],
      ["derive-workflows", workflowSkillFiles],
    ])
      for (const [path, contents] of Object.entries(skillFiles))
        files[`${harnessRoot}/${skill}/${path}`] = contents
  return {
    ...files,
    ".mcp.json": `${JSON.stringify(MCP_CONFIG, null, 2)}\n`,
    ".codex/config.toml": CODEX_MCP_CONFIG,
  }
}

/** Project-scoped remote MCP config for Claude Code. OAuth happens in the
 *  client, so the checked-in file contains no token. */
// Shell-style env expansion the agent harness resolves when it reads .mcp.json:
// `${VAR:-default}`. Assembled from parts so the source carries no literal
// template placeholder (which a plain JS string shouldn't).
const envRef = (name, fallback = "") => ["${", name, ":-", fallback, "}"].join("")

const MCP_CONFIG = {
  mcpServers: {
    derive: {
      type: "http",
      url: envRef("DERIVE_MCP_URL", "https://derive.to/mcp"),
    },
  },
}

/** Project-scoped remote MCP config for Codex. */
const CODEX_MCP_CONFIG = `[mcp_servers.derive]
url = "https://derive.to/mcp"
`

/** JSON Schema for derive.json — gives editors autocomplete + validation. */
export const DERIVE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "derive.json",
  type: "object",
  properties: {
    title: { type: "string", description: "Artifact title." },
    entry: { type: "string", description: "File or directory `derive publish` targets." },
    // The v2 access model — three independent fields (see docs/access-model.md).
    // Omit all to inherit the workspace default (the team draft: workspace access at
    // seat role, no world link, unlisted).
    workspace_access: {
      enum: ["none", "member"],
      description: "Do the workspace's members reach it at their seat role? (none = invite-only)",
    },
    link_role: {
      enum: ["none", "viewer", "commenter", "editor"],
      description: "What merely holding the URL grants anyone (none = no world link).",
    },
    listed: {
      enum: ["none", "workspace", "public"],
      description: "Where it surfaces for discovery — no access of its own.",
    },
    visibility: {
      // DEPRECATED single-axis alias, mapped server-side onto the three fields above
      // (public → member+viewer+public, org → member+workspace, private → invite-only;
      // link/password → public, unlisted → private). Kept so old files keep publishing.
      enum: ["public", "org", "private"],
      deprecated: true,
      description: "Deprecated — prefer workspace_access / link_role / listed.",
    },
    spa: {
      type: "boolean",
      description: "Serve a single-page-app fallback for unknown paths.",
      default: false,
    },
    id: {
      type: ["string", "null"],
      description: "Artifact short id; set automatically on first publish.",
    },
    server: { type: "string", description: "Derive server URL (overrides DERIVE_SERVER)." },
    workspace: {
      type: "string",
      description:
        "Workspace this project publishes to (id or name). Overrides the CLI's default — see `derive workspace use`.",
    },
    account: {
      type: "string",
      description:
        "Account (id or @handle) this project publishes as, when more than one is signed in.",
    },
    context: {
      type: "object",
      description: "Context wiring; ids are set by the first push.",
      properties: {
        id: { type: ["string", "null"], description: "Context id (ctx_…)." },
        agent_id: { type: ["string", "null"], description: "Execution connection id (ag_…)." },
        name: { type: "string", description: "Context name shown to askers." },
      },
    },
  },
}

/** Render comments as a readable thread list for `derive comments`. Pure. */
export function formatComments(comments) {
  if (!comments || comments.length === 0) return "No comments yet."
  const threads = new Map()
  for (const c of comments) {
    if (!threads.has(c.thread_id)) threads.set(c.thread_id, [])
    threads.get(c.thread_id).push(c)
  }
  const out = []
  for (const [tid, thread] of threads) {
    const root = thread[0]
    const quote = anchorQuote(root.anchor)
    out.push(`${root.state === "resolved" ? "✓" : "○"} thread ${tid}${quote ? `  “${quote}”` : ""}`)
    for (const c of thread) out.push(`    ${c.author}: ${c.body_md.replace(/\n/g, " ")}`)
  }
  return out.join("\n")
}

const anchorQuote = (anchor) => {
  if (!anchor) return null
  try {
    return JSON.parse(anchor).exact ?? null
  } catch {
    return null
  }
}

/**
 * Write the scaffold into `dir`. Existing files are preserved unless the
 * caller explicitly owns and updates that path.
 */
const writeMissingFiles = (dir, files, { update = () => false } = {}) => {
  mkdirSync(dir, { recursive: true })
  const created = []
  const updated = []
  const outdated = []
  const skipped = []
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name)
    if (existsSync(path)) {
      if (update(name) && readFileSync(path, "utf8") !== contents) {
        writeFileSync(path, contents)
        updated.push(name)
        continue
      }
      if (isAgentSkillFile(name) && readFileSync(path, "utf8") !== contents) {
        outdated.push(name)
        continue
      }
      skipped.push(name)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    created.push(name)
  }
  return { created, updated, outdated, skipped }
}

const AGENT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"]

const mergeWriteResults = (...results) => {
  const merged = { created: [], updated: [], outdated: [], skipped: [] }
  for (const result of results)
    for (const key of Object.keys(merged)) merged[key].push(...result[key])
  return merged
}

/** Add or refresh Derive's managed preference block without replacing project-owned
 *  instructions. A file with malformed markers is left untouched and reported as
 *  outdated; repairing an ambiguous boundary automatically would risk eating prose. */
const writeAgentInstructions = (dir, { update = false } = {}) => {
  const result = { created: [], updated: [], outdated: [], skipped: [] }
  for (const name of AGENT_INSTRUCTION_FILES) {
    const path = join(dir, name)
    if (!existsSync(path)) {
      writeFileSync(path, AGENTS_MD)
      result.created.push(name)
      continue
    }
    const current = readFileSync(path, "utf8")
    const start = current.indexOf(AGENT_PREFERENCE_START)
    const end = current.indexOf(AGENT_PREFERENCE_END)
    if (start === -1 && end === -1) {
      const separator = current.endsWith("\n") ? "\n" : "\n\n"
      writeFileSync(path, `${current}${separator}${AGENT_PREFERENCE_BLOCK}`)
      result.updated.push(name)
      continue
    }
    if (start === -1 || end === -1 || end < start) {
      result.outdated.push(name)
      continue
    }
    const after = end + AGENT_PREFERENCE_END.length
    const installed = current.slice(start, after)
    if (installed === AGENT_PREFERENCE_BLOCK.trimEnd()) {
      result.skipped.push(name)
      continue
    }
    if (!update) {
      result.outdated.push(name)
      continue
    }
    writeFileSync(
      path,
      `${current.slice(0, start)}${AGENT_PREFERENCE_BLOCK.trimEnd()}${current.slice(after)}`,
    )
    result.updated.push(name)
  }
  return result
}

const withoutAgentInstructions = (files) =>
  Object.fromEntries(
    Object.entries(files).filter(([name]) => !AGENT_INSTRUCTION_FILES.includes(name)),
  )

export function scaffold(dir = ".", title = "My artifact", template = "md") {
  mkdirSync(dir, { recursive: true })
  return mergeWriteResults(
    writeMissingFiles(dir, withoutAgentInstructions(scaffoldFiles(title, template))),
    writeAgentInstructions(dir),
  )
}

const AGENT_SKILL_PREFIXES = [
  ".agents/skills/derive/",
  ".claude/skills/derive/",
  ".agents/skills/derive-workflows/",
  ".claude/skills/derive-workflows/",
]
const isAgentSkillFile = (name) => AGENT_SKILL_PREFIXES.some((prefix) => name.startsWith(prefix))

/** Install the native skill, MCP configs, and managed instruction block into an
 *  existing project. Project prose and MCP configs remain user-owned. With
 *  update:true, refresh only packaged skill files and Derive's marked block. */
export function scaffoldAgent(dir = ".", { update = false } = {}) {
  mkdirSync(dir, { recursive: true })
  return mergeWriteResults(
    writeMissingFiles(dir, agentScaffoldFiles(), {
      update: (name) => update && isAgentSkillFile(name),
    }),
    writeAgentInstructions(dir, { update }),
  )
}

// A skill's `name` must be a kebab-case slug (it's how the skill is invoked); the
// title may have spaces, so derive one.
const skillName = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "my-skill"

const starterSkill = (title) => `---
name: ${skillName(title)}
description: ${title} — say, in a sentence or two, when an agent should reach for this skill (the triggers and the job it does).
---

# ${title}

Replace this with what the skill does and how to use it. A skill is a folder: this
SKILL.md plus optional \`scripts/\` (helpers it can run) and \`references/\` (context
loaded on demand). Publish the folder with \`derive publish skill/\`.

## Steps

1. Describe the first step, declaratively, with a worked example.
2. ...

## Files

- \`scripts/example.sh\` — a helper this skill can run.
- \`references/example.md\` — extra context, loaded when needed.
`

const STARTER_SKILL_SCRIPT = `#!/usr/bin/env bash
# A helper this skill can run. Keep scripts self-contained and relative-path only.
set -euo pipefail
echo "hello from the skill"
`

const STARTER_SKILL_REFERENCE = `# Reference

Extra detail the skill loads on demand — keep SKILL.md lean and push the long tail
(edge cases, tables, examples) into reference files like this one.
`

const starterManifest = (title) => `---
# Repo pointers: the runner clones these into repos/ at boot and tells the
# model what's there (and at which SHA). Uncomment to declare them — they
# travel with every push, so a fresh box needs nothing pre-installed.
# repos:
#   - url: https://github.com/you/data-notebooks
#     ref: main
#     description: what's in it, one line the model will read
---

# ${title} — context manifest

This file is the runner's system prompt. Editing it (and pushing) reconfigures
the agent's judgment with no redeploy — the next answer uses the new version.

## Purpose

Describe when an agent should use this Context, what knowledge it provides, and
who the work is for.

## Data sources

Name each source the runner's tools reach (see \`.mcp.json\` in this directory)
and what it's authoritative for. Say what is READ-ONLY — the tools should
enforce it, but the manifest is where the intent lives.

## Judgment

The decision rules a good analyst would apply: which source wins when two
disagree, what "active" or "churned" mean here, units and timezones, the
denominators that make a percentage honest.

## References

Files in \`references/\` sit next to this manifest in the runner's working
directory — point at them by relative path ("read references/schema.md before
writing SQL") and the model reads them on demand. Keep this file lean; push the
long tail there.

## Escalation

When to answer with \`escalate: true\` instead of guessing: thresholds, topics
that need a human (pricing, legal, anything contractual), and who the human is.

## Answer style

Concise summary first, then supporting detail. State caveats explicitly. Include
the query used when a number came from one.
`

const STARTER_CONTEXT_REFERENCE = `# Reference

Files here travel with \`derive context push\` (versioned alongside the manifest)
and sit in the runner's working directory — the manifest should point at them by
relative path. Schema notes, metric definitions, worked examples: the long tail
that would bloat MANIFEST.md lives here.
`

const STARTER_CONTEXT_ENV = `# Secrets used by this Context's MCP servers (see .mcp.json). Copy to .env and fill
# in — .env stays on this machine: push excludes it and .gitignore covers it.
# EXAMPLE_API_KEY=
`

const CONTEXT_GITIGNORE = `# Secrets never leave the machine: .env holds source credentials, .derive/
# holds the agent token minted by the first push. repos/ is the runner's clone
# workspace — pointer state, never source.
context/.env
context/repos/
.derive/
`

const starterMd = (title) => `# ${title}

Edit this, then run \`derive publish\`. Every publish becomes a new version at the
same URL, and reviewers can comment on the rendered page.

## Tips for durable comments

Comments anchor to the words they're attached to. They survive edits best when
surrounding text stays recognizable — keep headings stable and avoid rewording
a sentence end to end when you only meant to tweak it. See the artifact authoring standard.
`

const starterSiteIndex = (title) => `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="/style.css">
<nav><a href="/">Home</a> · <a href="/about.html">About</a></nav>
<h1>${title}</h1>
<p>A multi-page static site, published as one artifact. Build any generator into
a folder; <code>derive publish</code> zips it and serves it. Absolute asset paths
are rewritten so the bundle stays sandboxed.</p>
`

const starterSiteAbout = (title) => `<!doctype html>
<meta charset="utf-8">
<title>About · ${title}</title>
<link rel="stylesheet" href="/style.css">
<nav><a href="/">Home</a> · <a href="/about.html">About</a></nav>
<h1>About</h1>
<p>Page two. Internal links work; reviewers can comment on any page.</p>
`

const SITE_CSS = `body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#23203a;
  max-width:640px;margin:0 auto;padding:48px 24px}
nav{font-size:14px;color:#655999;margin-bottom:22px}
a{color:#655999}
h1{letter-spacing:-.02em}
code{background:#f1ead9;padding:1px 6px;border-radius:5px}
`

const starterHtml = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{font:17px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#23203a;
    max-width:680px;margin:0 auto;padding:56px 24px}
  h1{font-size:38px;letter-spacing:-.02em;margin:0 0 6px}
  .sub{color:#6b6680;margin:0 0 28px}
  code{background:#f1ead9;padding:1px 6px;border-radius:5px;font-size:.9em}
</style>
</head>
<body>
  <h1>${title}</h1>
  <p class="sub">A standalone HTML artifact.</p>
  <p>Edit this file and run <code>derive publish</code>. Each publish is a new version
  at the same URL, and reviewers can select any text to comment on it.</p>
</body>
</html>
`

const starterWorkflow = (title) => {
  const purpose = `Build and publish ${title}`
  const bundle = {
    schema: "derive.linked-bundle/v1",
    purpose,
    members: [],
    diagrams: [
      {
        id: "build-and-publish",
        title: "Build and publish",
        type: "graph",
        nodes: [
          { id: "draft", label: "Draft", state: "pending" },
          { id: "evaluate", label: "Quality check", state: "pending" },
          { id: "publish", label: "Publish", state: "pending" },
        ],
        edges: [
          { from: "draft", to: "evaluate", label: "draft ready" },
          { from: "evaluate", to: "draft", label: "revise" },
          { from: "evaluate", to: "publish", label: "quality bar met" },
        ],
      },
    ],
  }
  const workflow = {
    schema: "derive.workflow/v1",
    purpose,
    forbidden: ["Publish outside the current Derive workspace", "Continue past loop bounds"],
    diagrams: [
      {
        id: "build-and-publish",
        entry: "draft",
        nodes: [
          {
            id: "draft",
            kind: "context",
            context_ref: "draft-builder",
            instruction: `Create a reviewable ${title} draft.`,
            result: `A complete ${title} draft`,
          },
          {
            id: "evaluate",
            kind: "context",
            context_ref: "quality-checker",
            instruction: `Evaluate the ${title} draft against its stated outcome and return either ready or revise with specific evidence.`,
            result: "A grounded ready-or-revise decision",
            routing: "one",
          },
          {
            id: "publish",
            kind: "context",
            context_ref: "artifact-publisher",
            instruction: "Publish the ready draft to the current Derive workspace.",
            result: `A published ${title}`,
            terminal: true,
            effects: [
              {
                kind: "write",
                description: `Publish ${title} to Derive`,
                gate: "none",
                idempotency: "Publish one version for this workflow node attempt",
              },
            ],
          },
        ],
        routes: [
          { from: "draft", to: "evaluate", when: "always" },
          { from: "evaluate", to: "draft", when: "revise", fallback: true },
          { from: "evaluate", to: "publish", when: "ready" },
        ],
        loops: [
          {
            id: "bounded-improvement",
            nodes: ["draft", "evaluate"],
            goal: "Reach the stated quality bar",
            evaluate: "The quality checker evaluates accuracy, clarity, and scope",
            stop: {
              max_attempts: 2,
              stagnation_limit: 1,
              max_minutes: 20,
              human_stop: "The person stops or changes the work",
            },
          },
        ],
        scenarios: [
          {
            id: "expected",
            kind: "expected",
            path: ["draft", "evaluate", "publish"],
            outcome: `${title} meets the quality bar and is published`,
          },
          {
            id: "context-failure",
            kind: "failure",
            path: ["draft"],
            outcome: "The failed Context session stays visible and the run stops",
          },
          {
            id: "revision",
            kind: "expected",
            path: ["draft", "evaluate", "draft", "evaluate", "publish"],
            outcome: "One bounded revision lands before publication",
          },
        ],
      },
    ],
  }
  const fact = (value) => JSON.stringify(value, null, 2).replaceAll("<", "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · workflow</title>
<style>
  body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#17231f;
    background:#eef5f1;max-width:880px;margin:0 auto;padding:48px 24px}
  h1{font-size:42px;line-height:1.05;letter-spacing:-.04em;margin:0 0 10px}
  .sub{color:#5b6d66;margin:0 0 30px}.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;
    gap:12px;align-items:center}.node{background:white;border:1px solid #d8e5de;border-radius:16px;
    padding:20px}.arrow{font-size:24px;color:#087f5b}.note{margin-top:18px;padding:14px 16px;
    background:#fff1c7;border-radius:12px}code{background:#dff3e9;padding:2px 6px;border-radius:5px}
  @media(max-width:700px){.flow{grid-template-columns:1fr}.arrow{transform:rotate(90deg);text-align:center}}
</style>
</head>
<body>
  <h1>${title}</h1>
  <p class="sub">A graph-first Derive workflow. The visible graph and runnable definition use
  the same stable IDs for different jobs.</p>
  <div class="flow">
    <div class="node"><b>Draft</b><br>An agent drafts with one Context.</div><div class="arrow">→</div>
    <div class="node"><b>Quality check</b><br>An agent checks with another Context.</div><div class="arrow">→</div>
    <div class="node"><b>Publish</b><br>The ready result is published to Derive.</div>
  </div>
  <p class="note">The revise route is bounded to two attempts. Edit the outcome and Context
  references below, then run <code>derive workflow sync workflow.html</code>. Sync projects the
  definition into the visible graph and runs Preview; it never starts the workflow.</p>
<script type="application/derive-facts" data-fact="bundle-manifest">
${fact(bundle)}
</script>
<!-- Edit workflow behavior in this fact. The workflow sync command projects its topology above. -->
<script type="application/derive-facts" data-fact="workflow-definition">
${fact(workflow)}
</script>
</body>
</html>
`
}

// The slides starter is THE canonical Derive deck, shared byte-for-byte with the MCP
// template resource (derive://decks/template) and the library’s “Start a deck” — one
// source (packages/core/src/deck-template.html) mirrored here by
// scripts/gen-deck-template.mjs, because the decks skill documents exactly one pattern and
// three surfaces that drift from it teach three. The CLI stays standalone (no
// @derive/core dependency), hence a generated copy rather than an import.
const starterSlides = (title) => deckTemplate(title)

// Scaffolded into every project: an artifact-first handoff, written for an agent
// (or a human) to follow without prior knowledge of Derive.
const AGENT_PREFERENCE_START = "<!-- derive:artifact-first:start -->"
const AGENT_PREFERENCE_END = "<!-- derive:artifact-first:end -->"
const AGENT_PREFERENCE_BLOCK = `${AGENT_PREFERENCE_START}
## Artifact-first handoff

For substantial planning, product, design, research, review, or strategy work, create
and publish a durable Derive artifact instead of delivering the work as chat prose.
Prefer a fully styled HTML artifact with complete visual mockups when the topic has a
user interface or journey. Put open questions and decisions in the artifact or its
anchored comments, and revise the same URL through feedback.

This preference applies no matter which agent or tool is doing the work. Stay local
only when the user explicitly asks for local-only output, Derive is unavailable, or a
project policy forbids publishing. Keep the final chat handoff to the artifact link and,
only when essential, one short status line.
${AGENT_PREFERENCE_END}
`

const AGENTS_MD = `# Working with Derive

${AGENT_PREFERENCE_BLOCK}

This project publishes to **Derive**: artifacts get a permanent URL, versions, and
inline comments. Config lives in \`derive.json\`; the artifact id is filled in there
after the first publish, so later publishes target the same artifact.

## Publish

\`\`\`bash
derive publish              # publishes derive.json "entry", or:
derive publish ./report.md  # a file, or a folder (a built site)
\`\`\`

Each publish is a new immutable version at the same URL. Name a checkpoint with
\`derive publish --name "Final draft"\`.

## Continue the work at the same URL

Use only the commands the work needs (all read the artifact id from derive.json):

\`\`\`bash
derive publish                      # publish a durable version
derive comments                     # read comment threads (quote · author · state)
# revise the source when feedback or new information calls for it, then:
derive publish --name "Rev 2"       # publish again — same URL, highlights re-anchor
derive reply <thread_id> "Fixed in this version."   # discuss
derive resolve <comment_id>         # close a handled thread  (derive reopen to undo)
derive open                         # open the artifact in a browser
\`\`\`

Each is also a plain HTTP call if you'd rather not shell out — see the API under
\`/v1/artifacts/:id/comments\`. Republishing can resolve threads in one shot:
include \`resolves=<commentId,...>\` in the publish request.

## Keep comments anchorable

Anchors are text quotes with surrounding context. They survive edits when prose
stays recognizable. Prefer small, local edits over wholesale rewrites; keep
headings and distinctive phrases stable. Full guidance: the artifact authoring standard.

## Using an agent harness

The canonical \`derive\` skill ships in both \`.agents/skills/derive\` (Codex) and
\`.claude/skills/derive\` (Claude). Their project configs connect the complete remote
MCP over OAuth — no token to paste. The server instructions identify the active role
and workspace; call \`list_workspaces\` before publishing when the destination is
unclear. Read the matching \`derive://skills/*\` resource before a non-trivial action.
`
