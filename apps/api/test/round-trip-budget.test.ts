import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BlobStore, MetaStore } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import { as, countingStore, makeAuthedApp, publishAs, type TestUser } from "./helpers"

/**
 * ROUND-TRIP BUDGETS FOR THE HOT READ PATHS.
 *
 * On the hosted edge tier every Postgres round trip costs ~80ms FLAT, whatever it fetches:
 * the Workers runtime cannot hold a connection pool across the request boundary, so the edge
 * opens exactly one `pg.Client` per invocation and node-postgres serializes everything queued
 * on it (see `src/edge-pg.ts`). A `Promise.all` around N store calls does not overlap them —
 * it queues them. Latency on these routes is therefore arithmetic:
 *
 *     time ≈ 80ms × (number of store calls)
 *
 * which makes the store-call count the reviewable unit. A new `await meta.something()` on one
 * of these handlers is not a small cost to be measured later; it is ~80ms, on every request,
 * forever. This test makes that fact fail CI instead of relying on someone noticing in review.
 *
 * HOW IT COUNTS. `countingStore` (see helpers.ts) wraps the store so a call is counted wherever
 * it is made — inside a route, inside middleware, inside `authorize`.
 *
 * WHAT A BUDGET MEANS. It is an upper bound on STORE CALLS, which is very close to but not
 * exactly Postgres round trips: a couple of store methods issue more than one statement, and
 * the batched methods added by the perf program issue exactly one. It is the right unit anyway,
 * because it is the thing a code change adds or removes and the thing a reviewer can count.
 *
 * WHEN THIS FAILS. Do not raise the number to make it pass. Either fold the new read into an
 * existing batched store call (`listEnrichment`, `artifactDetail`, `workspaceSummary`, … — the
 * pattern is: several reads keyed on the same thing become one query), or establish that the
 * extra trip is genuinely required and change the budget deliberately, in its own commit, with
 * the reason. Lowering a budget after a batching win is always welcome.
 *
 * Budgets are the CURRENT measured count exactly, with no headroom — headroom is what lets a
 * regression land unnoticed.
 */

const owner: TestUser = { id: "u_budget_own", email: "budget@derive.test", name: "Budget Owner" }

const base = makeAuthedApp("trip-budget", [owner])
const { proxy, calls, reset } = countingStore(base.meta as MetaStore)
const { app } = makeAuthedApp("trip-budget-probe", [owner], undefined, { deps: { meta: proxy } })

/** Drive one request through the counting store and return the store calls it made. */
const tripsFor = async (path: string, headers: Record<string, string>) => {
  reset()
  const res = await app.request(path, { headers })
  // A route that 4xx'd would "pass" any budget by doing no work. Assert it actually served.
  expect(res.status, `${path} did not return 200`).toBe(200)
  return [...calls]
}

