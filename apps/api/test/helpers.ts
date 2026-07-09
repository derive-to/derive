import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MetaStore, Role } from "@derive/core"
import { PgMetaStore } from "@derive/db/pg"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { Pool } from "pg"
import { afterAll } from "vitest"
import { type AppDeps, createApp } from "../src/app"
import { DEFAULT_WORKSPACE_NAME } from "../src/lib/http"

export const dir = mkdtempSync(join(tmpdir(), "derive-test-"))

// ---- Backend selection -----------------------------------------------------
// `pnpm test` runs the embedded SQLite path (zero-config). Set DERIVE_TEST_DB=pg
// + TEST_DATABASE_URL to point the SAME test files at Postgres, so the hosted-
// tier driver is exercised by the full behavioral suite, not just typecheck.
// `scripts/test-pg.sh` spins up an ephemeral container and wires both vars.
const PG_URL = process.env.DERIVE_TEST_DB === "pg" ? process.env.TEST_DATABASE_URL : undefined
if (process.env.DERIVE_TEST_DB === "pg" && !PG_URL)
  throw new Error("DERIVE_TEST_DB=pg requires TEST_DATABASE_URL to be set")

type TestStore = MetaStore & { close(): unknown }
// A seat in the shared test workspace: who, at what role.
type Seat = { user_id: string; role: Role }

// Postgres has no file-per-store isolation like SQLite, so each named store gets
// its own schema (search_path), dropped + recreated on first use in this file.
// Same name → same schema (mirrors SQLite's `${name}.db`). A per-worker key
// namespaces the schema so parallel test files never collide: VITEST_POOL_ID is
// unique per worker slot and pool-agnostic (correct under forks OR threads),
// falling back to the pid outside vitest. Isolation also relies on vitest's
// default isolate:true — a fresh module per file re-runs the DROP+recreate below,
// so a worker's next file starts clean. Pools are tracked so afterAll releases them.
const pgStores: TestStore[] = []
const pgSchemas = new Set<string>()
const workerKey = (process.env.VITEST_POOL_ID ?? String(process.pid)).replace(/[^a-z0-9]+/gi, "_")
const schemaFor = (name: string) =>
  `t_${workerKey}_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`

const makePgStore = (name: string, users: TestUser[], team: Seat[]): TestStore => {
  const base = PG_URL as string
  const schema = schemaFor(name)
  const ready = (async (): Promise<TestStore> => {
    // Bootstrap on the default search_path: (re)create the schema and the Better
    // Auth `user` table + seed it, all schema-qualified so search_path is moot.
    const boot = new Pool({ connectionString: base, max: 1 })
    try {
      if (!pgSchemas.has(schema)) {
        await boot.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
        await boot.query(`CREATE SCHEMA ${schema}`)
        pgSchemas.add(schema)
      }
      await boot.query(
        `CREATE TABLE IF NOT EXISTS ${schema}."user" (id text primary key, email text, name text, image text, username text, discoverable boolean, profession text, about text, onboarded boolean)`,
      )
      // Unique handle, mirroring Better Auth's additionalFields(username, unique).
      await boot.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${schema}_user_username ON ${schema}."user" (username)`,
      )
      for (const u of users)
        await boot.query(
          `INSERT INTO ${schema}."user" (id, email, name, image, username, discoverable) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
          // undefined → NULL (unset = discoverable by default), explicit true/false honored.
          [
            u.id,
            u.email,
            u.name,
            u.image ?? null,
            u.username ?? null,
            u.discoverable === undefined ? null : u.discoverable,
          ],
        )
    } finally {
      await boot.end()
    }
    // Encode the search_path manually: URLSearchParams emits `+` for spaces, which
    // node-postgres decodeURIComponent's back to `+` (not a space) → invalid options.
    const opt = encodeURIComponent(`-c search_path=${schema}`)
    const store = await PgMetaStore.create(`${base}${base.includes("?") ? "&" : "?"}options=${opt}`)
    // Seed the shared "default" team inside `ready`, so the Proxy's deferred calls
    // (test requests) only run once the membership rows exist (no race).
    if (team.length) {
      await store.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
      for (const t of team)
        await store.setMembership({
          id: `m_${t.user_id}`,
          org_id: "default",
          user_id: t.user_id,
          role: t.role,
        })
    }
    return store
  })()
  // Every MetaStore method is async, so a Proxy that defers each call until
  // connect+migrate finishes lets the synchronous call sites stay unchanged.
  return new Proxy({} as TestStore, {
    get:
      (_t, prop: string) =>
      (...args: unknown[]) =>
        ready.then((s) =>
          (s as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]?.(...args),
        ),
  })
}

