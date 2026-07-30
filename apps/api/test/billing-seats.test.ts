import { describe, expect, it } from "vitest"
import { DEFAULT_WORKSPACE_NAME } from "../src/lib/http"
import { FakeBilling } from "./fake-billing"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })

const activeSub = (quantity: number) => ({
  org_id: "default",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  tier: "team" as const,
  billing_interval: "month" as const,
  status: "active",
  quantity,
  current_period_end: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
})

describe("seat sync", () => {
  it("adding an editor bumps Stripe quantity; demoting to a non-billable role does not", async () => {
    const fake = new FakeBilling()
    // isolated: true skips the automatic team-seed (which would otherwise make
    // EVERY listed user a member on boot); u4 must exist as a real Derive user
    // (for resolveUserRef to find by email) but must NOT be a member yet, so the
    // PUT below is a genuine new-member add rather than a re-role. Manually seed
    // the "default" workspace + the three real memberships instead, mirroring
    // seedSqliteTeam/makePgStore's own team-seed shape.
    const { app, meta } = makeAuthedApp("ss_add", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: fake },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })
    await meta.upsertSubscription(activeSub(3))

    // PUT /v1/workspace/members adds u4 as editor (4 billable seats now).
    const r = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "editor" }),
      method: "PUT",
    })
    expect(r.status).toBe(201)
    expect(fake.quantityCalls.at(-1)).toEqual({ subscriptionId: "sub_1", quantity: 4 })
    expect((await meta.getSubscription("default"))?.quantity).toBe(4)

    // "viewer" is an artifact-sharing role, not a valid workspace-membership role
    // (isWorkspaceRole only allows owner/editor/commenter) — "commenter" is the
    // workspace-role analog: a non-billable role, same as the brief's intent.
    const demote = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "commenter" }),
      method: "PUT",
    })
    expect(demote.status).toBe(201)
    expect(fake.quantityCalls.at(-1)).toEqual({ subscriptionId: "sub_1", quantity: 3 })
  })

  it("no subscription: membership changes never call Stripe", async () => {
    const fake = new FakeBilling()
    const { app } = makeAuthedApp("ss_nosub", [u(1), u(2)], "editor", {
      deps: { billing: fake },
    })
    const r = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u2@x.test", role: "commenter" }),
      method: "PUT",
    })
    expect(r.status).toBe(201)
    expect(fake.quantityCalls).toHaveLength(0)
  })

  it("GET /v1/billing heals drift", async () => {
    const fake = new FakeBilling()
    const { app, meta } = makeAuthedApp("ss_heal", [u(1), u(2), u(3)], "editor", {
      deps: { billing: fake },
    })
    await meta.upsertSubscription(activeSub(9)) // drifted
    const r = await app.request("/v1/billing", { headers: as("u1@x.test") })
    expect((await r.json()).quantity).toBe(3)
    expect(fake.quantityCalls.at(-1)).toEqual({ subscriptionId: "sub_1", quantity: 3 })
  })

  it("invite direct-add of an existing account syncs seats", async () => {
    const fake = new FakeBilling()
    // Same isolated shape as "adding an editor…" above: u4 must exist as a real
    // Derive user (so resolveUserRef finds it by email) but must NOT be a member
    // yet, so the invite's existing-account branch is a genuine direct-add.
    const { app, meta } = makeAuthedApp("ss_invite_add", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: fake },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })
    await meta.upsertSubscription(activeSub(3))

    // POST /v1/workspace/invites with u4's email — an existing account, so this
    // takes the direct-add branch (not the pending-invite branch).
    const r = await app.request("/v1/workspace/invites", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "editor" }),
      method: "POST",
    })
    expect(r.status).toBe(201)
    expect((await r.json()).kind).toBe("member")
    expect(fake.quantityCalls.at(-1)).toEqual({ subscriptionId: "sub_1", quantity: 4 })
    expect((await meta.getSubscription("default"))?.quantity).toBe(4)
  })

  it("no net billable change makes no Stripe call", async () => {
    const fake = new FakeBilling()
    const { app, meta } = makeAuthedApp("ss_invite_nobill", [u(1), u(2), u(3)], "editor", {
      isolated: true,
      deps: { billing: fake },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.upsertSubscription(activeSub(2))

    const before = fake.quantityCalls.length
    // u3 is added as "commenter" — a non-billable role, so billableSeatCount stays
    // at 2 (== the subscription's live quantity) and syncSeats' no-op guard holds.
    const r = await app.request("/v1/workspace/invites", {
      ...jsonAs(as("u1@x.test"), { email: "u3@x.test", role: "commenter" }),
      method: "POST",
    })
    expect(r.status).toBe(201)
    expect((await r.json()).kind).toBe("member")
    expect(fake.quantityCalls).toHaveLength(before)
  })
})
