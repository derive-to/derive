import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

/**
 * ONE ACTOR RESOLUTION PER REQUEST, PER ARTIFACT.
 *
 * `authorize()` narrows the request's principal to an Actor for a specific artifact, and that
 * costs three round trips: the workspace membership, the per-artifact share, and the collection
 * shares. Handlers routinely authorize the same artifact more than once — opening a chat session
 * checks `read` and then `publish` — and `actorFor` was not memoized, so each check paid for all
 * three again.
 *
 * Counted on the real handler before the fix: eleven sequential queries for one chat POST, with
 * the same membership row fetched THREE times (twice inside authorize, once explicitly) and the
 * artifact-member and collection-role rows twice each. On the hosted edge each of those is
 * ~100-900ms, because the isolate and Postgres are in different regions.
 *
 * This pins the dedup at the store boundary — where the cost actually is — rather than asserting
 * on a cache's internals.
 */
const owner: TestUser = { id: "u_memo_own", email: "memo@derive.test", name: "Owner" }
const { app, meta } = makeAuthedApp("authz-memo", [owner])

/** Count calls to the three reads an Actor resolution makes, in place: `createApp` captured this
 *  exact object, so patching its methods is what the handler will call. */
const countCalls = () => {
  const counts = { membership: 0, artifactMember: 0, collectionRoles: 0 }
  const m = meta as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const [key, name] of [
    ["getMembership", "membership"],
    ["getArtifactMember", "artifactMember"],
    ["collectionRolesForArtifact", "collectionRoles"],
  ] as const) {
    const original = m[key]?.bind(meta)
    if (!original) throw new Error(`store has no ${key}`)
    m[key] = (...args: unknown[]) => {
      counts[name] += 1
      return original(...args)
    }
  }
  return counts
}

describe("actor resolution is memoized per request", () => {
  it("authorizing the same artifact twice reads each permission row once", async () => {
    // chat-session is the handler that motivated this: it authorizes `read`, then `publish`.
    const settings = await meta.getOrgSettings("default")
    await meta.setOrgSettings("default", { ...settings, chatBeta: true })

    const published = await publishAs(app, "# Memo\n\n## One\n\nBody.\n", {}, as(owner.email))
    const { short_id } = (await published.json()) as { short_id: string }

    const counts = countCalls()
    const res = await app.request(
      "/v1/artifacts/chat-session",
      jsonAs(as(owner.email), { short_id, body_md: "How many sections?", mode: "publish" }),
    )
    // No model is configured in tests, so the turn answers in the transcript rather than
    // editing — the authorization work under test happens before either way.
    expect(res.status).toBe(201)

    // Each permission row: fetched once, however many times the handler authorizes.
    expect(counts.artifactMember).toBe(1)
    expect(counts.collectionRoles).toBe(1)
    // Membership is also read directly by the route (a membership check that is not an
    // authorize), so one resolution plus that explicit read.
    expect(counts.membership).toBeLessThanOrEqual(2)
  })
})