describe("hot read paths stay within their round-trip budget", () => {
  it("holds every budget", async () => {
    const published = await publishAs(
      base.app,
      "# Budget\n\nBody text for the budgeted routes.\n",
      { tags: "alpha,beta" },
      as(owner.email),
    )
    expect(published.status).toBe(201)
    const { short_id } = (await published.json()) as { short_id: string }

    // Each entry: the route, its budget, and what the batching leaves it needing.
    //
    // These budgets are EXACT — the current count, no headroom — because headroom is what
    // lets a regression land unnoticed. Better Auth's session + `jwks` reads go through its
    // own adapter rather than the MetaStore, so they are real round trips that this counter
    // does not see; the numbers below are the application's own reads.
    //
    // Where a budget looks larger than the batching implies, it is the SQLite fallback being
    // counted: a store without the `artifactGrants` fast path answers authorization with
    // three reads (membership, artifact member, collection roles) where Postgres uses one.
    // Budgeting for the higher of the two keeps one number honest on both backends.
    const ROUTES: { path: string; budget: number; needs: string }[] = [
      {
        // THE cold boot's critical path. With the rest of this PR landed, nothing is
        // queued in front of it any more: the first card paints 43ms after it lands, so
        // its own round trips are the entire remaining cost.
        //
        // 4 here is the SQLite count. Postgres pays 2: `listPage` answers the page AND its
        // whole decoration in one statement, leaving the workspace/membership preamble.
        // Was 5/3 — the viewer's star list used to be fetched up front, before the list
        // query had even run, purely to decorate rows; it rides `listEnrichment` now, so
        // only the FAVORITES FEED (which narrows by it) still pays for it separately.
        //
        // The SQLite number does not move: embedded drivers implement no fast path (a
        // local round trip costs nothing) and take the read-by-read pair.
        path: "/v1/artifacts?limit=30",
        budget: 4,
        needs: "workspace resolve, membership, the list query, one listEnrichment",
      },
      {
        path: `/v1/artifacts/${short_id}`,
        budget: 5,
        needs: "the artifact, its grants (3 on sqlite / 1 on pg), one artifactDetail, bylines",
      },
      {
        path: `/v1/artifacts/${short_id}/comments`,
        budget: 5,
        needs: "the artifact, its grants (3 on sqlite / 1 on pg), one commentsPage",
      },
      {
        path: "/v1/tags",
        budget: 3,
        needs: "workspace resolve, membership, one workspaceSummary",
      },
      { path: "/v1/notifications", budget: 1, needs: "one notificationsPage" },
      {
        // On the boot waterfall at 404ms. Was 3: the caller's workspace list was read
        // TWICE — once by activeWorkspace's no-cookie branch (a first login, or any
        // cookie-less client) and once for the response body. `workspacesOf` memoizes it
        // per request, the same way `membershipOf` already memoized getMembership.
        path: "/v1/workspaces",
        budget: 2,
        needs: "ONE memoized listWorkspaces, membership",
      },
      {
        path: "/v1/collections",
        budget: 4,
        needs: "workspace resolve, membership, one collectionsOverview, one roles batch",
      },
      { path: "/v1/me", budget: 2, needs: "workspace resolve, one memoized membership read" },
      {
        // The batched boot read: four requests' worth of sidebar data through ONE
        // store call. Its whole reason to exist is this number — a second read here
        // means an arm escaped the batch.
        path: "/v1/bootstrap",
        budget: 3,
        needs: "workspace resolve, membership, ONE bootstrap",
      },
      {
        // The document open's first leg, and the one that GATES the rendered bytes: the
        // viewer frame's URL carries a token that only exists on this record, so every
        // trip here is paid before the document can even start loading. Measured at
        // 515ms on production (floor 227ms).
        //
        // 5 here is the SQLite count. Postgres pays 2: `artifactWithGrants` answers the
        // record AND the authorization triple in one statement, then one `artifactDetail`.
        // Was 6/4, then 5/3 (the author byline joined the detail union), now 5/2.
        //
        // That last fold was the one this comment used to list as remaining, and it was
        // worth taking: measured on the preview, this request is 457ms of a 481ms
        // document open — the journey essentially IS this handler — and the artifact read
        // and the grants read were strictly serial, because the second needs the id and
        // org the first returns.
        //
        // The SQLite number does not move: embedded drivers implement neither fast path
        // (a local round trip costs nothing), so they still make all five reads. Budget
        // for the higher of the two, as the header explains.
        path: `/v1/artifacts/${short_id}`,
        budget: 6,
        needs:
          "getByShortId, the authorization triple (one artifactGrants on pg), " +
          "ONE artifactDetail, author bylines",
      },
    ]

    const over: string[] = []
    for (const { path, budget, needs } of ROUTES) {
      const made = await tripsFor(path, as(owner.email))
      // A zero here would mean the counting proxy missed, not that the route is free.
      expect(
        made.length,
        `no store calls counted for ${path} — the proxy is not wired`,
      ).toBeGreaterThan(0)
      if (made.length > budget)
        over.push(
          `${path}: ${made.length} store calls, budget ${budget}.\n` +
            `    needs: ${needs}\n` +
            `    made:  ${made.join(", ")}`,
        )
    }
    expect(
      over.join("\n"),
      "A hot read path grew past its round-trip budget. On the edge tier each extra call is " +
        "~80ms on every request (see the header comment). Fold the new read into the route's " +
        "existing batched store call rather than raising the budget.",
    ).toBe("")
  })

  // The ANONYMOUS unfurl path, budgeted by the same rule but measured without a cookie.
  // It is the highest-traffic surface Derive has — every shared link, every Slack/iMessage
  // preview — and the one where a regression is least likely to be noticed, because nobody
  // signed in ever sees it.
  it("the anonymous unfurl path stays batched", async () => {
    const shared = await publishAs(
      base.app,
      "# Shared\n\nA world-readable doc.\n",
      { link_role: "viewer" },
      as(owner.email),
    )
    expect(shared.status).toBe(201)
    const sharedId = ((await shared.json()) as { short_id: string }).short_id

    const made = await tripsFor(`/v1/oembed?url=http://localhost/artifacts/${sharedId}`, {})
    // unfurlInfo answers the version count, the comment count, the current version row AND
    // its data slots in ONE call. Those were four separate reads (two of them whole-table
    // `.length` scans); if this budget grows, one of them has come back rather than joining
    // the batch — see MetaStore.unfurlInfo.
    expect(
      made.filter((m) => m === "unfurlInfo").length,
      `unfurlInfo should be called exactly once; made: ${made.join(", ")}`,
    ).toBe(1)
    for (const gone of ["listVersions", "listComments", "getVersionData", "getVersion"])
      expect(made, `${gone} is back on the unfurl path; it belongs in unfurlInfo`).not.toContain(
        gone,
      )
    // Exactly two: resolve the artifact, then one batched unfurlInfo. Before the batching
    // (and with main's data slots added as their own read) this was five.
    expect(
      made.length,
      `anonymous unfurl grew past its budget. made: ${made.join(", ")}`,
    ).toBeLessThanOrEqual(2)
  })
})

