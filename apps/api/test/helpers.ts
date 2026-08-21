import { randomUUID } from "node:crypto"
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
import { buildContext } from "../src/context"
import { DEFAULT_WORKSPACE_NAME } from "../src/lib/http"
import { POOL_USER } from "../src/lib/payer"

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
// its own schema (search_path), created on first use in this file. Same name →
// same schema within a file (mirrors SQLite's `${name}.db`). Pools are tracked so
// afterAll releases them.
//
// The key is per-FILE, not per-worker. A worker runs its files one after another, and while
// VITEST_POOL_ID alone kept CONCURRENT files apart, consecutive files in the same worker shared
// a schema name and relied on a DROP+recreate to separate them. That holds right up until a
// write outlives the file that issued it: an orphaned async write (an un-awaited enqueue, a
// poller mid-tick) then lands in the NEXT file's freshly created schema, and that file fails
// asserting on rows it never wrote — a cross-file failure with no plausible local cause, which
// is exactly how it presented in CI (assertion failures that moved between unrelated files run
// to run, none of them reproducible alone). Under vitest's default isolate:true this module is
// re-imported per file, so a value minted at import time IS a file identity. Two files can no
// longer name the same schema, and leftovers stay in the schema of the file that made them.
const pgStores: TestStore[] = []
const pgSchemas = new Set<string>()
const appSeeds: Promise<void>[] = []
const workerKey = (process.env.VITEST_POOL_ID ?? String(process.pid)).replace(/[^a-z0-9]+/gi, "_")
const fileKey = randomUUID().replace(/-/g, "").slice(0, 10)
const schemaFor = (name: string) =>
  `t_${workerKey}_${fileKey}_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`

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
        `CREATE TABLE IF NOT EXISTS ${schema}."user" (id text primary key, email text, name text, image text, username text, discoverable boolean, profession text, about text, onboarded boolean, brandprint text)`,
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
    `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT, onboarded INTEGER, brandprint TEXT)`,
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
  // The echo broker is opt-in in production (see DERIVE_LOCAL_BROKER); tests are the context it
  // exists for, so it is on here unless a test is specifically asserting the refusing default.
  authProxy(createApp({ allowEchoStub: true, ...deps, token: TEST_TOKEN }))

export const meta = makeStore("default", [])
const sharedApp = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://derive.test",
  token: TEST_TOKEN,
  allowEchoStub: true,
})
// The default app: every request authenticates as the token (owner).
export const app = authProxy(sharedApp)
// The SAME instance + store, but with NO auto-auth — send your own headers; with
// none you are anonymous. For probing anonymous behavior against shared data.
export const anonApp = sharedApp

afterAll(async () => {
  try {
    // makeAuthedApp starts its seed immediately so direct context users see the same initialized
    // store as HTTP callers. Some tests never make a request, so teardown must wait for every
    // seed explicitly before closing any shared Postgres pool.
    await Promise.all(appSeeds)
  } finally {
    if (PG_URL) await Promise.all(pgStores.map((s) => Promise.resolve(s.close()).catch(() => {})))
    else meta.close()
    rmSync(dir, { recursive: true, force: true })
  }
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
  createdAt?: string
  email: string
  name: string | null
  image?: string | null
  username?: string | null
  discoverable?: boolean
  emailVerified?: boolean
}

const fakeAuth = (users: TestUser[]): AppDeps["auth"] =>
  ({
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const u = users.find((x) => x.email === headers.get("x-test-user"))
        return u
          ? {
              user: {
                ...u,
                // Most fixtures predate signup attribution. Keep them outside its
                // deliberately short acceptance window unless a test opts in.
                createdAt: u.createdAt ?? "2020-01-01T00:00:00.000Z",
              },
            }
          : null
      },
    },
  }) as unknown as AppDeps["auth"]

