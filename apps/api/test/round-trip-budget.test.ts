import { randomUUID } from "node:crypto"
import type { MetaStore } from "@derive/core"
import { describe, expect, it } from "vitest"
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
        path: "/v1/artifacts?limit=30",
        budget: 5,
        needs: "favorites, workspace resolve, membership, the list query, one listEnrichment",
      },
      {
        path: `/v1/artifacts/${short_id}`,
        budget: 6,
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
        path: "/v1/collections",
        budget: 4,
        needs: "workspace resolve, membership, one collectionsOverview, one roles batch",
      },
      { path: "/v1/me", budget: 2, needs: "workspace resolve, one memoized membership read" },
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

  it("the batched store calls really are one call each, not a loop in disguise", async () => {
    // A future refactor could keep the budget green while turning a batched method back into a
    // per-item loop internally — same call count at this boundary, N round trips underneath.
    // These assert the batch methods accept the whole page at once, which is what makes them
    // one round trip on Postgres.
    // Ids from randomUUID, not Date.now(): two artifacts created in the same millisecond
    // collide on artifact.short_id's UNIQUE constraint, which is exactly what happened the
    // first time this ran under `test:coverage`.
    const mk = (slug: string) =>
      base.meta.createArtifact({
        id: `art_${randomUUID()}`,
        short_id: randomUUID().replace(/-/g, "").slice(0, 8),
        org_id: "default",
        slug,
        title: slug,
        workspace_access: "member",
        link_role: "viewer",
        listed: "public",
        kind: "file",
        spa: 0,
      })
    const a = await mk("batched-a")
    const b = await mk("batched-b")

    reset()
    const enriched = await proxy.listEnrichment({
      ids: [a.id, b.id],
      ghIds: [],
      authorIds: [],
      viewerId: null,
      memberId: null,
      views: true,
    })
    expect(enriched).toBeTruthy()
    // ONE call for the whole page, regardless of how many ids it carries.
    expect(calls.filter((c) => c === "listEnrichment")).toHaveLength(1)

    reset()
    await proxy.currentVersions([a.id, b.id])
    expect(calls.filter((c) => c === "currentVersions")).toHaveLength(1)
    // …and specifically NOT a getVersion per artifact, which is what it replaced.
    expect(calls.filter((c) => c === "getVersion")).toHaveLength(0)
  })
})
