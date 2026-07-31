import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import { countingStore } from "./helpers"

/**
 * ROUND-TRIP BUDGETS FOR THE MCP SURFACE.
 *
 * The perf register (akvf8ga9) has always listed "MCP tool calls (read / publish / find) |
 * agent-facing path | to measure" — the same 80ms-per-round-trip arithmetic documented
 * throughout this program applies here too, since MCP tool calls run through the exact
 * same Hono app and MetaStore as the REST routes (see mcp.ts — `/mcp` is a route on the
 * same app, not a separate runtime). This closes that "to measure" gap with real counts,
 * using the shared countingStore helper, same as round-trip-budget.test.ts.
 *
 * `catch_up` and `comment` are the two tools this branch already touched (the 3-listComments
 * merge in catch-up.ts, the threadId filter in comment.ts's react/set_state) — this is also
 * the regression guard for that work at the MCP boundary specifically, not just the REST one.
 */

const dir = mkdtempSync(join(tmpdir(), "derive-mcp-budget-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

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
  const { proxy, calls, reset } = countingStore(meta)
  const app = createApp({ meta: proxy, blobs, baseUrl: "http://derive.test", token: "tok" })
  return { app, meta, token: `tok_${name}`, calls, reset }
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

const call = (app: App, token: string, name: string, args: Record<string, unknown>, id = 2) =>
  rpc(app, token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })

describe("MCP tool calls stay within their round-trip budget", () => {
  it("catch_up(short_id) and comment(react/set_state) — measured, not inferred", async () => {
    const { app, meta, token, calls, reset } = appWithGrant(
      "rt",
      "openid derive:read derive:publish",
    )
    await rpc(app, token, initBody)

    // The OAuth user needs a workspace SEAT — direct createArtifact (unlike a real publish)
    // writes no membership row on its own, and workspace_access:"member" gates on exactly
    // that row existing.
    await meta.setMembership({ id: "m_o", org_id: "default", user_id: "u_o", role: "owner" })

    // A realistic target: a published artifact with two open comment threads (one of them
    // with two comments, so catch_up's distinct-open-thread counting has something to prove)
    // and a review round — the shape catch_up's summary line and open_comments both touch.
    const art = await meta.createArtifact({
      id: "art_rt",
      short_id: "rttest01",
      org_id: "default",
      slug: "rt-test",
      title: "RT Test",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(art.id, {
      id: "v1",
      blob_key: "blob_rt",
      content_type: "text/markdown",
      author: "owner",
      message: "v1",
      size_bytes: 10,
    })
    const threadA = "thread_a"
    const threadB = "thread_b"
    await meta.createComment({
      id: "c1",
      artifact_id: art.id,
      thread_id: threadA,
      base_version: 1,
      body_md: "first",
      author: "owner",
      author_id: "u_o",
    })
    await meta.createComment({
      id: "c2",
      artifact_id: art.id,
      thread_id: threadA,
      base_version: 1,
      body_md: "second",
      author: "owner",
      author_id: "u_o",
    })
    await meta.createComment({
      id: "c3",
      artifact_id: art.id,
      thread_id: threadB,
      base_version: 1,
      body_md: "third",
      author: "owner",
      author_id: "u_o",
    })

    reset()
    const res = await call(app, token, "catch_up", { short_id: "rttest01" })
    const text = res?.result?.content?.[0]?.text ?? ""
    expect(text, "catch_up returned no content").toBeTruthy()
    // 3 open COMMENT ROWS (2 in thread_a + 1 in thread_b) — catch_up's summary counts rows,
    // not distinct threads; this is real content for the batched split-by-state read to chew on.
    expect(text).toContain("3 open comment")
    const catchUpCalls = [...calls]

    reset()
    const reactRes = await call(
      app,
      token,
      "comment",
      { short_id: "rttest01", reply_to: threadA, react: "👍" },
      3,
    )
    expect(reactRes?.result?.isError, JSON.stringify(reactRes)).not.toBe(true)
    const reactCalls = [...calls]

    reset()
    const resolveRes = await call(
      app,
      token,
      "comment",
      { short_id: "rttest01", reply_to: threadB, set_state: "resolved" },
      4,
    )
    expect(resolveRes?.result?.isError, JSON.stringify(resolveRes)).not.toBe(true)
    const resolveCalls = [...calls]

    // The measured counts, printed: this test exists to produce them, and a run's own output
    // is what you read when a budget below moves and you need to see WHICH call was added.
    console.log(
      `MCP round trips — catch_up(short_id): ${catchUpCalls.length} [${catchUpCalls.join(", ")}]\n` +
        `MCP round trips — comment(react): ${reactCalls.length} [${reactCalls.join(", ")}]\n` +
        `MCP round trips — comment(set_state): ${resolveCalls.length} [${resolveCalls.join(", ")}]`,
    )

    // THE FIRST THREE CALLS ARE IDENTICAL ON EVERY TOOL CALL: getOAuthGrant,
    // workspacesAndOauthBinding, orgContext — the MCP/OAuth session bootstrap,
    // paid before any tool-specific work starts. This was SEVEN calls (getAgentByToken,
    // getOAuthGrant, listWorkspaces, getOAuthClientWorkspaces, getUsers, getOrgSettings,
    // getUserBrandprint) until this round: getAgentByToken is now skipped outright for any
    // bearer that doesn't start with AGENT_TOKEN_PREFIX (a guaranteed miss for every OAuth/JWT
    // MCP call — see context.ts), getUsers was redundant with the name the grant resolution
    // already had (see OauthAgentResolution.ownerName), and listWorkspaces +
    // getOAuthClientWorkspaces / getOrgSettings + getUserBrandprint each collapsed into one
    // round trip (workspacesAndOauthBinding, orgContext — pg.ts batches, embedded
    // composes). 7 → 3 bootstrap calls, ~320ms/call saved on every single MCP tool call.
    //
    // Budgets below are the measured count, no headroom — same discipline as
    // round-trip-budget.test.ts. Raise deliberately, in the commit that explains why, never to
    // silence a red run.
    expect(catchUpCalls.length).toBeLessThanOrEqual(10)
    expect(reactCalls.length).toBeLessThanOrEqual(7)
    expect(resolveCalls.length).toBeLessThanOrEqual(8)
  })
})
