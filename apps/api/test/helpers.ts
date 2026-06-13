import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import Database from "better-sqlite3"
import { afterAll } from "vitest"
import { type AppDeps, createApp } from "../src/app"

export const dir = mkdtempSync(join(tmpdir(), "dock-test-"))
export const meta = new SqliteMetaStore(join(dir, "dock.db"))
export const app = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://dock.test",
})

afterAll(() => {
  meta.close()
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

export const makeAuthedApp = (
  name: string,
  users: TestUser[],
  defaultRole?: AppDeps["defaultRole"],
  multiWorkspace?: boolean,
) => {
  const path = join(dir, `${name}.db`)
  const m = new SqliteMetaStore(path)
  const raw = new Database(path)
  raw.exec(
    `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT)`,
  )
  const ins = raw.prepare(`INSERT OR IGNORE INTO user (id, email, name, image) VALUES (?,?,?,?)`)
  for (const u of users) ins.run(u.id, u.email, u.name, u.image ?? null)
  raw.close()
  const auth = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const u = users.find((x) => x.email === headers.get("x-test-user"))
        return u ? { user: u } : null
      },
    },
  } as unknown as AppDeps["auth"]
  const app = createApp({
    meta: m,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://dock.test",
    token: "tok",
    auth,
    defaultRole,
    multiWorkspace,
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
  const path = join(dir, `${name}.db`)
  const m = new SqliteMetaStore(path)
  let auth: AppDeps["auth"]
  if (users) {
    const raw = new Database(path)
    raw.exec(`CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT)`)
    const ins = raw.prepare(`INSERT OR IGNORE INTO user (id, email, name) VALUES (?,?,?)`)
    for (const u of users) ins.run(u.id, u.email, u.name)
    raw.close()
    auth = {
      handler: async () => new Response(null, { status: 404 }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const u = users.find((x) => x.email === headers.get("x-test-user"))
          return u ? { user: u } : null
        },
      },
    } as unknown as AppDeps["auth"]
  }
  const app = createApp({
    meta: m,
    blobs: new FsBlobStore(join(dir, `blobs-${name}`)),
    baseUrl: "http://dock.test",
    ...(users ? { token: "tok", auth } : {}),
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
