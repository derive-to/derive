/**
 * Local, self-contained DEMO of a Maker context — the runnable version of "build it
 * all locally and see the result". Spins up a REAL HTTP Derive (createApp + serve),
 * wires a context to a runner agent, and drives the full (context, instruction) loop
 * over /mcp: GIVE -> PULL -> fill in the result artifact -> settle. It produces a
 * viewable result PAGE (the sample walkthrough), reads it back to prove the round-trip,
 * and writes the rendered HTML to a temp file you can open or screenshot.
 *
 * Not a vitest test (it binds a socket). Run:
 *   cd apps/api && pnpm exec tsx test/e2e/maker-demo.mts
 *
 * Auth mirrors the mcp-local-e2e harness: a seeded OAuth grant is the asker's /mcp
 * bearer; a session shim (x-test-user) drives the management REST (register agent,
 * create context) that has no MCP path; the context's dk_agt_ token is the runner.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { createApp } from "../../src/app"
import { createInProcessBackplane } from "../../src/bus"
import { sha256 } from "../../src/lib/crypto"

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 8231
const BASE = `http://localhost:${PORT}`
const ASKER = "tok_demo_asker" // the asker's OAuth bearer
const HTML = readFileSync(join(HERE, "fixtures/maker-walkthrough.html"), "utf8")
const USER = { id: "u_demo", email: "demo@x.test", name: "Demo User", username: "demo" }

const dir = mkdtempSync(join(tmpdir(), "derive-maker-demo-"))
const dbPath = join(dir, "derive.db")

// Seed the auth/OAuth tables the grant path reads (the budget/e2e pattern): a user,
// an OAuth client, and an access token (stored as its hex sha256).
const seed = new Database(dbPath)
seed.exec(`
  CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT);
  CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
`)
seed.prepare(`INSERT OR IGNORE INTO "user"(id,email,name,username) VALUES(?,?,?,?)`).run(USER.id, USER.email, USER.name, USER.username)
seed.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('demo-cli','Maker Demo CLI')`).run()
seed
  .prepare(`INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`)
  .run(sha256(ASKER), "demo-cli", USER.id, JSON.stringify(["openid", "derive:read", "derive:publish", "derive:manage"]), new Date(Date.now() + 3_600_000).toISOString())
seed.close()

// A minimal session shim for the management REST (register agent, create context):
// an x-test-user header picks the acting user. The OAuth/agent bearer paths are
// untouched by it.
const fakeAuth = {
  handler: async () => new Response(null, { status: 404 }),
  api: { getSession: async ({ headers }: { headers: Headers }) => (headers.get("x-test-user") === USER.email ? { user: USER } : null) },
  // biome-ignore lint/suspicious/noExplicitAny: test-only auth stand-in
} as any

const app = createApp({
  meta: new SqliteMetaStore(dbPath),
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: BASE,
  token: "dev-operator",
  encryptionKey: "demo-secret",
  backplane: createInProcessBackplane(),
  auth: fakeAuth,
})
const server = serve({ fetch: app.fetch, port: PORT })

const rest = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": USER.email },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

let mid = 0
const call = async (bearer: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mid, method: "tools/call", params: { name, arguments: args } }),
  })
  const txt = await res.text()
  const ct = res.headers.get("content-type") ?? ""
  const body = ct.includes("application/json") ? JSON.parse(txt) : JSON.parse((txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim())
  const t: string | undefined = body?.result?.content?.[0]?.text
  // biome-ignore lint/suspicious/noExplicitAny: JSON payload
  let json: any = null
  try { json = t ? JSON.parse(t) : null } catch {}
  return { json, text: t, isError: !!body?.result?.isError }
}

const log = (s: string) => console.log(s)

const main = async () => {
  // Provision the workspace + wire the context to a runner agent (management REST).
  await rest("GET", "/v1/me")
  const wss = await rest("GET", "/v1/workspaces")
  // biome-ignore lint/suspicious/noExplicitAny: JSON payload
  const orgId = ((wss.json?.workspaces as any[]) ?? [])[0]?.id as string
  const reg = await rest("POST", "/v1/agents", { name: "Walkthrough Runner" })
  const runnerToken = reg.json?.token as string
  const runnerAgentId = reg.json?.id as string
  const man = await call(ASKER, "publish", { title: "Walkthrough Manifest", content: "# Walkthrough\n\nBuild a per-brand live walkthrough." })
  const cx = await rest("POST", "/v1/contexts", { name: "Walkthrough", agent_id: runnerAgentId, manifest_short_id: man.json?.short_id })
  const cxId = cx.json?.id as string
  log(`context ${cxId} wired to runner ${runnerAgentId}`)

  // GIVE an instruction, then PULL it as the runner.
  const give = await call(ASKER, "use", { context: cxId, instruction: "Build the walkthrough for Harborstay.", wait: 0, workspace: orgId })
  const sid = give.json?.session_id as string
  const pull = await call(runnerToken, "use", { context: cxId })
  // biome-ignore lint/suspicious/noExplicitAny: JSON payload
  const mine = ((pull.json?.sessions as any[]) ?? []).find((s) => s.session_id === sid)
  // biome-ignore lint/suspicious/noExplicitAny: JSON payload
  const askerMsgId = ((mine?.messages as any[]) ?? []).find((m) => m.author === "asker")?.id
  log(`GIVE -> ${sid} (${give.json?.state}); PULL -> claimed ${pull.json?.claimed}, now ${mine?.state}`)

  // Bind a "building…" placeholder on the first tick (stable result_url), then fill the
  // SAME artifact in to the full page and settle.
  const building = await call(ASKER, "publish", { title: "Sift for Harborstay — Live Walkthrough", content: '<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;padding:40px"><h1>Sift for Harborstay</h1><p>building…</p></body>' })
  const R = building.json?.short_id as string
  await call(runnerToken, "use", { session_id: sid, answer: "Sampling conversations for Harborstay…", progress: true, result_artifact_id: R })
  await call(ASKER, "publish", { short_id: R, content: HTML })
  const done = await call(runnerToken, "use", { session_id: sid, answer: "Done — the Harborstay walkthrough is live.", state: "answered", answers: askerMsgId, result_artifact_id: R })
  log(`result artifact ${R} filled in; session settled -> ${done.json?.state}`)

  // Read it back to prove the round-trip, and write the rendered HTML out.
  const back = await call(ASKER, "read", { short_id: R, format: "html" })
  const roundTrips = /Sift for Harborstay/.test(back.text ?? "") && /Drafted reply/.test(back.text ?? "")
  const out = join(dir, "walkthrough-result.html")
  writeFileSync(out, HTML)
  log(`round-trip read ok=${roundTrips}`)
  log(`\nRESULT`)
  log(`  short_id : ${R}`)
  log(`  url      : ${BASE}/artifacts/${R}   (needs the web SPA to render in a browser)`)
  log(`  rendered : ${out}   (open this file, or screenshot it)`)
}

main()
  .catch((e) => { console.error("DEMO ERROR:", e instanceof Error ? e.stack : String(e)); process.exitCode = 1 })
  .finally(() => server.close())
