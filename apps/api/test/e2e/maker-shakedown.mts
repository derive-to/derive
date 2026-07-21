/**
 * Maker SHAKEDOWN — a hands-on battery against a REAL local server, exercising many
 * scenarios over /mcp: happy-path loop + progress streaming, same-asker dedupe,
 * CROSS-ASKER isolation (the privacy fix), follow-up-stays-working (F6), reopen-clears-
 * dedupe, ownership dispatch, escalation/failed, and the concurrency cap.
 *
 * Two askers (alice + bob) share ONE workspace so the cross-asker cases are reachable.
 * Setup is seeded directly through the store (deterministic); only the asks go over /mcp.
 *
 *   cd apps/api && pnpm exec tsx test/e2e/maker-shakedown.mts
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { createApp } from "../../src/app"
import { createInProcessBackplane } from "../../src/bus"
import { sha256 } from "../../src/lib/crypto"

const PORT = 8242
const BASE = `http://localhost:${PORT}`
const TOK_ALICE = "tok_alice"
const TOK_BOB = "tok_bob"
const ALICE = { id: "u_alice", email: "alice@x.test", name: "Alice", username: "alice" }
const BOB = { id: "u_bob", email: "bob@x.test", name: "Bob", username: "bob" }

let pass = 0
const fails: string[] = []
const ok = (cond: unknown, msg: string) => {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fails.push(msg)
    console.log(`  ✗ ${msg}`)
  }
}
const section = (s: string) => console.log(`\n── ${s}`)

const dir = mkdtempSync(join(tmpdir(), "derive-shakedown-"))
const dbPath = join(dir, "derive.db")

// Seed the auth tables the OAuth-grant path reads by hashed token (manage => owner grade).
const seed = new Database(dbPath)
seed.exec(`
  CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT);
  CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
`)
const ins = seed.prepare(`INSERT OR IGNORE INTO "user"(id,email,name,username) VALUES(?,?,?,?)`)
ins.run(ALICE.id, ALICE.email, ALICE.name, ALICE.username)
ins.run(BOB.id, BOB.email, BOB.name, BOB.username)
seed.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Shakedown CLI')`).run()
const insTok = seed.prepare(
  `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
)
const scopes = JSON.stringify(["openid", "derive:read", "derive:publish", "derive:manage"])
const exp = new Date(Date.now() + 3_600_000).toISOString()
insTok.run(sha256(TOK_ALICE), "cli", ALICE.id, scopes, exp)
insTok.run(sha256(TOK_BOB), "cli", BOB.id, scopes, exp)
seed.close()

const store = new SqliteMetaStore(dbPath)

const fakeAuth = {
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const u = headers.get("x-test-user")
      if (u === ALICE.email) return { user: ALICE }
      if (u === BOB.email) return { user: BOB }
      return null
    },
  },
  // biome-ignore lint/suspicious/noExplicitAny: test-only auth stand-in
} as any

const app = createApp({
  meta: store,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: BASE,
  token: "dev-operator",
  encryptionKey: "shakedown-secret",
  backplane: createInProcessBackplane(),
  auth: fakeAuth,
})
const server = serve({ fetch: app.fetch, port: PORT })

const rest = async (user: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

let mid = 0
const call = async (bearer: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mid, method: "tools/call", params: { name, arguments: args } }),
  })
  const txt = await res.text()
  const ct = res.headers.get("content-type") ?? ""
  const body = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse((txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim())
  const t: string | undefined = body?.result?.content?.[0]?.text
  // biome-ignore lint/suspicious/noExplicitAny: JSON payload
  let json: any = null
  try {
    json = t ? JSON.parse(t) : null
  } catch {}
  return { json, text: t, isError: !!body?.result?.isError }
}

const newId = (p: string) => `${p}_${Math.random().toString(36).slice(2, 12)}`

const main = async () => {
  // ---- SETUP: one shared workspace, both askers members, a context on a runner ----
  const W = newId("ws")
  await store.setWorkspace(W, "Team Shakedown")
  await store.setMembership({ id: newId("m"), org_id: W, user_id: ALICE.id, role: "owner" })
  await store.setMembership({ id: newId("m"), org_id: W, user_id: BOB.id, role: "editor" })

  // Runner agent via REST as alice (her only workspace is W, so it lands there).
  const reg = await rest(ALICE.email, "POST", "/v1/agents", { name: "Shakedown Runner" })
  const runnerToken = reg.json?.token as string
  const runnerAgentId = reg.json?.id as string

  // One shared manifest; a FRESH context per scenario so leftover sessions from one
  // never sit in another's cap-1 queue (claim order is oldest-first — cross-scenario
  // pollution, not a product bug, is what a single shared context would introduce).
  const manId = newId("art")
  await store.createArtifact({
    id: manId,
    short_id: newId("s"),
    org_id: W,
    slug: null,
    title: "Shakedown Manifest",
    kind: "file",
    spa: 0,
  })
  let ctxN = 0
  const mkCtx = async (cap = 1): Promise<string> => {
    const id = newId("ctx")
    await store.createContext({
      id,
      org_id: W,
      name: `Shakedown ${++ctxN}`,
      agent_id: runnerAgentId,
      manifest_artifact_id: manId,
      created_by: ALICE.id,
      ask_policy: "workspace",
      max_concurrency: cap,
    })
    return id
  }
  console.log(`setup: ws=${W} runner=${runnerAgentId}`)
  ok(!!runnerToken && !!runnerAgentId, "runner agent registered in the shared workspace")

  const ask = (bearer: string, args: Record<string, unknown>) =>
    call(bearer, "use", { workspace: W, ...args })

  // ---- 1. Happy path: give -> pull -> progress tick -> settle -> collect ----
  section("1. happy path + streaming progress")
  const ctx1 = await mkCtx()
  const g1 = await ask(TOK_ALICE, { context: ctx1, instruction: "Analyze Q3 churn.", wait: 0 })
  const s1 = g1.json?.session_id as string
  ok(!!s1 && g1.json?.state === "open", "alice's give opened a session (open)")

  const pull1 = await call(runnerToken, "use", { context: ctx1 })
  const claimed1 = (pull1.json?.sessions ?? []) as Array<Record<string, unknown>>
  const mine1 = claimed1.find((s) => s.session_id === s1)
  ok(!!mine1 && mine1.state === "working", "runner pulled and claimed it (working)")
  ok(
    JSON.stringify(mine1?.messages ?? []).includes("Analyze Q3 churn"),
    "the claimed session carries alice's instruction",
  )

  const prog = await call(runnerToken, "use", {
    session_id: s1,
    answer: "Pulled 3 months of events, clustering now...",
    progress: true,
  })
  ok(prog.json?.state === "working", "progress tick keeps the session working (not settled)")

  const peek = await ask(TOK_ALICE, { session_id: s1 })
  ok(
    JSON.stringify(peek.json ?? {}).includes("clustering now"),
    "alice sees the streamed progress on her session",
  )

  const ans = await call(runnerToken, "use", {
    session_id: s1,
    answer: "Churn rose 2.1pts, driven by the mobile cohort.",
    state: "answered",
  })
  ok(ans.json?.state === "answered", "runner's terminal answer settled the session")
  const collect = await ask(TOK_ALICE, { session_id: s1 })
  ok(
    JSON.stringify(collect.json ?? {}).includes("mobile cohort"),
    "alice collects the final answer",
  )

  // ---- 2. Same-asker dedupe: same key in flight JOINS the existing session ----
  section("2. same-asker dedupe (idempotent join)")
  const ctx23 = await mkCtx() // scenarios 2 + 3 share a context (dedupe interplay)
  const d1 = await ask(TOK_ALICE, { context: ctx23, instruction: "Run brand X.", dedupe_key: "brand-x", wait: 0 })
  const sd = d1.json?.session_id as string
  const d2 = await ask(TOK_ALICE, { context: ctx23, instruction: "Run brand X again.", dedupe_key: "brand-x", wait: 0 })
  ok(d2.json?.session_id === sd, "alice re-asking with the same key joined her live session")

  // ---- 3. CROSS-ASKER isolation (the privacy fix) ----
  section("3. cross-asker isolation (#2 fix)")
  const b1 = await ask(TOK_BOB, { context: ctx23, instruction: "Bob runs brand X.", dedupe_key: "brand-x", wait: 0 })
  const sb = b1.json?.session_id as string
  ok(!!sb && sb !== sd, "bob's same-key ask got his OWN session, not alice's")
  const bPeek = await ask(TOK_BOB, { session_id: sd })
  ok(bPeek.isError, "bob CANNOT read alice's session by id (no cross-asker leak)")
  const aPeek = await ask(TOK_ALICE, { session_id: sd })
  ok(!aPeek.isError && aPeek.json?.session_id === sd, "alice still reads her own session fine")

  // ---- 4. Follow-up mid-run stays WORKING (F6) ----
  section("4. follow-up mid-run keeps the claim (F6)")
  const ctx4 = await mkCtx()
  const g4 = await ask(TOK_ALICE, { context: ctx4, instruction: "Long job.", wait: 0 })
  const s4 = g4.json?.session_id as string
  await call(runnerToken, "use", { context: ctx4 }) // runner claims s4 -> working
  const fu = await ask(TOK_ALICE, { session_id: s4, instruction: "One more thing while you're at it." })
  ok(!fu.isError, "alice's mid-run follow-up posted")
  const s4state = await ask(TOK_ALICE, { session_id: s4 })
  ok(
    (s4state.json?.state ?? s4state.json?.session?.state) === "working",
    "the session stayed WORKING after the follow-up (claim not vacated)",
  )

  // ---- 5. Reopen a settled keyed session clears its dedupe key ----
  section("5. reopen-settled clears dedupe")
  const ctx5 = await mkCtx()
  const k1 = await ask(TOK_ALICE, { context: ctx5, instruction: "keyed one", dedupe_key: "reopen-key", wait: 0 })
  const sk = k1.json?.session_id as string
  await call(runnerToken, "use", { context: ctx5 }) // claim it
  await call(runnerToken, "use", { session_id: sk, answer: "done", state: "answered" })
  const fu5 = await ask(TOK_ALICE, { session_id: sk, instruction: "actually, follow-up" })
  ok(!fu5.isError, "follow-up on the settled keyed session reopened it")
  const k2 = await ask(TOK_ALICE, {
    context: ctx5,
    instruction: "brand-new same key",
    dedupe_key: "reopen-key",
    wait: 0,
  })
  ok(
    !k2.isError && k2.json?.session_id && k2.json?.session_id !== sk,
    "a NEW session with the same key opens without colliding (dedupe cleared on reopen)",
  )

  // ---- 6. Ownership dispatch: a human bare use({context}) never pulls runner work ----
  section("6. ownership dispatch")
  const bobBare = await ask(TOK_BOB, { context: ctx1 })
  ok(
    bobBare.isError && /instruction/i.test(bobBare.text ?? ""),
    "bob's bare use({context}) asks for an instruction (does NOT pull the runner's queue)",
  )

  // ---- 7 & 8. Escalation and failure terminal states ----
  section("7-8. escalate + fail")
  const ctx78 = await mkCtx()
  const g7 = await ask(TOK_ALICE, { context: ctx78, instruction: "escalate me", wait: 0 })
  const s7 = g7.json?.session_id as string
  await call(runnerToken, "use", { context: ctx78 })
  await call(runnerToken, "use", { session_id: s7, answer: "needs a human", state: "escalated" })
  const e7 = await ask(TOK_ALICE, { session_id: s7 })
  ok((e7.json?.state ?? e7.json?.session?.state) === "escalated", "runner can escalate a session")

  const g8 = await ask(TOK_ALICE, { context: ctx78, instruction: "crash me", wait: 0 })
  const s8 = g8.json?.session_id as string
  await call(runnerToken, "use", { context: ctx78 })
  await call(runnerToken, "use", { session_id: s8, answer: "boom", state: "failed" })
  const e8 = await ask(TOK_ALICE, { session_id: s8 })
  ok((e8.json?.state ?? e8.json?.session?.state) === "failed", "runner can mark a run failed")

  // ---- 9. Concurrency cap: max_concurrency 1 claims one at a time ----
  section("9. concurrency cap (max_concurrency = 1)")
  const ctx9 = await mkCtx(1)
  const ga = await ask(TOK_ALICE, { context: ctx9, instruction: "capA", wait: 0 })
  const gb = await ask(TOK_ALICE, { context: ctx9, instruction: "capB", wait: 0 })
  const sa = ga.json?.session_id as string
  const sbb = gb.json?.session_id as string
  const pullCap = await call(runnerToken, "use", { context: ctx9 })
  const capClaimed = (pullCap.json?.sessions ?? []) as Array<Record<string, unknown>>
  const freshClaimed = capClaimed.filter((s) => s.session_id === sa || s.session_id === sbb)
  ok(freshClaimed.length === 1, "with cap=1 the runner claims only ONE of the two fresh asks")
  // settle the claimed one, then the other becomes claimable
  const firstId = freshClaimed[0]?.session_id as string
  await call(runnerToken, "use", { session_id: firstId, answer: "done", state: "answered" })
  const pullCap2 = await call(runnerToken, "use", { context: ctx9 })
  const capClaimed2 = (pullCap2.json?.sessions ?? []) as Array<Record<string, unknown>>
  const otherId = firstId === sa ? sbb : sa
  ok(
    capClaimed2.some((s) => s.session_id === otherId),
    "after settling the first, the runner claims the second",
  )

  // ---- summary ----
  console.log(`\n── SHAKEDOWN: ${pass} passed, ${fails.length} failed`)
  if (fails.length) for (const f of fails) console.log(`   ✗ ${f}`)
  server.close()
  process.exit(fails.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  server.close()
  process.exit(1)
})
