import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { zipSync } from "fflate"
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
// "how does review work"). It earns a permanent index line because the alternative is an agent
// searching the library for an answer that was never going to be in a document and reporting that
// nothing matched — which reads as the app not having the feature. Trimmed first, per the rule
// above: the summary went in at 147 chars and was cut to 92, taking its index line from 190 to
// 135, the shortest of the eight. Measured 2383, so the cap keeps real headroom rather than the
// 17 characters the trim alone would have left for whoever edits this next.
// RAISED AGAIN 2500 → 2600 (2026-08-02) on merging main: `sources` (#619) and `helping` landed in
// the same window, so the index grew by two lines rather than one and measured 2516. Neither is
// trimmable much further — `sources` is 110 chars and `helping` is already the shortest line of
// the nine at 135, cut from 190 before the first raise. Two skills arriving at once is the thing
// to notice here: the index is now nine lines every connected agent reads before doing anything,
// and the next addition should have to argue that it belongs in the always-loaded set at all.
// INSTRUCTIONS RAISED 2600 → 2750 (2026-08-03) for the `decks` skill, the tenth. It argues
// for the always-loaded set on a different ground than the others: Derive ALREADY had a deck
// protocol, a host deck bar, Present mode, and slide-pinned comments, and none of the nine
// skills mentioned any of it — so agents built decks by hand-rolling navigation and silently
// shipped pages with every one of those features dark. An index line is what makes the
// existing capability reachable at all; the alternative is not a longer read, it is a feature
// nobody finds. Trimmed hard first, per the rule above: the summary went in at 183 chars and
// was cut to 128, taking its index line from 227 to 167. Measured 2684, keeping the ~2%
// headroom the earlier raises settled on. Tool descriptions were NOT raised for this — a
// steer would have needed 8950 → 9000 for a third pointer at the same skill (the index line,
// the publishing-skill steer, and the unannounced-deck publish advisory already cover it), so
// the read tool's short_id doc absorbed the deck URI by replacing its hand-maintained list of
// skill names (already stale — it never gained `sources`) with the generated index it
// duplicated. That freed chars rather than spending them.
// DOC MAP (read `map`/`node`, the addressing surface): added at ~196 chars against the
// SAME ceiling, by keeping both params to one line each and putting the steering in the
// map's own RESPONSE instead ("read one part with read(node:...)"), plus a paragraph in
// the finding skill that is fetched only when a session needs it. The surface teaches
// itself at the moment of use rather than in every session's preamble.
//
// 🚨 That leaves ~14 chars of headroom at 8936/8950. The next param to land here CANNOT
// simply be added: reclaim first (a stale clause, a list a generated index already
// covers), or make the case for raising the ceiling on its own merits.
// 🚨 THE BUDGET USED TO MEASURE A THIRD OF THE SURFACE. Tool descriptions were capped;
// PARAM descriptions — the bigger half by far — were not counted at all, so the tool text
// stayed disciplined while schemas grew unwatched to roughly twice its size. Both are in
// the same always-loaded payload. All three numbers below are measured together now, and
// the one that matters is SURFACE_BUDGET.
//
// The rule that keeps them small, applied when these were cut: a description says WHAT to
// pass and WHAT SILENTLY BREAKS if you get it wrong. Rationale, comparisons with sibling
// params, worked examples and edge-case history go to the skill body, which is fetched only
// by a session that needs it, or to the tool's own RESPONSE, which teaches at the moment of
// use and costs nothing to sessions that never call it.
// PARAMS RAISED 8,000 → 9,300 and SURFACE 11,000 → 12,300 (2026-08-20), for `automate`'s
// fourteen undescribed parameters. This is the one raise so far that does not pay for new
// prose. Those params shipped with NO description at all — `action` had one, the other
// fourteen were bare types — so the budget had been scoring the tool as if they were free.
// They were never free to the agent reading them; they were only invisible to this test,
// which counts characters and cannot count the ones that should have been there.
//
// The cost of leaving them blank was measured, not assumed. In an agent trace, a session
// asked to schedule recurring work read derive://skills/loop (the tool's own steer, which
// never mentioned `automate`), then the artifact, then derive://skills/sources, then
// derive://sources, and finally called automate({action:"list"}) to probe the API for its
// own shape: three of eight calls spent orienting. Five actions share one schema here, so
// "which params does `create` even read" was unstated in a way no other tool's is.
//
// Reclaim was attempted first, per the rule below, and refused: the fourteen longest
// descriptions on the surface were re-read and every one of them earns its length. Trimming
// good text to pay for missing text would have made the surface worse in two places at once.
// The new descriptions were written to the rule — each leads with the action that reads it,
// then names the thing that silently goes wrong — and average 85 characters, below the
// surface's existing mean. Measured 9,134 of 9,300.
// RAISED AGAIN in the same change, 9,300 -> 9,750 and 12,300 -> 12,750, for param
// `examples`. JSON Schema 2020-12 allows the keyword and Zod 4 emits it through `.meta()`,
// so four params that a type genuinely cannot describe now carry worked instances:
// publish.edits (six object shapes behind a union, where the first mistake is passing a
// bare object instead of an array), automate.trigger (which sibling fields a `kind`
// requires is conditional), find.query (the literal-search rule, which reads as advice
// until you see one keyword instead of a question), and read.section (four addressing
// schemes sharing one string). 431 characters for the four. Measured 9,565 of 9,750.
// RAISED 3,200 -> 3,400 / 9,750 -> 9,900 / 12,750 -> 13,250 (2026-08-26), for the
// read/write split of the library and automation surfaces: `organize` became
// browse_library + organize + shelve, and `automate` became list_automations + automate.
// +414 characters of tool description and +138 of param.
//
// This raise buys back approval prompts rather than prose. MCP annotations are declared
// per TOOL, and annotation-honouring clients auto-approve a readOnly tool while prompting
// for a destructive one. `organize` carried permanent deletion (state:'deleted') on the
// same surface that read the tag vocabulary, so it had to declare destructiveHint over all
// of it, and browsing tags prompted exactly as hard as destroying an artifact. `automate`
// had the milder version: `list` sat beside create/run_now, so a read was reachable only
// through a tool declaring itself a write. Neither could be fixed by a parameter, which is
// the carve-out mcp.ts states next to the rule it qualifies.
//
// Reclaim was attempted first, per the rule above, and paid for part of it: the skill
// steer came off the two descriptions whose responses already teach the procedure
// (browse_library, list_automations), and the three new ones were tightened. What
// remains is structural: three routing clauses ("Retiring or deleting is `shelve`",
// "Creating and running them is `automate`", "Listing them is `list_automations`") that
// exist ONLY because the surface split, and two extra copies of the shared `workspace`
// description. Cutting the routing clauses would save 110 characters and recreate exactly
// the dead ends #783 closed: an agent that wants to delete calls `organize`, finds no
// `state`, and has nothing telling it where the verb went.
//
// INSTRUCTIONS 2,400 -> 2,500 in the same change. The instructions carry a one-line index
// of the core skills, and two of those lines name their tools — so a split that renames
// one tool into three lengthens the index whether or not a word of procedure changes. Both
// summaries were tightened first (organize's dropped "the tag vocabulary" and the "and",
// paying for two of the three names it now has to list). What is left is the names
// themselves: an index that still said "(organize)" would be pointing at a third of the
// surface it describes. Note main sat at 2,396 of 2,400 before this, so the ceiling was
// already spent; this raise restores headroom rather than consuming the last of it.
// Measured: descriptions 3,356 of 3,400; params 9,868 of 9,900; total 13,224 of 13,250;
// instructions 2,424 of 2,500.
// RAISED 3,400 -> 3,500 / 13,250 -> 13,350 / instructions 2,500 -> 2,650, and
// MAX_TOOL_DESCRIPTION 420 -> 540 (2026-08-31), for the artifact-routing claim. Users
// with Derive connected were still getting host-native artifacts (Claude Artifacts)
// when they asked for an HTML page: the surface steered against "a wall of chat prose"
// but never claimed precedence over the host's OWN artifact/canvas tool, so the host's
// always-loaded instruction won the tie. The instructions and `publish` now name that
// conflict outright ("publish it HERE, not with a built-in artifact/canvas tool") and
// `publish` leads with what it creates (an HTML page, doc, report, deck) so keyword-based
// tool selection surfaces it for exactly the asks that were drifting. Routing prose that
// exists only because a competing tool does cannot move to a skill body: a skill is
// read AFTER the agent has already chosen Derive, which is the decision this buys.
// Reclaim paid for part of the instructions growth: the claim leans on the artifact
// enumeration it sits under ("gets none of that") instead of restating it.
// Measured: descriptions 3,438 of 3,500; params 9,884 of 9,900; total 13,322 of 13,350;
// instructions 2,579 of 2,650.
const TOOL_DESCRIPTIONS_BUDGET = 3_500
const PARAM_DESCRIPTIONS_BUDGET = 9_900
const SURFACE_BUDGET = 13_350
const INSTRUCTIONS_BUDGET = 2_650

