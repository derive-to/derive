import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"

// The shared remote-MCP JSON-RPC test harness: seed an OAuth grant straight into the
// oauth-provider tables (what the consent dance produces), boot an app against it, and
// drive tools/call over Streamable HTTP. Extracted from test/mcp.test.ts (the superset)
// and test/billing-gate.test.ts, which both drove the same /mcp surface the same way.

export type McpApp = ReturnType<typeof createApp>

/** `dir` is the caller's own tmpdir (each test file keeps its own mkdtempSync +
 *  afterAll cleanup, for isolation). */
export function appWithGrant(
  dir: string,
  name: string,
  scopes: string,
  extra: Partial<Parameters<typeof createApp>[0]> = {},
) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path)
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT, brandprint TEXT);
    CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
  `)
  db.prepare(
    `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_o','owner@x.test','Owner')`,
  ).run()
  db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude')`).run()
  db.prepare(
    `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
  ).run(
    sha256(`tok_${name}`),
    "cli",
    "u_o",
    JSON.stringify(scopes.split(/\s+/).filter(Boolean)),
    new Date(Date.now() + 3_600_000).toISOString(),
  )
  db.close()
  // A SECOND workspace member with their own grant, for the tests that need a caller who
  // is legitimately in the workspace yet has no claim on a particular artifact. Off by
  // default so every other case keeps its single-identity setup.
  const teammate = (userId: string, tokenName: string, tokenScopes: string): string => {
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS membership (id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, role TEXT);
    `)
    raw.prepare(`INSERT OR IGNORE INTO workspace(id,name) VALUES('default','Default')`).run()
    // Both identities hold a workspace SEAT: that is what makes the leak test meaningful,
    // since a non-member would be filtered by the org predicate alone and the assertion
    // would pass without the visibility gate ever running.
    for (const [uid, role] of [
      ["u_o", "owner"],
      [userId, "editor"],
    ] as const)
      raw
        .prepare(`INSERT OR IGNORE INTO membership(id,org_id,user_id,role) VALUES(?,'default',?,?)`)
        .run(`m_${uid}`, uid, role)
    raw
      .prepare(`INSERT OR IGNORE INTO "user"(id,email,name) VALUES(?,?,?)`)
      .run(userId, `${userId}@x.test`, "Teammate")
    raw
      .prepare(
        `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
      )
      .run(
        sha256(tokenName),
        "cli",
        userId,
        JSON.stringify(tokenScopes.split(/\s+/).filter(Boolean)),
        new Date(Date.now() + 3_600_000).toISOString(),
      )
    raw.close()
    return tokenName
  }
  const blobs = new FsBlobStore(join(dir, `${name}-blobs`))
  const app = createApp({
    meta,
    blobs,
    baseUrl: "http://derive.test",
    token: "tok",
    ...extra,
  })
  return { app, token: `tok_${name}`, meta, blobs, teammate }
}

// POST one JSON-RPC message and return the parsed response, handling both a plain
// JSON body and an SSE-framed (text/event-stream) response.
export async function rpc(app: McpApp, token: string | null, body: unknown) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await app.request("/mcp", { method: "POST", headers, body: JSON.stringify(body) })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  let parsed: { result?: unknown; error?: unknown } | null = null
  if (ct.includes("application/json")) {
    parsed = JSON.parse(txt)
  } else if (ct.includes("text/event-stream")) {
    const dataLine = txt.split("\n").find((l) => l.startsWith("data:"))
    if (dataLine) parsed = JSON.parse(dataLine.slice(5).trim())
  }
  return { status: res.status, ct, txt, parsed, wwwAuth: res.headers.get("www-authenticate") }
}

export type RpcOut = Awaited<ReturnType<typeof rpc>>

export const call = (
  app: McpApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) =>
  rpc(app, token, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })

// The text payload of a tools/call result (throws with context if absent).
export const toolText = (r: RpcOut): string => {
  const t = (r.parsed?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text in response: ${JSON.stringify(r.parsed)}`)
  return t
}

export const toolIsError = (r: RpcOut): boolean =>
  !!(r.parsed?.result as { isError?: boolean } | undefined)?.isError
