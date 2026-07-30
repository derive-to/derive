import type { MetaStore } from "@derive/core"
import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

/**
 * ONE ACTOR RESOLUTION PER REQUEST, PER ARTIFACT.
 *
 * `authorize()` narrows the request's principal to an Actor for a specific artifact. On a store
 * without the `artifactGrants` fast path that costs three reads (workspace membership, the
 * per-artifact share, the collection shares — and the last is itself two queries); with it, one.
 * Either way handlers authorize the same artifact repeatedly: opening a chat session checks
 * `read`, then membership, then `publish`. `actorFor` was not memoized, so each check paid again.
 *
 * Counted on the real handler before the fix: thirteen sequential queries for one chat POST,
 * with the same membership row fetched three times. On the hosted edge each is ~100-900ms,
 * because the isolate and Postgres sit in different regions.
 *
 * Asserted at the STORE BOUNDARY, where the cost is, and counted through a `get`-level Proxy
 * rather than by patching methods — the pg test store is itself a Proxy deferring to an
 * async-created store, so assigning over its methods silently counts nothing. That is how the
 * first version of this test passed on SQLite while measuring nothing at all on Postgres.
 */
const owner: TestUser = { id: "u_memo_own", email: "memo@derive.test", name: "Owner" }

const COUNTED = [
  "getMembership",
  "getArtifactMember",
  "collectionRolesForArtifact",
  "artifactGrants",
] as const
type Counted = (typeof COUNTED)[number]

const counting = (inner: MetaStore) => {
  const counts: Record<Counted, number> = {
    getMembership: 0,
    getArtifactMember: 0,
    collectionRolesForArtifact: 0,
    artifactGrants: 0,
  }
  const proxy = new Proxy(inner, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv)
      if (!COUNTED.includes(prop as Counted) || typeof value !== "function") return value
      return (...args: unknown[]) => {
        counts[prop as Counted] += 1
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { proxy, counts }
}

// The first app owns the store; the second drives the request through a counting wrapper around
// that same store, so both see identical data.
//
// The probe app takes its OWN name deliberately. Two apps sharing a name share a Postgres schema,
// and each `makeAuthedApp` races to CREATE it — "duplicate key value violates unique constraint
// pg_namespace_nspname_index". Its own store is then built and never used, because `deps.meta`
// overrides it with the wrapper below; only the schema name has to differ.
const base = makeAuthedApp("authz-memo", [owner])
const { proxy, counts } = counting(base.meta as MetaStore)
const { app } = makeAuthedApp("authz-memo-probe", [owner], undefined, { deps: { meta: proxy } })

describe("actor resolution is memoized per request", () => {
  it("authorizing an artifact repeatedly resolves its Actor once", async () => {
    // chat-session is the handler that motivated this: it authorizes `read`, checks membership,
    // then authorizes `publish` — three questions about the same artifact.
    const settings = await base.meta.getOrgSettings("default")
    await base.meta.setOrgSettings("default", { ...settings, chatBeta: true })

    const published = await publishAs(base.app, "# Memo\n\n## One\n\nBody.\n", {}, as(owner.email))
    const { short_id } = (await published.json()) as { short_id: string }

    for (const k of COUNTED) counts[k] = 0
    const res = await app.request(
      "/v1/artifacts/chat-session",
      jsonAs(as(owner.email), { short_id, body_md: "How many sections?", mode: "publish" }),
    )
    // No model is configured in tests, so the turn answers in the transcript rather than
    // editing — the authorization work under test happens before either way.
    expect(res.status).toBe(201)

    // The store WAS consulted. A zero here means the wrapper missed, not that the cache worked —
    // which is exactly how this test previously lied on Postgres.
    const total = COUNTED.reduce((n, k) => n + counts[k], 0)
    expect(total, "counting proxy saw no permission reads at all").toBeGreaterThan(0)

    if (counts.artifactGrants > 0) {
      // Fast path: one call answers everything, and the reads it replaces stay untouched.
      expect(counts.artifactGrants).toBe(1)
      expect(counts.getMembership).toBe(0)
      expect(counts.getArtifactMember).toBe(0)
      expect(counts.collectionRolesForArtifact).toBe(0)
    } else {
      // Fallback path: each permission row read exactly once for the whole request.
      expect(counts.getMembership).toBe(1)
      expect(counts.getArtifactMember).toBe(1)
      expect(counts.collectionRolesForArtifact).toBe(1)
    }
  })
})