/**
 * Give a workspace a POOL model plan, so work in it can be paid for.
 *
 * Every enqueue lane now refuses to queue work nothing can pay for (src/lib/payer.ts). That is
 * right in production and pure noise in a test about retry backoff or webhook coalescing, so
 * makeAuthedApp connects one by DEFAULT and the tests that are ABOUT the payer opt out with
 * `{ noPlan: true }`.
 *
 * Written straight to the store rather than through the route: the route encrypts, while the
 * payer chain only asks whether a credential EXISTS. Keeping this dumb means a change to how
 * secrets are stored can never quietly make every fixture unpayable.
 */
export const connectPoolPlan = async (
  meta: MetaStore,
  orgId = "default",
  provider: "claude-code" | "codex" = "claude-code",
) => {
  const now = new Date().toISOString()
  await meta.setModelCredential({
    id: `mc_pool_${orgId}_${provider}`,
    org_id: orgId,
    user_id: POOL_USER,
    provider,
    kind: "api_key",
    secret: "sk-test-pool",
    hint: "test",
    created_at: now,
    updated_at: now,
  })
}

export const makeAuthedApp = (
  name: string,
  users: TestUser[],
  defaultRole?: AppDeps["defaultRole"],
  opts?: {
    isolated?: boolean
    deps?: Partial<AppDeps>
    noPlan?: boolean
    noAutomate?: boolean
    operatorIds?: string[]
  },
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
  // The workspace plan, AWAITED ON FIRST REQUEST rather than fired and forgotten.
  //
  // Two earlier shapes were both wrong. A floating `void connectPoolPlan(...)` raced the Postgres
  // pool: the file ends, the pool closes, the stray insert lands after it ("Cannot use a pool
  // after calling end on the pool"). A `beforeAll` hook fixed that but broke the other call
  // pattern — some suites build their app INSIDE a test, and a hook registered at that point
  // never fires, so every ask came back 402 and sessions were undefined.
  //
  // Gating `app.request` covers both: whoever calls first pays the wait, it always completes
  // before the pool closes, and there is no floating promise to go unhandled.
  // Seeded on the same awaited-on-first-request promise as the plan, and for the same reason: a
  // floating write races the pool's close, and a beforeAll hook never fires for suites that build
  // their app inside a test.
  //
  // AUTOMATIONS ARE BETA and off per workspace, so the shared test workspace opts IN here rather
  // than in each of the fifteen suites that create one. That the default is closed is proved
  // deliberately in automate-gate.test.ts, which builds apps WITHOUT this seed, instead of being
  // proved incidentally by every other suite having to remember.
  const planReady = (async () => {
    const authorityStore = opts?.deps?.meta ?? m
    for (const userId of opts?.operatorIds ?? []) await authorityStore.addInstanceOperator(userId)
    if (!opts?.noPlan) await connectPoolPlan(m, "default").catch(() => undefined)
    // `noAutomate` opts OUT: the suite that asserts the shipped DEFAULTS has to see the real ones,
    // and a blanket seed would have made that assertion quietly lie about this exact field.
    if (opts?.noAutomate) return
    const current = await m.getOrgSettings("default").catch(() => null)
    if (current)
      await m.setOrgSettings("default", { ...current, automateBeta: true }).catch(() => undefined)
  })()
  appSeeds.push(planReady)
  const deps: AppDeps = {
    meta: m,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    token: "tok",
    auth: fakeAuth(users),
    defaultRole,
    defaultOrgId: "default",
    allowEchoStub: true,
    ...opts?.deps,
  }
  const app = createApp(deps)
  const gated = new Proxy(app, {
    get: (target, prop, recv) => {
      if (prop !== "request") return Reflect.get(target, prop, recv)
      return async (...args: Parameters<typeof app.request>) => {
        await planReady
        return app.request(...args)
      }
    },
  })
  // THE STORE IS GATED ON THE SAME PROMISE, and it has to be.
  //
  // `planReady` does a READ-MODIFY-WRITE of org settings (it reads the row, then writes it back
  // with automateBeta on). A test that writes settings directly — comment-fanout's "email
  // toggle off", say — goes through the store, which was NOT gated, so the two raced: when the
  // seed's write landed second it put back the copy it had read BEFORE the test's write, and
  // the toggle the test had just switched off came back on. The test then failed asserting on
  // behaviour it had correctly configured, in a file nobody had touched.
  //
  // It is timing-dependent, so it hid locally and surfaced on CI's parallel runner. Gating both
  // ends orders the seed first and leaves the test's write as the one that survives, which is
  // what every one of these tests already assumes.
  //
  // Only string-keyed methods are wrapped, and `then` is passed through untouched: on the
  // Postgres lane the store is itself a deferring Proxy that answers every property with a
  // function, and wrapping `then` would make this object thenable — `await`ing it anywhere
  // would then resolve to something that is not the store.
  const gatedMeta = new Proxy(m, {
    get: (target, prop, recv) => {
      const value = Reflect.get(target, prop, recv)
      if (typeof prop !== "string" || prop === "then" || typeof value !== "function") return value
      const fn = value as (...a: unknown[]) => unknown
      return (...args: unknown[]) => planReady.then(() => fn.apply(target, args))
    },
  })
  // The SAME deps the app runs on, assembled into a context — for the code that takes an
  // AppContext rather than an HTTP request (the chat tool surface, say). `buildContext` is a
  // pure assembly of closures over `deps`, so this is the app's own context in every way that
  // matters, and a test can seed over HTTP and then act through it against one store.
  return { app: gated, meta: gatedMeta, ctx: buildContext(deps) }
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
export const jsonAs = (
  headers: Record<string, string>,
  body: unknown,
  /** POST unless a test is exercising an edit route. */
  method: "POST" | "PATCH" | "PUT" = "POST",
) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
})

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

