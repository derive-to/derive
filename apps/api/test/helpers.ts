import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MetaStore, Role } from "@dock/core"
import { PgMetaStore } from "@dock/db/pg"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import Database from "better-sqlite3"
import { Pool } from "pg"
import { afterAll } from "vitest"
import { type AppDeps, createApp } from "../src/app"
import { DEFAULT_WORKSPACE_NAME } from "../src/lib/http"

export const dir = mkdtempSync(join(tmpdir(), "dock-test-"))

// ---- Backend selection -----------------------------------------------------
// `pnpm test` runs the embedded SQLite path (zero-config). Set DOCK_TEST_DB=pg
// + TEST_DATABASE_URL to point the SAME test files at Postgres, so the hosted-
// tier driver is exercised by the full behavioral suite, not just typecheck.
// `scripts/test-pg.sh` spins up an ephemeral container and wires both vars.
const PG_URL = process.env.DOCK_TEST_DB === "pg" ? process.env.TEST_DATABASE_URL : undefined
if (process.env.DOCK_TEST_DB === "pg" && !PG_URL)
  throw new Error("DOCK_TEST_DB=pg requires TEST_DATABASE_URL to be set")

type TestStore = MetaStore & { close(): unknown }
// A seat in the shared test workspace: who, at what role.
type Seat = { user_id: string; role: Role }

// Postgres has no file-per-store isolation like SQLite, so each named store gets
// its own schema (search_path), dropped + recreated on first use in this process.
// Same name → same schema (mirrors SQLite's `${name}.db`); the pid keeps parallel
// test files from colliding. Pools are tracked so afterAll can release handles.
const pgStores: TestStore[] = []
const pgSchemas = new Set<string>()
const schemaFor = (name: string) =>
  `t_${process.pid}_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`

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
        `CREATE TABLE IF NOT EXISTS ${schema}."user" (id text primary key, email text, name text, image text)`,
      )
      for (const u of users)
        await boot.query(
          `INSERT INTO ${schema}."user" (id, email, name, image) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [u.id, u.email, u.name, u.image ?? null],
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
    `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT)`,
  )
  const ins = raw.prepare(`INSERT OR IGNORE INTO user (id, email, name, image) VALUES (?,?,?,?)`)
  for (const u of users) ins.run(u.id, u.email, u.name, u.image ?? null)
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

export const meta = makeStore("default", [])
export const app = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://dock.test",
})

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
  return app.request(url, { method: "POST", body: form })
}

export const postJson = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
export type TestUser = { id: string; email: string; name: string | null; image?: string | null }

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
    baseUrl: "http://dock.test",
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
// A fresh app with custom deps. Without `users` it's an open instance (anonymous
// = owner) — handy for quota/anonymous-flood tests; with `users` it's secured
// and the session is picked by an `x-test-user` header, for per-actor tests.
export const quotaApp = (name: string, extra: Partial<AppDeps>, users?: TestUser[]) => {
  const m = makeStore(name, users ?? [])
  const app = createApp({
    meta: m,
    blobs: new FsBlobStore(join(dir, `blobs-${name}`)),
    baseUrl: "http://dock.test",
    ...(users ? { token: "tok", auth: fakeAuth(users) } : {}),
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
  return app.request(url, { method: "POST", body: form, headers })
}
