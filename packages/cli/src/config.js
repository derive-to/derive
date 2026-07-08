// derive.json + scaffold logic, kept pure so it's unit-testable without a server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CONFIG_FILE = "derive.json"

// Where `derive` talks to by default: the hosted cloud. `--local` targets a dev
// server on this machine; `--server <url>` or DERIVE_SERVER override either.
export const CLOUD_SERVER = "https://derive.to"
export const LOCAL_SERVER = "http://localhost:8080"

/** Resolve the target server: `--server` wins, then `--local`, then a project's
 *  derive.json server, then DERIVE_SERVER, else the hosted cloud. */
export function resolveServer(opts = {}, config = null) {
  if (opts.server) return String(opts.server).replace(/\/+$/, "")
  if (opts.local) return LOCAL_SERVER
  return (config?.server ?? process.env.DERIVE_SERVER ?? CLOUD_SERVER).replace(/\/+$/, "")
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
  if (description) account.workspaces[found.id].description = description
  else delete account.workspaces[found.id].description
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
 *  Private visibility, like every other publish path — a scaffolded project
 *  opts into wider sharing by editing this field, not by accident. */
export const defaultConfig = (title = "My artifact", entry = "index.md") => ({
  $schema: "./derive.schema.json",
  title,
  entry,
  visibility: "private",
  spa: false,
  id: null,
})

export const TEMPLATES = ["md", "html", "slides", "site", "skill", "context"]

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

// Each template's entry (what `derive publish` targets) + the starter file(s) it
// writes. `site` is a multi-file bundle (entry is a directory). derive.json,
// derive.schema.json, and AGENTS.md are added to every template.
const STARTERS = {
  md: { entry: "index.md", files: (t) => ({ "index.md": starterMd(t) }) },
  html: { entry: "index.html", files: (t) => ({ "index.html": starterHtml(t) }) },
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
  // A Derive context: one directory that is the runner's whole world — MANIFEST.md
  // (the system prompt), references/ (docs the model reads from disk), .mcp.json
  // (the context's data-source tools), and .env (secrets — stays local, always).
  // `derive context push` ships everything in it except .env*.
  context: {
    entry: "context",
    files: (t) => ({
      "context/MANIFEST.md": starterManifest(t),
      "context/references/example.md": STARTER_CONTEXT_REFERENCE,
      "context/.mcp.json": `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      "context/.env.example": STARTER_CONTEXT_ENV,
      ".gitignore": CONTEXT_GITIGNORE,
    }),
    // The context block pins the server-side wiring (context id, agent id) the
    // way `id` pins the artifact — filled in by the first `derive context push`.
    extend: (config, title) => ({ ...config, context: { id: null, agent_id: null, name: title } }),
  },
}

/**
 * Files a new project gets for a template. derive.json drives publishing; AGENTS.md
 * is the loop convention for agents; the starter is publishable immediately. The
 * agent on-ramp ships too: a Claude Code skill (.claude/skills/derive) and a project
 * MCP config (.mcp.json) so "let my agent ship the page and bring comments back"
 * is wired the moment the project exists.
 */
export function scaffoldFiles(title = "My artifact", template = "md") {
  const t = STARTERS[template] ?? STARTERS.md
  const config = t.extend
    ? t.extend(defaultConfig(title, t.entry), title)
    : defaultConfig(title, t.entry)
  return {
    [CONFIG_FILE]: `${JSON.stringify(config, null, 2)}\n`,
    "derive.schema.json": `${JSON.stringify(DERIVE_SCHEMA, null, 2)}\n`,
    ...t.files(title),
    "AGENTS.md": AGENTS_MD,
    ".claude/skills/derive/SKILL.md": SKILL_MD,
    ".mcp.json": `${JSON.stringify(MCP_CONFIG, null, 2)}\n`,
  }
}

/** Project-scoped MCP config (Claude Code et al. read `.mcp.json`). Reads the
 *  server (and which signed-in account/workspace to act as) from the
 *  environment so no secret is written to disk — the token itself comes from
 *  the same `derive login` store this file's credential functions read, shared
 *  with the CLI, with DERIVE_TOKEN as an escape hatch for a static bearer.
 *  `npx -y @derive-to/mcp` needs no install. */
// Shell-style env expansion the agent harness resolves when it reads .mcp.json:
// `${VAR:-default}`. Assembled from parts so the source carries no literal
// template placeholder (which a plain JS string shouldn't).
const envRef = (name, fallback = "") => ["${", name, ":-", fallback, "}"].join("")

const MCP_CONFIG = {
  mcpServers: {
    derive: {
      command: "npx",
      args: ["-y", "@derive-to/mcp"],
      env: {
        DERIVE_SERVER: envRef("DERIVE_SERVER", "http://localhost:8080"),
        DERIVE_ACCOUNT: envRef("DERIVE_ACCOUNT"),
        DERIVE_WORKSPACE: envRef("DERIVE_WORKSPACE"),
        DERIVE_TOKEN: envRef("DERIVE_TOKEN"),
      },
    },
  },
}

/** JSON Schema for derive.json — gives editors autocomplete + validation. */
export const DERIVE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "derive.json",
  type: "object",
  properties: {
    title: { type: "string", description: "Artifact title." },
    entry: { type: "string", description: "File or directory `derive publish` targets." },
    visibility: {
      enum: ["public", "link", "org", "password", "private", "unlisted"],
      default: "private",
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
      description: "Context wiring (context projects only); ids are set by the first push.",
      properties: {
        id: { type: ["string", "null"], description: "Context id (ctx_…)." },
        agent_id: { type: ["string", "null"], description: "The answering agent's id (ag_…)." },
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
 * Write the scaffold into `dir`. Never clobbers existing files. Returns
 * { created: [...], skipped: [...] }.
 */
export function scaffold(dir = ".", title = "My artifact", template = "md") {
  mkdirSync(dir, { recursive: true })
  const files = scaffoldFiles(title, template)
  const created = []
  const skipped = []
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name)
    if (existsSync(path)) {
      skipped.push(name)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    created.push(name)
  }
  return { created, skipped }
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

const starterManifest = (title) => `# ${title} — context manifest

This file is the runner's system prompt. Editing it (and pushing) reconfigures
the agent's judgment with no redeploy — the next answer uses the new version.

## Who you are

Describe the agent in a sentence: what it knows, who asks it questions, and on
whose behalf it answers.

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

const STARTER_CONTEXT_ENV = `# Secrets the context's MCP servers need (see .mcp.json). Copy to .env and fill
# in — .env stays on this machine: push excludes it and .gitignore covers it.
# EXAMPLE_API_KEY=
`

const CONTEXT_GITIGNORE = `# Secrets never leave the machine: .env holds the context's credentials, .derive/
# holds the agent token minted by the first push.
context/.env
.derive/
`

const starterMd = (title) => `# ${title}

Edit this, then run \`derive publish\`. Every publish becomes a new version at the
same URL, and reviewers can comment on the rendered page.

## Tips for durable comments

Comments anchor to the words they're attached to. They survive edits best when
surrounding text stays recognizable — keep headings stable and avoid rewording
a sentence end to end when you only meant to tweak it. See STANDARD.md.
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

// Pure-HTML slides with a real presentation layer: on-screen prev/next +
// fullscreen, keyboard, and the derive-deck protocol so the Derive viewer can drive
// it too (postMessage). Self-contained, renders in the sandbox.
const starterSlides = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root{--bg:#15101f;--fg:#f6e9d6;--ac:#b9aef0;--mut:#a99cc4}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{background:var(--bg);color:var(--fg);font:20px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}
  .deck{height:100%}
  .slide{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;
    padding:8vh 10vw;animation:in .35s ease}
  .slide.on{display:flex}
  @keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  h1{font-size:clamp(34px,6vw,68px);letter-spacing:-.025em;line-height:1.05;margin:0 0 .3em}
  h2{font-size:clamp(26px,4vw,44px);letter-spacing:-.02em;margin:0 0 .4em}
  p,li{font-size:clamp(18px,2.4vw,26px);color:var(--fg)}
  .lede{color:var(--mut)}
  ul{padding-left:1.1em} li{margin:.3em 0}
  .bar{position:fixed;bottom:0;left:0;right:0;height:3px;background:rgba(255,255,255,.08)}
  .bar i{display:block;height:100%;background:var(--ac);transition:width .3s}
  /* on-screen controls — fade in on hover/move, always reachable */
  .ctrl{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;
    background:rgba(20,16,31,.72);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:6px 8px;
    backdrop-filter:blur(8px);opacity:0;transition:opacity .25s;z-index:5}
  body:hover .ctrl,.ctrl:focus-within{opacity:1}
  .ctrl button{width:34px;height:34px;border:0;border-radius:50%;background:transparent;color:var(--fg);
    font-size:16px;cursor:pointer;display:grid;place-items:center}
  .ctrl button:hover{background:rgba(255,255,255,.12)}
  .ctrl .pos{font-size:13px;color:var(--mut);padding:0 8px;font-variant-numeric:tabular-nums;min-width:54px;text-align:center}
  .edge{position:fixed;top:0;bottom:0;width:18vw;border:0;background:transparent;cursor:pointer;z-index:4}
  .edge.l{left:0} .edge.r{right:0}
  kbd{background:rgba(255,255,255,.1);border-radius:4px;padding:1px 6px;font-size:.8em}
</style>
</head>
<body>
<div class="deck">
  <section class="slide on" data-derive-slide="0">
    <h1>${title}</h1>
    <p class="lede">Pure-HTML slides. <kbd>→</kbd> / <kbd>Space</kbd> advance, <kbd>←</kbd> back, <kbd>F</kbd> fullscreen.</p>
  </section>
  <section class="slide" data-derive-slide="1">
    <h2>One idea per slide</h2>
    <ul>
      <li>Write each slide as a <code>&lt;section class="slide" data-derive-slide="N"&gt;</code>.</li>
      <li>Publish with <code>derive publish</code>; reviewers comment on any slide.</li>
      <li>Every publish is a new version at the same URL.</li>
    </ul>
  </section>
  <section class="slide" data-derive-slide="2">
    <h2>Make it yours</h2>
    <p class="lede">Edit the markup and styles. It's just HTML.</p>
  </section>
</div>
<button class="edge l" aria-label="Previous"></button>
<button class="edge r" aria-label="Next"></button>
<div class="bar"><i></i></div>
<div class="ctrl">
  <button data-act="prev" aria-label="Previous slide">‹</button>
  <span class="pos"></span>
  <button data-act="next" aria-label="Next slide">›</button>
  <button data-act="full" aria-label="Fullscreen" title="Fullscreen (F)">⛶</button>
</div>
<script>
  var slides=[].slice.call(document.querySelectorAll('.slide')),i=0;
  var bar=document.querySelector('.bar i'),pos=document.querySelector('.pos');
  function announce(){ // derive-deck protocol: report position to the Derive viewer
    try{parent.postMessage({source:'derive-deck',type:'state',i:i,total:slides.length},'*')}catch(e){}
  }
  function show(n){i=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach(function(s,k){s.classList.toggle('on',k===i)});
    bar.style.width=((i+1)/slides.length*100)+'%';pos.textContent=(i+1)+' / '+slides.length;announce()}
  function full(){if(!document.fullscreenElement){(document.documentElement.requestFullscreen||function(){})()}else{document.exitFullscreen()}}
  addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){e.preventDefault();show(i+1)}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){show(i-1)}
    else if(e.key==='f'||e.key==='F'){full()}
    else if(e.key==='Home'){show(0)} else if(e.key==='End'){show(slides.length-1)}
  });
  document.querySelector('.ctrl').addEventListener('click',function(e){
    var b=e.target.closest('button'); if(!b)return;
    var a=b.getAttribute('data-act'); if(a==='prev')show(i-1); else if(a==='next')show(i+1); else if(a==='full')full()});
  document.querySelector('.edge.l').addEventListener('click',function(){show(i-1)});
  document.querySelector('.edge.r').addEventListener('click',function(){show(i+1)});
  // accept drive commands from the Derive viewer's presentation bar
  addEventListener('message',function(e){var d=e.data;
    if(!d||d.source!=='derive-host'||d.type!=='deck')return;
    if(d.action==='next')show(i+1);else if(d.action==='prev')show(i-1);else if(d.action==='goto')show(d.n)});
  show(0); announce();
</script>
</body>
</html>
`

// Scaffolded into every project: the publish -> review -> revise loop, written
// for an agent (or a human) to follow without prior knowledge of Derive.
const AGENTS_MD = `# Working with Derive

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

## The loop: publish -> review -> revise

The CLI has a verb for each step (all read the artifact id from derive.json):

\`\`\`bash
derive publish                      # 1. publish a draft, share the URL
derive comments                     # 2. read the comment threads (quote · author · state)
# 3. revise the source for the feedback, then:
derive publish --name "Rev 2"       #    publish again — same URL, highlights re-anchor
derive reply <thread_id> "Fixed in this version."   # 4a. discuss
derive resolve <comment_id>         # 4b. close a handled thread  (derive reopen to undo)
derive open                         # open the artifact in a browser
\`\`\`

Each is also a plain HTTP call if you'd rather not shell out — see the API under
\`/v1/artifacts/:id/comments\`. Republishing can resolve threads in one shot:
include \`resolves=<commentId,...>\` in the publish request.

## Keep comments anchorable

Anchors are text quotes with surrounding context. They survive edits when prose
stays recognizable. Prefer small, local edits over wholesale rewrites; keep
headings and distinctive phrases stable. Full guidance: STANDARD.md.

## Using an agent harness

A Claude Code skill ships in \`.claude/skills/derive\`, and \`.mcp.json\` wires the
Derive MCP server (five tools: \`list_artifacts\`, \`read\`, \`catch_up\`, \`comment\`,
\`publish\`). Both the CLI and the MCP server share the same \`derive login\` — no
token to set. If you're signed into more than one account or workspace, pin this
project with \`DERIVE_ACCOUNT\`/\`DERIVE_WORKSPACE\` (or \`workspace\`/\`account\` in
derive.json); \`DERIVE_TOKEN\` remains for a static bearer (CI, no login).
`

// A Claude Code / agent skill: discoverable, trigger-tagged instructions for the
// publish -> review -> revise loop. Mirrors AGENTS.md in skill form so a harness
// surfaces it automatically when the user asks to publish, share, or get feedback.
const SKILL_MD = `---
name: derive-publish
description: Publish this project to Derive — a permanent versioned URL with inline comments — and run the review loop (share, read comments, revise, resolve). Use when the user asks to publish, share, or ship a page, doc, or site, or to read and act on Derive review comments.
---

# Publish to Derive and close the loop

This project is wired to Derive (see \`derive.json\`). Derive hosts an artifact — HTML,
Markdown, or a static site — at a permanent, versioned URL with inline comments,
so a human or another agent reviews on the rendered page and you revise.

## Publish

\`\`\`bash
derive publish              # publishes derive.json "entry" (a file or a built folder)
\`\`\`

Each publish is a new immutable version at the same URL. Name a checkpoint with
\`derive publish --name "Final draft"\`.

## The loop: publish -> review -> revise

\`\`\`bash
derive publish                    # 1. share the URL
derive comments                   # 2. read threads (quote · author · state)
# 3. revise the source for the feedback, then republish:
derive publish --name "Rev 2"     #    same URL, highlights re-anchor
derive reply <thread_id> "Fixed." # 4a. discuss
derive resolve <comment_id>       # 4b. close a handled thread
\`\`\`

If the Derive MCP server is connected (\`.mcp.json\`), prefer its five tools for the same
loop without shelling out: \`catch_up\` (what changed plus open feedback) ->
\`read\` (content) -> \`comment\` (reply/resolve) and/or \`publish\` (pass \`addresses\`
to resolve the threads a revision fixes; \`publish\` goes live or files a proposal based
on your role, or with \`for_review:true\`). \`list_artifacts\` finds an artifact by title.

## Keep comments anchorable

Anchors are text quotes with context; they survive edits when surrounding text
stays recognizable. Prefer small, local edits; keep headings and distinctive
phrases stable. Full guidance: STANDARD.md.
`