/** No single tool may sprawl: one sentence of routing, the one thing that silently breaks,
 *  and a pointer to its skill. */
const MAX_TOOL_DESCRIPTION = 540
/** No single param may sprawl: what to pass, and what silently breaks. */
const MAX_PARAM_DESCRIPTION = 250

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

    // Publish one workspace skill FIRST, so the measured instructions carry the
    // count-bearing team-skills sentence — the longest variant a real workspace
    // sees — instead of the shorter zero-skill fallback.
    const form = new FormData()
    form.append(
      "file",
      new Blob([zipSync({ "SKILL.md": new TextEncoder().encode("---\nname: probe\n---\n# P") })]),
      "skill.zip",
    )
    form.append("title", "Budget probe")
    await app.request("/v1/artifacts", {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })

    const init = await rpc(app, token, initBody)
    const instructions: string = init?.result?.instructions ?? ""
    expect(instructions).toContain("team skill")
    expect(instructions.length).toBeGreaterThan(0)
    expect(instructions).toContain("Prefer Derive for substantial planning")
    expect(instructions).toContain("instead of a wall of chat prose")
    // The routing claim against the host's own artifact tool — the steer that stops
    // "make me an HTML page" from landing in a chat-local artifact. Must stay in the
    // always-loaded instructions: a skill body loads after the routing decision.
    expect(instructions).toContain("not with a built-in artifact/canvas tool")
    // The core-skills index is still ADVERTISED in the always-loaded instructions —
    // thinning must not drop the pointer that makes the lazy skills discoverable.
    for (const skill of CORE_SKILLS) expect(instructions).toContain(`derive://skills/${skill.name}`)

    const list = await rpc(app, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools: { name: string; description?: string }[] = list?.result?.tools ?? []
    expect(tools.length).toBeGreaterThan(0)

    // Every tool keeps a description (thin, not absent).
    for (const t of tools) expect(t.description, `tool ${t.name} has no description`).toBeTruthy()

    const summed = tools.reduce((n, t) => n + (t.description?.length ?? 0), 0)
    // PARAM descriptions are part of the same always-loaded payload, and for years they
    // were not counted here: the surface was budgeted at its tool descriptions (~8.9k)
    // while its schemas quietly carried ~16k more. Every char of both is re-sent to the
    // model on every turn, so the honest number is the sum.
    // Param `examples` are counted WITH descriptions, deliberately. They are the same
    // always-loaded payload — a JSON Schema keyword that ships inside inputSchema and is
    // re-sent to the model every turn — and leaving them out would recreate exactly the
    // blind spot this budget was widened to close, one keyword later. An example that
    // earns its place is cheaper than the prose it replaces; one that doesn't should
    // fail here like anything else.
    const paramChars = tools.reduce((n, t) => {
      const props = (t as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema
        ?.properties
      return (
        n +
        Object.values(props ?? {}).reduce((m: number, p) => {
          const prop = p as { description?: string; examples?: unknown[] }
          const examples = prop?.examples ? JSON.stringify(prop.examples).length : 0
          return m + (prop?.description?.length ?? 0) + examples
        }, 0)
      )
    }, 0)
    console.log(
      `MCP surface: ${tools.length} tools, descriptions ${summed} chars, params ${paramChars} chars, total ${summed + paramChars} chars, instructions ${instructions.length} chars`,
    )
    expect(summed).toBeLessThan(TOOL_DESCRIPTIONS_BUDGET)
    expect(paramChars).toBeLessThan(PARAM_DESCRIPTIONS_BUDGET)
    expect(summed + paramChars).toBeLessThan(SURFACE_BUDGET)
    expect(instructions.length).toBeLessThan(INSTRUCTIONS_BUDGET)

    // PER-ITEM caps. A total alone lets one description balloon while its neighbours shrink
    // to pay for it — which is precisely how this surface grew to 25k while looking budgeted.
    for (const t of tools) {
      expect(t.description?.length ?? 0, `${t.name}'s description sprawls`).toBeLessThanOrEqual(
        MAX_TOOL_DESCRIPTION,
      )
      const props = (t as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema
        ?.properties
      for (const [param, schema] of Object.entries(props ?? {})) {
        const len = (schema as { description?: string })?.description?.length ?? 0
        expect(len, `${t.name}.${param} sprawls`).toBeLessThanOrEqual(MAX_PARAM_DESCRIPTION)
      }
    }
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
})

describe("the surface does NOT vary by scope", () => {
  // Built, measured and reverted, pinned here so the next attempt confronts the reason.
  //
  // Hiding publish's live-only params (workspace_access, link_role, listed, request_review)
  // from a grant that can only comment saved 197 tokens — 4.1% of the tool surface, and ONLY
  // for read-only connections, which are the ones doing the least work. A publishing agent,
  // the connection that matters, saw every param either way.
  //
  // Against that: derive://skills/publishing names all four outright, and skills are static
  // markdown that cannot vary per connection. A gated agent reads a procedure naming params
  // its schema does not contain — the same contradiction that stopped tool-level gating.
  // Vary the surface only if the skills can vary with it.
  const paramsFor = async (name: string, scopes: string) => {
    const { app, token } = appWithGrant(name, scopes)
    await rpc(app, token, initBody)
    const list = await rpc(app, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools = (list?.result?.tools ?? []) as {
      name: string
      inputSchema?: { properties?: Record<string, unknown> }
    }[]
    return Object.keys(
      tools.find((t) => t.name === "publish")?.inputSchema?.properties ?? {},
    ).sort()
  }

  it("gives a read-only grant the same publish schema as a publishing one", async () => {
    const ro = await paramsFor("same-ro", "openid derive:read")
    const rw = await paramsFor("same-rw", "openid derive:read derive:publish")
    expect(ro).toEqual(rw)
    for (const named of ["workspace_access", "link_role", "listed", "request_review"])
      expect(
        ro,
        `${named} is named by the publishing skill, so it must be in the schema`,
      ).toContain(named)
  })
})
