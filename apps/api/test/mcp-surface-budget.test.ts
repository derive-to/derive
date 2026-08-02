import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import { CORE_SKILLS } from "../src/skills-reference.gen"

// The always-loaded MCP surface — every tool description plus the server
// `instructions` — is context every connected agent pays for on every session,
// before it has done anything. The thin-tools/thick-skills reorg (spec: the
// "Thin tools, thick skills" plan on Derive) moved the workflow/protocol prose OUT of
// that surface and into lazily-read core skills (derive://skills/*, src/skills-reference.ts),
// so each description now states intent, keeps its safety/consequence lines, and steers
// to a skill at the decision point. These budgets keep the surface thin: they sit a
// bit above the measured slimmed result, so blowing one means new prose crept back
// into a description or the instructions — move it into a skill body instead, or raise
// the budget here deliberately, in the same change that explains why.
// Measured after the 15→10 tool consolidation (find merges search/list_artifacts/
// list_contexts; stage merges the two stage_* tools; catch_up absorbs check_requests as
// its no-short_id queue; ask→use; setup_brandprint folded into publish; 5 core skills):
// summed tool descriptions ~7077 chars, representative instructions ~1851 chars. The
// description cap sits ~13% above the measured result; the instructions cap is deliberately
// generous (the high-level block is finalized by hand in review) yet still below the old fat
// prose so a regression to it fails here.
// Raised 8000 → 8250 with contexts management: `automate` (the 11th tool) grew a
// create_context sentence and `use` a run-a-context-you-serve steer (owner-run). Measured
// ~8.06k after trimming — the cap keeps a tight ~2% headroom, so the next addition still
// has to argue for its chars.
// Raised 8250 → 8400 for the auth cleanup, on top of the above: `stage` gained a
// target:'api' clause whose consequence sentence ("a live credential in this transcript")
// must stay in the description per the safety rule, and `list_workspaces` became the
// identity read, which only helps if its description says so. Both were trimmed before
// raising; measured 8218 across 11 tools, so the cap keeps the same ~2% headroom the
// previous raise settled on and the next addition still has to argue for its chars.
// Raised 8400 → 8550 for the read-back loop: `organize` gained the shelving clause (the
// authoring path for removal, and the way back) and `publish` gained one sentence about
// returning the screenshot with the publish. Measured 8353 across 11 tools, so the cap
// keeps the ~2% headroom the previous raises settled on rather than the 47 characters it
// would otherwise leave, where the next edit fails for no reason worth arguing about.
// Raised 8550 → 8800 for contexts-as-packages: `read` now opens a context, so its
// description and its short_id doc have to SAY a ctx_ id is accepted — otherwise the
// capability is unreachable, which is the exact defect being fixed (the surface described
// contexts as ask-only, and `find` went further and said a context row is "never
// read/opened"). `find` and `use` each name the read-or-use pair once. Trimmed first: the
// additions went in at ~360 chars and were cut to ~259 before this raise. Measured 8612
// across 11 tools, keeping the ~2% headroom the previous raises settled on.
// RAISED to 8950 (2026-07-31). Two contributions, one of them not ours: #594 added the facts
// and links_to modes to `find`, which alone took the surface to 8778 — 22 chars of headroom, so
// the next addition of any size was going to force this whether or not it was a good one. Ours
// is the literal-search steer on the same tool: agents were sending whole questions to a
// character-matching search, getting nothing, and reporting an empty workspace. Trimmed 165 → 157
// before raising, per the rule above; the depth lives in derive://skills/finding rather than here.
// Measured 8936 across 11 tools, keeping the ~2% headroom the previous raises settled on.
// INSTRUCTIONS RAISED 2400 → 2500 (2026-08-02) for the `helping` skill: the eighth core skill,
// and the first about DERIVE itself rather than a workspace's contents ("how do I add someone",
// "what is a proposal"). It earns a permanent index line because the alternative is an agent
// searching the library for an answer that was never going to be in a document and reporting that
// nothing matched — which reads as the app not having the feature. Trimmed first, per the rule
// above: the summary went in at 147 chars and was cut to 92, taking its index line from 190 to
// 135, the shortest of the eight. Measured 2383, so the cap keeps real headroom rather than the
// 17 characters the trim alone would have left for whoever edits this next.
const TOOL_DESCRIPTIONS_BUDGET = 8950
const INSTRUCTIONS_BUDGET = 2500