const seedSqliteUsers = (path: string, users: TestUser[]): void => {
  const raw = new Database(path)
  raw.exec(
    `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT, onboarded INTEGER)`,
  )
  // Unique handle, mirroring Better Auth's additionalFields(username, unique).
  raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS user_username ON user (username)`)
  const ins = raw.prepare(
    `INSERT OR IGNORE INTO user (id, email, name, image, username, discoverable) VALUES (?,?,?,?,?,?)`,
  )
  // undefined → NULL (unset = discoverable by default), explicit true/false → 1/0.
  for (const u of users)
    ins.run(
      u.id,
      u.email,
      u.name,
      u.image ?? null,
      u.username ?? null,
      u.discoverable === undefined ? null : u.discoverable ? 1 : 0,
    )
  raw.close()
}

// Seed a shared "default" workspace + memberships (the single-mode default before
// always-multi). The tables exist after SqliteMetaStore migrates on construction.
const seedSqliteTeam = (path: string, team: Seat[]): void => {
  const raw = new Database(path)
  raw
    .prepare(`INSERT OR IGNORE INTO workspace (id, name) VALUES ('default', ?)`)
    .run(DEFAULT_WORKSPACE_NAME)
  const ins = raw.prepare(
    `INSERT OR IGNORE INTO membership (id, org_id, user_id, role) VALUES (?, 'default', ?, ?)`,
  )
  for (const t of team) ins.run(`m_${t.user_id}`, t.user_id, t.role)
  raw.close()
}

// One metadata store per named test app: Postgres schema or SQLite file. Seeds
// the Better Auth `user` table so the share/mention routes can resolve email→id.
const makeStore = (name: string, users: TestUser[], team: Seat[] = []): TestStore => {
  if (PG_URL) {
    const s = makePgStore(name, users, team)
    pgStores.push(s)
    return s
  }
  const path = join(dir, `${name}.db`)
  const m = new SqliteMetaStore(path)
  if (users.length) seedSqliteUsers(path, users)
  if (team.length) seedSqliteTeam(path, team)
  return m
}

// The shared default app is SECURED with a static token — anonymous callers can
// no longer write (open mode is gone). The convenience helpers below
// (`upload`/`postJson`/`pub`) authenticate as that token by default, so most test
// bodies stay unchanged while still exercising the real authz path. Tests that
// probe anonymous behavior stand up their own no-token app.
export const TEST_TOKEN = "tok"
const TOKEN_HEADER = { authorization: `Bearer ${TEST_TOKEN}` }

// Wrap an app so every request auto-authenticates as the static token (owner)
// unless the caller set their own Authorization header. The overwhelming majority
// of tests drive an app to set up + exercise happy paths and never thought about
// auth (anonymous used to be the owner); routing them through the token keeps
// those bodies unchanged against a now-SECURED instance. Anonymous-probe tests
// send no Authorization (or use `anonApp`), so requests there stay anonymous.
export const authProxy = <T extends ReturnType<typeof createApp>>(a: T): T =>
  new Proxy(a, {
    get(target, prop, receiver) {
      if (prop !== "request") return Reflect.get(target, prop, receiver)
      return (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers as HeadersInit | undefined)
        if (!headers.has("authorization")) headers.set("authorization", `Bearer ${TEST_TOKEN}`)
        return target.request(input as string, { ...init, headers })
      }
    },
  }) as T

// A standalone app with custom deps, secured by the test token and wrapped so its
// requests auto-authenticate as that token — the shared `app` with knobs (sandbox
// origin, version window, …).
export const ownerApp = (deps: Omit<AppDeps, "token">) =>
  authProxy(createApp({ ...deps, token: TEST_TOKEN }))

export const meta = makeStore("default", [])
const sharedApp = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://derive.test",
  token: TEST_TOKEN,
})
// The default app: every request authenticates as the token (owner).
export const app = authProxy(sharedApp)
// The SAME instance + store, but with NO auto-auth — send your own headers; with
// none you are anonymous. For probing anonymous behavior against shared data.
export const anonApp = sharedApp

afterAll(async () => {
  if (PG_URL) await Promise.all(pgStores.map((s) => Promise.resolve(s.close()).catch(() => {})))
  else meta.close()
  rmSync(dir, { recursive: true, force: true })
})

export const upload = (
  name: string,
  content: Uint8Array | string,
  fields: Record<string, string> = {},
  shortId?: string,
) => {
  const form = new FormData()
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  form.append("file", new Blob([bytes as BlobPart]), name)
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const url = shortId ? `/v1/artifacts/${shortId}/versions` : "/v1/artifacts"
  return app.request(url, { method: "POST", body: form, headers: TOKEN_HEADER })
}

export const postJson = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...TOKEN_HEADER },
    body: JSON.stringify(body),
  })

export const json = (obj: unknown) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
})

// A faithful role test needs real sessions. We seed Better Auth's `user` table
// (so the share route can resolve email→id) and stand in a fake `auth` whose
// session is chosen by an `x-test-user` header (the user's email). A static
// token keeps the instance secured, so an unauthenticated caller is NOT owner.
export type TestUser = {
  id: string
  email: string
  name: string | null
  image?: string | null
  username?: string | null
  discoverable?: boolean
}

const fakeAuth = (users: TestUser[]): AppDeps["auth"] =>
  ({
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const u = users.find((x) => x.email === headers.get("x-test-user"))
        return u ? { user: u } : null
      },
    },
  }) as unknown as AppDeps["auth"]

export const makeAuthedApp = (
  name: string,
  users: TestUser[],
  defaultRole?: AppDeps["defaultRole"],
  opts?: { isolated?: boolean },
) => {
  // Seed a shared "default" workspace so the user list collaborates (the single-
  // mode default before always-multi): users[0] is the Admin/owner, the rest take
  // defaultRole. `isolated` skips it, so each user provisions their own workspace
  // (the cross-tenant / multi-workspace tests).
  const team: Seat[] =
    opts?.isolated || !users.length
      ? []
      : users.map((u, i) => ({
          user_id: u.id,
          role: i === 0 ? "owner" : (defaultRole ?? "editor"),
        }))
  const m = makeStore(name, users, team)
  const app = createApp({
    meta: m,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    token: "tok",
    auth: fakeAuth(users),
    defaultRole,
    defaultOrgId: "default",
  })
  return { app, meta: m }
}

export const as = (email: string) => ({ "x-test-user": email })
export const publishAs = (
  app: ReturnType<typeof createApp>,
  content: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
  shortId?: string,
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const url = shortId ? `/v1/artifacts/${shortId}/versions` : "/v1/artifacts"
  return app.request(url, { method: "POST", body: form, headers })
}
export const jsonAs = (headers: Record<string, string>, body: unknown) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
})

export const proposeAs = (
  app: ReturnType<typeof createApp>,
  shortId: string,
  content: string,
  headers: Record<string, string> = {},
  fields: Record<string, string> = {},
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return app.request(`/v1/artifacts/${shortId}/proposals`, { method: "POST", body: form, headers })
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

// C4b — launch-gate prevention: storage quotas + per-actor rate limits.
// A fresh app with custom deps, always SECURED by a static token (anonymous
// callers can't write). `pub(app, …)` with no headers authenticates as that
// token; with `users`, an `x-test-user` header picks a session, for per-actor
// tests. Pass `team` to seed the shared "default" workspace + memberships inside
// the store's `ready` step (awaited before any request runs) — the only race-free
// way under Postgres, where firing `meta.setMembership(...)` un-awaited from a test
// body lets `activeWorkspace` read `listWorkspaces` before the write commits.
export const quotaApp = (
  name: string,
  extra: Partial<AppDeps>,
  users?: TestUser[],
  team: Seat[] = [],
) => {
  const m = makeStore(name, users ?? [], team)
  const app = createApp({
    meta: m,
    blobs: new FsBlobStore(join(dir, `blobs-${name}`)),
    baseUrl: "http://derive.test",
    token: TEST_TOKEN,
    ...(users ? { auth: fakeAuth(users) } : {}),
    ...extra,
  })
  return { app, meta: m }
}

// Publish a string payload, optionally as a new version (shortId) and/or as a
// given session (headers). Byte length = the string's UTF-8 length.
export const pub = (
  app: ReturnType<typeof createApp>,
  content: string,
  fields: Record<string, string> = {},
  shortId?: string,
  headers: Record<string, string> = {},
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const url = shortId ? `/v1/artifacts/${shortId}/versions` : "/v1/artifacts"
  // Default to the static token (owner) so a bare `pub(app, …)` writes; an
  // explicit session header (e.g. `as(amy)`) still wins for per-actor tests.
  const h = Object.keys(headers).length ? headers : TOKEN_HEADER
  return app.request(url, { method: "POST", body: form, headers: h })
}
