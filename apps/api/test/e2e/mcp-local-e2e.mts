/**
 * Local E2E: a REAL HTTP Derive (createApp + @hono/node-server serve) driven over
 * the /mcp Streamable-HTTP endpoint, exercising the consolidated tool surface end to
 * end — including a genuine out-of-band content upload (stage -> curl bytes -> read
 * back). Not a vitest test (it binds a socket); run manually:
 *   cd apps/api && pnpm exec tsx test/e2e/mcp-local-e2e.mts
 * Exits 0 on success, 1 on the first failed assertion. Self-seeds an OAuth grant
 * (auto-provisions a personal workspace at owner grade), so no external state.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { createApp } from "../../src/app"
import { createInProcessBackplane } from "../../src/bus"
import { sha256 } from "../../src/lib/crypto"

const PORT = 8199
const BASE = `http://localhost:${PORT}`
const BEARER = "tok_e2e"
const BEARER_PUB = "tok_pub" // a publish-but-not-manage grant, for the Brandprint manage-gate proof

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

const dir = mkdtempSync(join(tmpdir(), "derive-e2e-"))
const dbPath = join(dir, "derive.db")

// --- seed the OAuth grant (budget-test pattern: manual Better-Auth-ish tables the
// getOAuthGrant path reads by hashed token; manage scope => owner grade) ---
const seed = new Database(dbPath)
seed.exec(`
  CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT);
  CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
`)
seed.prepare(`INSERT OR IGNORE INTO "user"(id,email,name,username) VALUES('u_e2e','e2e@x.test','E2E User','e2e')`).run()
seed.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude Code')`).run()
seed
  .prepare(`INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`)
  .run(
    sha256(BEARER),
    "cli",
    "u_e2e",
    JSON.stringify(["openid", "derive:read", "derive:publish", "derive:manage"]),
    new Date(Date.now() + 3_600_000).toISOString(),
  )
seed.prepare(`INSERT OR IGNORE INTO "user"(id,email,name,username) VALUES('u_pub','pub@x.test','Publish Only','pub')`).run()
seed
  .prepare(`INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`)
  .run(
    sha256(BEARER_PUB),
    "cli",
    "u_pub",
    JSON.stringify(["openid", "derive:read", "derive:publish"]),
    new Date(Date.now() + 3_600_000).toISOString(),
  )
seed.close()

const meta = new SqliteMetaStore(dbPath)
const blobs = new FsBlobStore(join(dir, "blobs"))
// A minimal session shim (the integration tests' fakeAuth): an `x-test-user` header
// picks the acting user. It drives the MANAGEMENT REST endpoints (register an agent,
// create a context) that have no MCP path — the OAuth/agent bearer paths are untouched
// by it, so the human-surface checks above still run exactly as before.
const E2E_USER = { id: "u_e2e", email: "e2e@x.test", name: "E2E User", username: "e2e" }
const fakeAuth = {
  handler: async () => new Response(null, { status: 404 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) =>
      headers.get("x-test-user") === E2E_USER.email ? { user: E2E_USER } : null,
  },
  // biome-ignore lint/suspicious/noExplicitAny: test-only auth stand-in
} as any
const app = createApp({
  meta,
  blobs,
  baseUrl: BASE,
  token: "dev-operator",
  encryptionKey: "e2e-secret",
  backplane: createInProcessBackplane(),
  auth: fakeAuth,
})
const server = serve({ fetch: app.fetch, port: PORT })
// A management REST call as the E2E user (session shim; no bearer).
const restPost = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": E2E_USER.email },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

let id = 0
const rpc = async (method: string, params: Record<string, unknown> = {}, bearer = BEARER) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  })
  const txt = await res.text()
  const ct = res.headers.get("content-type") ?? ""
  const body = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse((txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim())
  return { status: res.status, body }
}
// A tools/call, returning the parsed text content (tools return a JSON text block).
const call = async (name: string, args: Record<string, unknown> = {}, bearer = BEARER) => {
  const { body } = await rpc("tools/call", { name, arguments: args }, bearer)
  const text: string | undefined = body?.result?.content?.[0]?.text
  const isError = !!body?.result?.isError
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { text, json: json as Record<string, unknown> | null, isError, raw: body }
}

const main = async () => {
  // 1. initialize + tools/list — the surface is the consolidated ten, no retired names.
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" },
  })
  const list = await rpc("tools/list")
  const names: string[] = (list.body?.result?.tools ?? []).map((t: { name: string }) => t.name).sort()
  console.log(`\n[surface] ${names.length} tools: ${names.join(", ")}`)
  const RETIRED = ["search", "list_artifacts", "list_contexts", "check_requests", "stage_asset", "stage_publish", "setup_brandprint", "ask"]
  ok(names.length <= 11, `tool count is small (${names.length}, target 10-11)`)
  for (const r of RETIRED) ok(!names.includes(r), `retired tool '${r}' is gone`)
  for (const keep of ["find", "read", "catch_up", "comment", "publish", "stage", "use", "checkpoint", "list_workspaces"])
    ok(names.includes(keep), `tool '${keep}' present`)

  // 2. find (browse) on an empty workspace — should not error, returns a structured result.
  console.log("\n[find] browse empty workspace")
  const f0 = await call("find")
  ok(!f0.isError, "find (browse) does not error with no acting-human problems")

  // 3. publish CREATE a small doc inline.
  console.log("\n[publish] create inline")
  const p1 = await call("publish", { title: "E2E Doc", content: "# Hello\n\nFirst version." })
  ok(!p1.isError, "publish create did not error")
  const shortId = (p1.json?.short_id as string) || (p1.json?.artifact as { short_id?: string })?.short_id
  ok(!!shortId, `publish create returned a short_id (${shortId})`)
  if (!shortId) throw new Error("create returned no short_id — cannot continue")

  // 4. read it back.
  console.log("\n[read] verify content landed")
  const r1 = await call("read", { short_id: shortId })
  ok(!r1.isError && (r1.text ?? "").includes("First version"), "read returns the published content")

  // 5. publish EDITS (surgical) — the safe default path.
  console.log("\n[publish] surgical edits")
  const p2 = await call("publish", {
    short_id: shortId,
    edits: [{ old_str: "First version.", new_str: "Edited version." }],
  })
  ok(!p2.isError, "publish edits did not error")
  const r2 = await call("read", { short_id: shortId })
  ok((r2.text ?? "").includes("Edited version"), "edit applied and is readable")

  // 6. publish GUARDRAILS: oversized base64 -> stage target:asset; oversized total -> stage target:doc.
  console.log("\n[publish] guardrails (base64 + total size)")
  const bigB64 = `data:image/png;base64,${"A".repeat(50_000)}` // ~37.5KB decoded, over the 32KB cap
  const pgB = await call("publish", { title: "Bad Img", content: `<img src="${bigB64}">` })
  ok(pgB.isError && /stage target:.?asset/i.test(pgB.text ?? ""), "oversized inline base64 rejected -> stage target:asset")
  const pgS = await call("publish", { title: "Big Doc", content: "x".repeat(70_000) }) // over the 64KB cap
  ok(pgS.isError && /stage target:.?doc/i.test(pgS.text ?? ""), "oversized inline content rejected -> stage target:doc")

  // 7. find (query) finds the doc by content.
  console.log("\n[find] content query")
  const fq = await call("find", { query: "Edited" })
  ok(!fq.isError && /Edited|E2E Doc/i.test(fq.text ?? ""), "find query surfaces the edited doc")

  // 8. STAGE target:doc — the content-upload path. Mint URL, curl real bytes, read back.
  console.log("\n[stage] doc upload (out-of-band content)")
  const st = await call("stage", { target: "doc" })
  ok(!st.isError, "stage target:doc minted a URL without error")
  const uploadUrl = st.json?.upload_url as string
  ok(!!uploadUrl && uploadUrl.startsWith(BASE), `stage returned a local upload_url (${uploadUrl?.slice(0, 48)}…)`)
  if (uploadUrl) {
    const htmlPath = join(dir, "big.html")
    writeFileSync(htmlPath, `<!doctype html><meta name=viewport content="width=device-width"><h1>Staged Upload</h1><p>${"x".repeat(3000)}</p>`)
    const fd = new FormData()
    fd.append("file", new Blob([readFileSync(htmlPath)], { type: "text/html" }), "big.html")
    fd.append("title", "Staged E2E Page")
    const up = await fetch(uploadUrl, { method: "POST", body: fd })
    const upBody = (await up.json().catch(() => ({}))) as { short_id?: string }
    ok(up.ok, `curl-equivalent upload to stage URL succeeded (HTTP ${up.status})`)
    ok(!!upBody.short_id, `upload created an artifact (${upBody.short_id})`)
    if (upBody.short_id) {
      const rs = await call("read", { short_id: upBody.short_id, render: undefined })
      ok(/Staged Upload/.test(rs.text ?? ""), "the out-of-band uploaded content is readable via read")
    }
  }

  // 9. STAGE target:asset — mint an asset URL (the image/font path).
  console.log("\n[stage] asset upload")
  const sa = await call("stage", { target: "asset" })
  ok(!sa.isError && typeof sa.json?.upload_url === "string", "stage target:asset minted an asset upload URL")
  ok(/asset/i.test((sa.json?.target as string) ?? "asset"), "stage asset response is typed for asset")

  // 10. catch_up no-id = the work queue; an OAuth grant has no inbox -> explicit note.
  console.log("\n[catch_up] no-id queue mode (OAuth grant)")
  const q = await call("catch_up")
  ok(!q.isError, "catch_up with no short_id does not error")
  ok(/inbox|queue|mention|no .*request/i.test(q.text ?? ""), "queue mode returns an explicit note (not a bare empty list)")

  // 11. comment: anchor to a quote, see it in catch_up, resolve it.
  console.log("\n[comment] anchor + catch_up + resolve")
  const c1 = await call("comment", { short_id: shortId, quote: "Edited version.", body: "E2E note." })
  ok(!c1.isError, "comment (new, anchored) did not error")
  const threadId =
    (c1.json?.thread as string) ??
    (c1.json?.thread_id as string) ??
    (c1.json?.comment as { thread?: string; thread_id?: string })?.thread ??
    (c1.json?.comment as { thread_id?: string })?.thread_id
  const cu = await call("catch_up", { short_id: shortId, comments: "open" })
  ok(!cu.isError && /E2E note/.test(cu.text ?? ""), "catch_up surfaces the open comment thread")
  if (typeof threadId === "string") {
    const c2 = await call("comment", { short_id: shortId, reply_to: threadId, set_state: "resolved" })
    ok(!c2.isError, "comment resolve did not error")
  }

  // 12. organize: tag the doc, find it by tag.
  console.log("\n[organize] tag + find by tag")
  const o1 = await call("organize", { short_ids: [shortId], add: ["e2e-tag"] })
  ok(!o1.isError, "organize add-tag did not error")
  const ft = await call("find", { tag: "e2e-tag" })
  ok(!ft.isError && (ft.text ?? "").includes(shortId), "find({tag}) surfaces the tagged doc")

  // 13. checkpoint: create a lineage, then replace it on the same short_id.
  console.log("\n[checkpoint] create + replace")
  const k1 = await call("checkpoint", { work: "e2e-run", state: "testing the surface", next: ["verify the surface"] })
  ok(!k1.isError, "checkpoint create did not error")
  const kId = k1.json?.short_id as string
  ok(!!kId, `checkpoint returned a lineage short_id (${kId})`)
  if (kId) {
    const k2 = await call("checkpoint", { short_id: kId, state: "verified" })
    ok(!k2.isError, "checkpoint replace (same lineage) did not error")
  }

  // 14. stage target:asset -> curl a real PNG -> reference the returned url in a published doc.
  console.log("\n[stage] asset upload + embed")
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  )
  const saM = await call("stage", { target: "asset" })
  const assetUrl = saM.json?.upload_url as string | undefined
  if (assetUrl) {
    const upA = await fetch(assetUrl, { method: "POST", body: png, headers: { "content-type": "image/png" } })
    const upAB = (await upA.json().catch(() => ({}))) as { url?: string }
    ok(upA.ok && !!upAB.url, `asset bytes uploaded, got a permanent url (HTTP ${upA.status})`)
    if (upAB.url) {
      const pe = await call("publish", { title: "Has Image", content: `<img src="${upAB.url}">` })
      ok(!pe.isError, "publish a doc referencing the staged asset url did not error")
    }
  }

  // 15. Brandprint dissolve: a MANAGE grant scaffolds the profile + files a proposal on the URI.
  console.log("\n[brandprint] manage grant scaffolds + proposes")
  const bp = await call("publish", { short_id: "derive://brandprint/profile", content: "<h1>Brand</h1>" })
  ok(!bp.isError, "publish to derive://brandprint/profile (manage grant) did not error")

  // 16. CRITICAL SAFETY: a publish-only (non-manage) grant is REFUSED on the same URI in its OWN
  //     fresh workspace (no profile yet) — the manage-gate must hold, with no writes.
  console.log("\n[brandprint] non-manage grant is refused (manage-gate)")
  const bpN = await call(
    "publish",
    { short_id: "derive://brandprint/profile", content: "<h1>Nope</h1>" },
    BEARER_PUB,
  )
  ok(
    bpN.isError && /admin|owner|manage/i.test(bpN.text ?? ""),
    "non-manage caller refused with an Admin/Owner error (manage-gate holds)",
  )

  // 17. use: an unknown context fails with an actionable error, not a crash.
  console.log("\n[use] graceful with no wired context")
  const u = await call("use", { context: "nonexistent-ctx", instruction: "hi" })
  ok(u.isError && /context|no /i.test(u.text ?? ""), "use with an unknown context returns an actionable error")

  // 18. read render:wait — no renderer configured here, so it must RETURN gracefully, never hang.
  console.log("\n[read] render:wait returns gracefully")
  const rr = await call("read", { short_id: shortId, render: "top", wait: 3 })
  ok(!!rr.text || rr.isError, "read render:wait returned a response (did not hang)")

  // 19. list_workspaces sanity.
  console.log("\n[list_workspaces]")
  const lw = await call("list_workspaces")
  ok(!lw.isError && Array.isArray(lw.json?.workspaces), "list_workspaces returns the grant's workspaces")

  // 20. CONTEXTS end to end: the (context, instruction) roundtrip over the ONE `use` tool.
  //     u_e2e (the OAuth user) is Admin of their auto-provisioned workspace, so via the
  //     session shim they register two agents and create a context; then the whole
  //     give -> pull -> progress -> report loop runs over /mcp with the two dk_agt_ tokens.
  console.log("\n[contexts] register agents + create a context (management REST, session shim)")
  await fetch(`${BASE}/v1/me`, { headers: { "x-test-user": E2E_USER.email } }) // ensure the workspace exists
  const runnerReg = await restPost("/v1/agents", { name: "Walkthrough Runner" })
  const askerReg = await restPost("/v1/agents", { name: "Asker Bot" })
  const runnerToken = runnerReg.json?.token as string | undefined
  const runnerAgentId = runnerReg.json?.id as string | undefined
  const askerToken = askerReg.json?.token as string | undefined
  ok(!!runnerToken && !!runnerAgentId, `registered the runner agent (${runnerAgentId})`)
  ok(!!askerToken, "registered the asker agent")

  // The manifest is authored via the OAuth grant (same ws_p_u_e2e org), then u_e2e wires
  // the context to the runner agent. Default ask_policy = invited => the CREATOR (u_e2e,
  // whom askerToken acts for) may give it instructions. (A bare seeded agent has no
  // workspace membership seat here, so it publishes via the grant, not its own token —
  // that's a harness seeding detail, not the loop under test.)
  const man = await call("publish", { title: "Walkthrough Manifest", content: "# Walkthrough\n\nBuild a per-brand walkthrough." })
  const manifestShortId = (man.json?.short_id as string) || (man.json?.artifact as { short_id?: string })?.short_id
  ok(!!manifestShortId, `published the manifest (${manifestShortId})`)
  const cxRes = await restPost("/v1/contexts", { name: "Walkthrough", agent_id: runnerAgentId, manifest_short_id: manifestShortId })
  const cxId = cxRes.json?.id as string | undefined
  ok(cxRes.status < 300 && !!cxId, `created the context (${cxId}) wired to the runner agent`)
  if (!cxId || !runnerToken || !askerToken) throw new Error("context setup failed — cannot run the roundtrip")

  // 20a. GIVE: the asker hands the context an instruction (names the target). wait:0 so we
  //      drive the runner by hand rather than blocking on it.
  console.log("\n[contexts] GIVE an instruction")
  const give = await call("use", { context: cxId, instruction: "Build the walkthrough for Harborstay.", wait: 0 }, askerToken)
  const sid = give.json?.session_id as string | undefined
  ok(!give.isError && !!sid, `give opened a session (${sid})`)
  ok(give.json?.state === "open", `session starts open (was ${give.json?.state})`)

  // 20b. OWNERSHIP DISPATCH: the asker is NOT the context's agent, so a bare use({context})
  //      (no instruction) is a GIVE with a missing instruction — an error, never a pull.
  const askerBare = await call("use", { context: cxId }, askerToken)
  ok(askerBare.isError && /instruction/i.test(askerBare.text ?? ""), "non-agent bare use({context}) asks for an instruction (does not pull work)")

  // 20c. PULL: the runner (the context's agent) claims its queued work. Bare use({context}),
  //      no instruction => "hand me my sessions". The give flips to `working`.
  console.log("\n[contexts] PULL work as the agent")
  const pull = await call("use", { context: cxId }, runnerToken)
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over the pulled payload
  const pulled = (pull.json?.sessions as any[]) ?? []
  const mine = pulled.find((s) => s.session_id === sid)
  ok(!pull.isError && !!mine, `runner pulled the waiting session (claimed ${pull.json?.claimed})`)
  ok(mine?.state === "working", `pulled session is now working (was ${mine?.state})`)
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over the transcript
  const askerMsg = ((mine?.messages as any[]) ?? []).find((m) => m.author === "asker")
  ok(!!askerMsg && /Harborstay/.test(askerMsg?.body_md ?? ""), "the pulled transcript carries the instruction (names Harborstay)")

  // 20d. A living result page is published (via the grant, per the seeding note above);
  //      the runner BINDS it to the session and REPORTS progress against it.
  console.log("\n[contexts] REPORT progress + bind a result page")
  const building = await call("publish", { title: "Harborstay Walkthrough (building)", content: "<h1>building…</h1>" })
  const resultShortId = (building.json?.short_id as string) || (building.json?.artifact as { short_id?: string })?.short_id
  ok(!!resultShortId, `published the building result page (${resultShortId})`)
  const prog = await call("use", { session_id: sid, answer: "Running the skill chain for Harborstay…", progress: true, result_artifact_id: resultShortId }, runnerToken)
  ok(!prog.isError && prog.json?.state === "working", "progress tick keeps the session working")
  ok(typeof prog.json?.result_url === "string" && (prog.json?.result_url as string).includes(resultShortId ?? "\0"), "report returns a result_url for the bound page")

  // 20e. The asker sees the stream: still working, the progress note, and the result link.
  const watch = await call("use", { session_id: sid, wait: 0 }, askerToken)
  ok(watch.json?.state === "working", "asker sees the session working")
  ok(/skill chain/i.test(JSON.stringify(watch.json?.progress ?? "")), "asker sees the progress note")
  ok(typeof watch.json?.result_url === "string", "asker has the result_url from the first tick")

  // 20f. REPORT the final answer (settles). `answers` = the instruction message id, the
  //      guard against clobbering a mid-run follow-up.
  console.log("\n[contexts] REPORT the final answer (settles)")
  const done = await call("use", { session_id: sid, answer: "Done — the Harborstay walkthrough is live.", state: "answered", answers: askerMsg?.id, result_artifact_id: resultShortId }, runnerToken)
  ok(!done.isError && done.json?.state === "answered", "final report settles the session to answered")

  // 20g. The asker collects the settled answer + the result link.
  const collected = await call("use", { session_id: sid, wait: 0 }, askerToken)
  ok(collected.json?.state === "answered", "asker sees the settled state")
  ok(/is live/i.test(JSON.stringify(collected.json?.answer ?? "")), "asker collects the final answer body")
  ok(typeof collected.json?.result_url === "string", "the result link survives to the settled answer")

  // 20h. IDEMPOTENCY: two gives with the same dedupe_key while one is in flight JOIN one
  //      session (a double "do it for X" never runs twice).
  console.log("\n[contexts] dedupe_key joins an in-flight session")
  const d1 = await call("use", { context: cxId, instruction: "Do it for Delta.", dedupe_key: "brand-delta", wait: 0 }, askerToken)
  const d2 = await call("use", { context: cxId, instruction: "Do it for Delta (again).", dedupe_key: "brand-delta", wait: 0 }, askerToken)
  ok(!d1.isError && !d2.isError && !!d1.json?.session_id && d1.json?.session_id === d2.json?.session_id, "same dedupe_key returns the same session (joined, not duplicated)")
}

main()
  .catch((e) => {
    fails.push(`UNCAUGHT: ${e instanceof Error ? e.stack : String(e)}`)
  })
  .finally(async () => {
    server.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
    console.log(`\n${"=".repeat(50)}\nE2E: ${pass} passed, ${fails.length} failed`)
    if (fails.length) {
      console.log("FAILURES:")
      for (const f of fails) console.log(`  - ${f}`)
    }
    process.exit(fails.length ? 1 : 0)
  })