const dir = mkdtempSync(join(tmpdir(), "derive-mcp-budget-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A representative connection: an OAuth grant with read+publish (the common
// claude.ai / Claude Code hookup), no Brandprint, no pending requests.
function appWithGrant(name: string, scopes: string) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path)
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT);
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
  const blobs = new FsBlobStore(join(dir, `${name}-blobs`))
  const app = createApp({ meta, blobs, baseUrl: "http://derive.test", token: "tok" })
  return { app, token: `tok_${name}` }
}

type App = ReturnType<typeof createApp>

async function rpc(app: App, token: string, body: unknown) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const txt = await res.text()
  const ct = res.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) return JSON.parse(txt)
  const dataLine = txt.split("\n").find((l) => l.startsWith("data:"))
  return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  },
}

describe("MCP surface budget (thin tools, thick skills)", () => {
  it("keeps the summed tool descriptions and the instructions under budget", async () => {
    const { app, token } = appWithGrant("budget", "openid derive:read derive:publish")

    const init = await rpc(app, token, initBody)
    const instructions: string = init?.result?.instructions ?? ""
    expect(instructions.length).toBeGreaterThan(0)
    // The core-skills index is still ADVERTISED in the always-loaded instructions —
    // thinning must not drop the pointer that makes the lazy skills discoverable.
    for (const skill of CORE_SKILLS) expect(instructions).toContain(`derive://skills/${skill.name}`)

    const list = await rpc(app, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools: { name: string; description?: string }[] = list?.result?.tools ?? []
    expect(tools.length).toBeGreaterThan(0)

    // Every tool keeps a description (thin, not absent).
    for (const t of tools) expect(t.description, `tool ${t.name} has no description`).toBeTruthy()

    const summed = tools.reduce((n, t) => n + (t.description?.length ?? 0), 0)
    console.log(
      `MCP surface: ${tools.length} tools, descriptions ${summed} chars, instructions ${instructions.length} chars`,
    )
    expect(summed).toBeLessThan(TOOL_DESCRIPTIONS_BUDGET)
    expect(instructions.length).toBeLessThan(INSTRUCTIONS_BUDGET)
  })

  it("resolves every core skill through read('derive://skills/<name>')", async () => {
    // The lazy path the thin surface leans on: each skill body must round-trip through
    // the read tool (every client supports it, even where MCP resources don't), so the
    // steer "read derive://skills/<name>" in a description can never be a dead link.
    const { app, token } = appWithGrant("skills", "openid derive:read derive:publish")
    await rpc(app, token, initBody)

    for (const skill of CORE_SKILLS) {
      const res = await rpc(app, token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read", arguments: { short_id: `derive://skills/${skill.name}` } },
      })
      const raw: string | undefined = res?.result?.content?.[0]?.text
      expect(raw, `read derive://skills/${skill.name} returned no text`).toBeTruthy()
      const payload = JSON.parse(raw as string) as { uri: string; content: string }
      expect(payload.uri).toBe(`derive://skills/${skill.name}`)
      expect(payload.content.length).toBeGreaterThan(0)
      expect(payload.content).toBe(skill.body)
    }
  })

  it("keeps asset staging discoverable as a complete byte-safe workflow", () => {
    const assets = CORE_SKILLS.find((skill) => skill.name === "assets")
    expect(assets).toBeTruthy()
    expect(assets?.summary).toContain("stage image/font bytes")
    expect(assets?.body).toContain('stage({ target: "asset"')
    expect(assets?.body).toContain("Staging alone does not")
    expect(assets?.body).toContain("POST the file's raw")
    expect(assets?.body).toContain("permanent `url`")
    expect(assets?.body).toContain("`ref`")
    expect(assets?.body).toContain("public capability URL")
    expect(assets?.body).toContain('render: "top"')
  })
})