/**
 * Wrap a store so every method call is recorded by name, in order.
 *
 * The round-trip budgets and the authorization-memoization test both assert at the STORE
 * BOUNDARY, because that is where the ~80ms edge cost is (see round-trip-budget.test.ts).
 *
 * Counting happens in a `get`-level Proxy rather than by patching methods, and that detail
 * is load-bearing: the pg test store is ITSELF a Proxy deferring to an async-created store,
 * so assigning over its methods silently counts nothing. That mistake once made a test pass
 * on SQLite while measuring absolutely nothing on Postgres — which is the whole reason this
 * lives in one place now instead of being re-derived per test file.
 *
 * Pair it with a second `makeAuthedApp` whose `deps.meta` is the returned proxy: the first
 * app owns the store, the probe app drives requests through the wrapper around that same
 * store, so both see identical data. Give the probe its own NAME — two apps sharing a name
 * share a Postgres schema and race to create it.
 */
export const countingStore = (inner: MetaStore) => {
  const calls: string[] = []
  /** The same calls WITH their arguments. A second array rather than a richer `calls`, because
   *  `calls` is a string list two round-trip-budget suites already snapshot and compare. */
  const withArgs: { method: string; args: unknown[] }[] = []
  const proxy = new Proxy(inner, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv)
      if (typeof value !== "function" || typeof prop !== "string") return value
      return (...args: unknown[]) => {
        calls.push(prop)
        withArgs.push({ method: prop, args })
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return {
    proxy,
    /** Every call made since the last `reset()`, in order — the budget unit. */
    calls,
    reset: () => {
      calls.length = 0
      withArgs.length = 0
    },
    /** How many times one method was called. */
    countOf: (method: string) => calls.filter((c) => c === method).length,
    /**
     * How many times one method was called WITH PARTICULAR ARGUMENTS.
     *
     * Some budgets are per-ROW rather than per-method: `getOrgSettings` is called for a
     * workspace several times in a turn quite legitimately, while a second read of the reserved
     * instance row in the same turn is the regression. Counting by name alone cannot tell those
     * apart, and the alternative — a bespoke proxy in one test file — is the thing this helper
     * exists to prevent (see above; patching methods measures nothing on Postgres).
     */
    countWhere: (method: string, match: (args: unknown[]) => boolean) =>
      withArgs.filter((c) => c.method === method && match(c.args)).length,
  }
}