/**
 * ROUND-TRIP BUDGETS FOR THE MCP SURFACE.
 *
 * The perf register (akvf8ga9) has always listed "MCP tool calls (read / publish / find) |
 * agent-facing path | to measure" — the same 80ms-per-round-trip arithmetic documented
 * throughout this program applies here too, since MCP tool calls run through the exact
 * same Hono app and MetaStore as the REST routes (see mcp.ts — `/mcp` is a route on the
 * same app, not a separate runtime). This closes that "to measure" gap with real counts,
 * using the shared countingStore helper, same as the REST budgets above.
 *
 * `read`, `catch_up`, and `comment` are the tools this performance work touches. This is
 * their regression guard at the MCP boundary specifically, not only at the REST boundary.
 */
describe("MCP tool calls stay within their round-trip budget", () => {
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
    const storedBlobs = new FsBlobStore(join(dir, `${name}-blobs`))
    const blobGets: string[] = []
    const blobs: BlobStore = {
      put: (data) => storedBlobs.put(data),
      get: (key) => {
        blobGets.push(key)
        return storedBlobs.get(key)
      },
      has: (key) => storedBlobs.has(key),
    }
    // Give the embedded fixture the hosted store's optional joined read. Its body composes
    // the portable methods because local round trips are free; the counting wrapper sees
    // the public fast path as one call, which pins the MCP handler's choice.
    const fastMeta: MetaStore = Object.assign(meta, {
      artifactWithVersion: async (shortId: string, n?: number) => {
        const artifact = await meta.getByShortId(shortId)
        if (!artifact) return null
        return {
          artifact,
          version: await meta.getVersion(artifact.id, n ?? artifact.current_version),
        }
      },
      artifactWithVersionData: async (shortId: string, slot: string, n?: number) => {
        const artifact = await meta.getByShortId(shortId)
        if (!artifact) return null
        const selected = n ?? artifact.current_version
        return {
          artifact,
          version: await meta.getVersion(artifact.id, selected),
          data: (await meta.getVersionData(artifact.id, selected, slot))[0] ?? null,
        }
      },
      catchUpRead: async (artifactId: string, beforeN: number, afterN: number) => ({
        versions: await meta.listVersions(artifactId),
        comments: await meta.listComments(artifactId),
        rounds: await meta.listReviewRounds(artifactId),
        beforeData: await meta.getVersionData(artifactId, beforeN),
        afterData: await meta.getVersionData(artifactId, afterN),
      }),
      oauthGrantWithWorkspaces: async (tokenHash: string) => {
        const grant = await meta.getOAuthGrant(tokenHash)
        if (!grant) return null
        const { mine, bound } = await meta.workspacesAndOauthBinding(grant.userId, grant.clientId)
        const scoped = bound.length
          ? mine.filter((workspace) => bound.includes(workspace.id))
          : mine
        const target = scoped[0] ?? mine[0]
        return {
          grant,
          mine,
          bound,
          orgContext: target
            ? { orgId: target.id, ...(await meta.orgContext(target.id, grant.userId)) }
            : undefined,
        }
      },
    })
    const { proxy, calls, reset } = countingStore(fastMeta)
    const app = createApp({ meta: proxy, blobs, baseUrl: "http://derive.test", token: "tok" })
    return { app, blobs, blobGets, meta, token: `tok_${name}`, calls, reset }
  }

  type App = ReturnType<typeof createApp>

  async function rpc(app: App, token: string, body: unknown, workspace?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    }
    if (workspace) headers["x-derive-workspace"] = workspace
    const res = await app.request("/mcp", {
      method: "POST",
      headers,
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

  it("refreshes workspace roles after first-touch provisioning", async () => {
    const { app, token, calls } = appWithGrant(
      "rt-first-touch",
      "openid derive:read derive:publish",
    )
    const listed = await call(app, token, "list_workspaces", {})
    expect(listed?.result?.isError, JSON.stringify(listed)).not.toBe(true)
    expect(listed?.result?.content?.[0]?.text).toContain("ws_p_u_o")
    expect(calls).toContain("listWorkspaces")
  })

  it("re-reads Brandprint inputs after a workspace override", async () => {
    const { app, meta, token, calls, reset } = appWithGrant(
      "rt-override",
      "openid derive:read derive:publish",
    )
    await meta.setWorkspace("default", "Default")
    await meta.setMembership({ id: "m_default", org_id: "default", user_id: "u_o", role: "owner" })
    await meta.setWorkspace("other", "Other")
    await meta.setMembership({ id: "m_other", org_id: "other", user_id: "u_o", role: "editor" })
    const { mine } = await meta.workspacesAndOauthBinding("u_o", "cli")
    const override = mine[0]?.id === "default" ? "other" : "default"

    reset()
    const initialized = await rpc(app, token, initBody, override)
    expect(initialized?.error, JSON.stringify(initialized)).toBeUndefined()
    expect(calls).toContain("oauthGrantWithWorkspaces")
    expect(calls).not.toContain("getMembership")
    expect(calls).toContain("orgContext")
  })

  it("read, catch_up, and comment — measured, not inferred", async () => {
    const { app, blobs, blobGets, meta, token, calls, reset } = appWithGrant(
      "rt",
      "openid derive:read derive:publish",
    )
    await rpc(app, token, initBody)

    // The OAuth user needs a workspace SEAT — direct createArtifact (unlike a real publish)
    // writes no membership row on its own, and workspace_access:"member" gates on exactly
    // that row existing.
    await meta.setWorkspace("default", "Default")
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
    const source = "# Budget read\n\nBody text for the focused read budget.\n"
    const blobKey = await blobs.put(new TextEncoder().encode(source))
    await meta.addVersion(art.id, {
      id: "v1",
      blob_key: blobKey,
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
    const readRes = await call(app, token, "read", { short_id: "rttest01", focus: "focused read" })
    expect(readRes?.result?.isError, JSON.stringify(readRes)).not.toBe(true)
    const readCalls = [...calls]

    reset()
    const mapRes = await call(app, token, "read", { short_id: "rttest01", map: true })
    expect(mapRes?.result?.isError, JSON.stringify(mapRes)).not.toBe(true)
    const mapCalls = [...calls]

    reset()
    const workspacesRes = await call(app, token, "list_workspaces", {}, 5)
    expect(workspacesRes?.result?.isError, JSON.stringify(workspacesRes)).not.toBe(true)
    const workspaceCalls = [...calls]

    reset()
    const reactRes = await call(
      app,
      token,
      "comment",
      { short_id: "rttest01", reply_to: threadA, react: "👍" },
      6,
    )
    expect(reactRes?.result?.isError, JSON.stringify(reactRes)).not.toBe(true)
    const reactCalls = [...calls]

    reset()
    const resolveRes = await call(
      app,
      token,
      "comment",
      { short_id: "rttest01", reply_to: threadB, set_state: "resolved" },
      7,
    )
    expect(resolveRes?.result?.isError, JSON.stringify(resolveRes)).not.toBe(true)
    const resolveCalls = [...calls]

    reset()
    blobGets.length = 0
    const editRes = await call(
      app,
      token,
      "publish",
      {
        short_id: "rttest01",
        base_version: 1,
        edits: [{ old_str: "Body text", new_str: "Updated text" }],
      },
      8,
    )
    expect(editRes?.result?.isError, JSON.stringify(editRes)).not.toBe(true)
    const editCalls = [...calls]

    // The measured counts, printed: this test exists to produce them, and a run's own output
    // is what you read when a budget below moves and you need to see WHICH call was added.
    console.log(
      `MCP round trips — catch_up(short_id): ${catchUpCalls.length} [${catchUpCalls.join(", ")}]\n` +
        `MCP round trips — read(focus): ${readCalls.length} [${readCalls.join(", ")}]\n` +
        `MCP round trips — read(map): ${mapCalls.length} [${mapCalls.join(", ")}]\n` +
        `MCP round trips — list_workspaces: ${workspaceCalls.length} [${workspaceCalls.join(", ")}]\n` +
        `MCP round trips — comment(react): ${reactCalls.length} [${reactCalls.join(", ")}]\n` +
        `MCP round trips — comment(set_state): ${resolveCalls.length} [${resolveCalls.join(", ")}]\n` +
        `MCP round trips — publish(edit): ${editCalls.length} [${editCalls.join(", ")}]`,
    )

    // THE FIRST CALL IS IDENTICAL ON EVERY OPAQUE-OAUTH TOOL CALL:
    // oauthGrantWithWorkspaces — the MCP/OAuth session bootstrap, paid before any
    // tool-specific work starts. This was SEVEN calls (getAgentByToken,
    // getOAuthGrant, listWorkspaces, getOAuthClientWorkspaces, getUsers, getOrgSettings,
    // getUserBrandprint) until this round: getAgentByToken is now skipped outright for any
    // bearer that doesn't start with AGENT_TOKEN_PREFIX (a guaranteed miss for every OAuth/JWT
    // MCP call — see context.ts), getUsers was redundant with the name the grant resolution
    // already had (see OauthAgentResolution.ownerName), and listWorkspaces +
    // getOAuthClientWorkspaces / getOrgSettings + getUserBrandprint each collapsed into one
    // round trip (workspacesAndOauthBinding, orgContext — pg.ts batches, embedded
    // composes). The opaque grant, workspace scope, and default workspace's Brandprint
    // inputs now share one envelope too. The bootstrap falls from seven calls to one.
    // An explicit X-Derive-Workspace override still pays orgContext for its target.
    //
    // Budgets below are the measured count, no headroom — same discipline as
    // the REST budgets above. Raise deliberately, in the commit that explains why, never to
    // silence a red run.
    // The complete history already carries both selected version rows. Catch-up must not
    // restore either redundant getVersion call after listVersions.
    expect(catchUpCalls).not.toContain("getVersion")
    expect(catchUpCalls).toContain("catchUpRead")
    for (const gone of ["listVersions", "listComments", "listReviewRounds", "getVersionData"])
      expect(catchUpCalls, `${gone} escaped the catch-up batch`).not.toContain(gone)
    expect(catchUpCalls.length).toBeLessThanOrEqual(3)
    // One shared MCP bootstrap read, then one joined artifact + selected-version envelope.
    // The grant snapshot also supplies the live workspace role, so authorization adds no
    // metadata read. The handler must not quietly restore either serial lookup.
    expect(readCalls).toContain("artifactWithVersion")
    expect(readCalls).not.toContain("getByShortId")
    expect(readCalls).not.toContain("getVersion")
    expect(readCalls.length).toBeLessThanOrEqual(2)
    expect(mapCalls).toContain("artifactWithVersionData")
    expect(mapCalls).not.toContain("getByShortId")
    expect(mapCalls).not.toContain("getVersion")
    expect(mapCalls).not.toContain("getVersionData")
    expect(mapCalls.length).toBeLessThanOrEqual(2)
    expect(workspaceCalls).toEqual(["oauthGrantWithWorkspaces"])
    expect(reactCalls.length).toBeLessThanOrEqual(4)
    // set_state went 8 → 9 when resolving a thread started keeping its mirrored Slack cards in
    // line (lib/slack-comments.ts enqueueSlackThreadState). The added call is the
    // listSlackThreadLinksByThread that asks whether this thread is mirrored anywhere — one
    // indexed lookup on thread_id, and the only one a workspace with no Slack ever pays, since
    // an empty result returns before any further read. It cannot be folded into a call already
    // being made: nothing else on this path touches slack_thread_link, and skipping it would
    // mean a card that keeps offering "Resolve thread" for a thread an agent already closed.
    // 9 → 10 when a resolve started RECORDING itself (lib/thread-actions.ts
    // recordThreadResolution): who settled the thread, when, and by which version — written
    // onto the root comment's meta, the one row the activity stream reads "Claude Code resolved
    // Ada's thread" from. One read of the root (already loaded by the tool's own thread check)
    // and one meta write; without it the record says only "resolved", by nobody, at no time.
    expect(resolveCalls.length).toBeLessThanOrEqual(7)
    // The edit resolves and authorizes the artifact plus its current version through one
    // joined read. Core publish uses that trusted record and performs only the one final
    // artifact read needed for its fresh return value. Materialization must not restore a
    // separate version lookup.
    expect(editCalls).toContain("artifactWithVersion")
    expect(editCalls).not.toContain("getVersion")
    expect(editCalls.filter((call) => call === "getByShortId")).toHaveLength(1)
    expect(editCalls.filter((call) => call === "getSubscription")).toHaveLength(1)
    expect(editCalls.filter((call) => call === "listMemberships")).toHaveLength(1)
    expect(editCalls).toHaveLength(14)
    // A cold edit reads the previous immutable source once. This fixture already read the
    // active version, so the source cache may make it zero. The new version must never be
    // read back for search, facts, anchors, mentions, or the completion summary.
    expect(blobGets.length).toBeLessThanOrEqual(1)
  })
})
