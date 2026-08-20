import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import {
  app,
  as,
  makeAuthedApp,
  meta,
  proposeAs,
  publishAs,
  type TestUser,
  upload,
} from "./helpers"

// The approved-version gate: a proposal or review approval stamps
// artifact.approved_version, and skill/agent delivery serves that version
// (approvedOrCurrent) while humans keep seeing current. `?v=approved` on the
// content API is the shared resolution point.

const owner: TestUser = { id: "u_gate_owner", email: "owner@gate.test", name: "Gwen" }
const ed: TestUser = { id: "u_gate_ed", email: "ed@gate.test", name: "Ed" }

describe("approved_version writes", () => {
  it("a proposal approval stamps the decided version", async () => {
    const { app: a, meta: m } = makeAuthedApp("skills-gate-prop", [owner, ed], "editor")
    const shortId = (
      await (await publishAs(a, "<h1>one</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    const pr = await (await proposeAs(a, shortId, "<h1>two</h1>", as(ed.email))).json()
    const ap = await a.request(`/v1/artifacts/${shortId}/proposals/${pr.id}/approve`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(ap.status).toBe(200)
    const art = await m.getByShortId(shortId)
    expect(art?.approved_version).toBe(2)
    expect(art?.current_version).toBe(2)

    // A later direct publish moves current past approved; the pointer stays put.
    await publishAs(a, "<h1>three</h1>", {}, as(owner.email), shortId)
    const after = await m.getByShortId(shortId)
    expect(after?.current_version).toBe(3)
    expect(after?.approved_version).toBe(2)
  })

  it("a review-round approval stamps the round's version and never lowers it", async () => {
    const short = (await (await upload("g.md", "# one", { title: "Gate doc" })).json()).short_id
    await upload("g.md", "# two", {}, short)
    const art = await meta.getByShortId(short)
    if (!art) throw new Error("no artifact")

    const r2 = newId("rr")
    await meta.createReviewRound({
      id: r2,
      artifact_id: art.id,
      version: 2,
      requested_by: "agent",
      requested_for: "u_gate_owner",
    })
    await meta.resolveReviewRound(r2, { state: "approved" })
    expect((await meta.getByShortId(short))?.approved_version).toBe(2)

    // Approving a stale round (requested at v1) must not roll delivery back.
    const r1 = newId("rr")
    await meta.createReviewRound({
      id: r1,
      artifact_id: art.id,
      version: 1,
      requested_by: "agent",
      requested_for: "u_gate_ed",
    })
    await meta.resolveReviewRound(r1, { state: "approved" })
    expect((await meta.getByShortId(short))?.approved_version).toBe(2)
  })
})

describe("?v=approved on the content API", () => {
  it("resolves the approved version, and current when none exists", async () => {
    const short = (await (await upload("s.md", "# one", { title: "Sentinel doc" })).json()).short_id
    // Never approved: the sentinel serves current.
    await upload("s.md", "# two", {}, short)
    expect(await (await app.request(`/v1/artifacts/${short}/content?v=approved`)).text()).toBe(
      "# two",
    )

    const art = await meta.getByShortId(short)
    if (!art) throw new Error("no artifact")
    const round = newId("rr")
    await meta.createReviewRound({
      id: round,
      artifact_id: art.id,
      version: 1,
      requested_by: "agent",
      requested_for: "u_gate_owner",
    })
    await meta.resolveReviewRound(round, { state: "approved" })

    // Approved v1 gates the sentinel to v1; the plain read still serves current.
    expect(await (await app.request(`/v1/artifacts/${short}/content?v=approved`)).text()).toBe(
      "# one",
    )
    expect(await (await app.request(`/v1/artifacts/${short}/content`)).text()).toBe("# two")
  })
})
