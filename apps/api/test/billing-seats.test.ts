import { SqliteMetaStore } from "@derive/db/sqlite"
import { describe, expect, it } from "vitest"
import { purgeUserDataAndSyncSeats } from "../src/lib/account"
import { DEFAULT_WORKSPACE_NAME } from "../src/lib/http"
import { FakeBilling, subscriptionRow } from "./fake-billing"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })
const PAST = "2000-01-01T00:00:00Z"

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
    await meta.upsertSubscription(subscriptionRow({ quantity: 3 }))

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
    // workspace-role analog: a non-billable role.
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
    await meta.upsertSubscription(subscriptionRow({ quantity: 9 })) // drifted
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
    await meta.upsertSubscription(subscriptionRow({ quantity: 3 }))

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
    await meta.upsertSubscription(subscriptionRow({ quantity: 2 }))

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

// Account deletion drops the user's membership row in every workspace they belonged
// to in one shot (MetaStore.deleteUserData) — including any workspace where they held
// a billable seat. purgeUserDataAndSyncSeats (apps/api/src/lib/account.ts) is the hook
// wired into Better Auth's real delete-account flow at the API layer (node.ts / worker.ts)
// to heal that: capture the billable orgs before the purge, recount after.
//
// NOTE on coverage: the full end-to-end path (an authenticated HTTP request that drives
// Better Auth's own account-deletion endpoint) is NOT drivable from this test harness —
// makeAuthedApp never wires a real `auth` (makeAuth) instance, only a bare session
// lookup, and purgeUserData/blockUserDeletion are Better-Auth hooks that only fire
// through that real instance (see auth-config.ts: "Unset (tests) ⇒ no cascade").
// account-deletion.test.ts already established this precedent for the neighboring
// blockUserDeletion guard, testing workspacesBlockingDeletion directly against a real
// MetaStore rather than through HTTP; these tests do the same for the new seat-sync
// hook, calling it directly with a real SqliteMetaStore + FakeBilling.
describe("purgeUserDataAndSyncSeats (account deletion → seat sync)", () => {
  const sub = (orgId: string, subscriptionId: string, quantity: number) =>
    subscriptionRow({
      org_id: orgId,
      stripe_customer_id: `cus_${orgId}`,
      stripe_subscription_id: subscriptionId,
      quantity,
    })

  it("recounts Stripe seats on every workspace the deleted user was editor/owner in", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const fake = new FakeBilling()
    const me = "u_deleted"
    const other = "u_other"
    await meta.setWorkspace("ws_a", "A")
    await meta.setMembership({ id: "m_a1", org_id: "ws_a", user_id: me, role: "editor" })
    await meta.setMembership({ id: "m_a2", org_id: "ws_a", user_id: other, role: "owner" })
    await meta.upsertSubscription(sub("ws_a", "sub_a", 2))

    await purgeUserDataAndSyncSeats(meta, fake, me)

    // The membership is gone (the purge ran)...
    expect(await meta.getMembership("ws_a", me)).toBeNull()
    // ...and Stripe was told the seat count dropped from 2 to 1.
    expect(fake.quantityCalls).toEqual([{ subscriptionId: "sub_a", quantity: 1 }])
    expect((await meta.getSubscription("ws_a"))?.quantity).toBe(1)
  })

  it("does not sync a workspace where the deleted user held a non-billable role", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const fake = new FakeBilling()
    const me = "u_deleted"
    const owner = "u_owner"
    await meta.setWorkspace("ws_b", "B")
    await meta.setMembership({ id: "m_b1", org_id: "ws_b", user_id: owner, role: "owner" })
    await meta.setMembership({ id: "m_b2", org_id: "ws_b", user_id: me, role: "commenter" })
    await meta.upsertSubscription(sub("ws_b", "sub_b", 1))

    await purgeUserDataAndSyncSeats(meta, fake, me)

    expect(await meta.getMembership("ws_b", me)).toBeNull()
    expect(fake.quantityCalls).toHaveLength(0)
  })

  it("skips a workspace with no subscription (nothing to sync) without failing the purge", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const fake = new FakeBilling()
    const me = "u_deleted"
    await meta.setWorkspace("ws_c", "C")
    await meta.setMembership({ id: "m_c1", org_id: "ws_c", user_id: me, role: "owner" })

    await expect(purgeUserDataAndSyncSeats(meta, fake, me)).resolves.toBeUndefined()
    expect(await meta.getMembership("ws_c", me)).toBeNull()
    expect(fake.quantityCalls).toHaveLength(0)
  })

  it("no billing driver configured: the purge still runs, seat sync is a no-op", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const me = "u_deleted"
    await meta.setWorkspace("ws_d", "D")
    await meta.setMembership({ id: "m_d1", org_id: "ws_d", user_id: me, role: "editor" })
    await meta.upsertSubscription(sub("ws_d", "sub_d", 1))

    await expect(purgeUserDataAndSyncSeats(meta, undefined, me)).resolves.toBeUndefined()
    expect(await meta.getMembership("ws_d", me)).toBeNull()
  })
})

// The invite-time seat gate: granting a billable role (editor/owner) must not push a
// free, unsubscribed workspace past FREE_SEAT_LIMIT once enforcement has started. Every
// case seeds its own "default" workspace with 3 already-billable members (u1 owner, u2/u3
// editor) via `isolated: true` (skips the harness's own team-seed) so the 4th grant is
// unambiguous. Driven through the ROUTES (PUT/PATCH members, POST invites), not the
// seatGrantGate helper directly — the wiring is what's under test.
describe("seat gate on granting a billable role", () => {
  it("beta: the 4th editor invite succeeds", async () => {
    const { app, meta } = makeAuthedApp("sg_beta_ok", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling() }, // no billingEnforceAt: beta grace
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })

    const r = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "editor" }),
      method: "PUT",
    })
    expect(r.status).toBe(201)
  })

  it("enforced: the 4th billable grant 402s with billing_required", async () => {
    const { app, meta } = makeAuthedApp("sg_enf_402", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })

    const r = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "editor" }),
      method: "PUT",
    })
    expect(r.status).toBe(402)
    const body = await r.json()
    expect(body.code).toBe("billing_required")
    expect(body.error).toContain("/settings/billing")
  })

  it("enforced: a commenter invite always succeeds", async () => {
    const { app, meta } = makeAuthedApp("sg_enf_commenter", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })

    const r = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "commenter" }),
      method: "PUT",
    })
    expect(r.status).toBe(201)
  })

  it("enforced: a subscribed workspace adds a 4th editor freely", async () => {
    const { app, meta } = makeAuthedApp("sg_enf_subscribed", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })
    await meta.upsertSubscription(subscriptionRow({ status: "active", quantity: 3 }))

    const r = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "editor" }),
      method: "PUT",
    })
    expect(r.status).toBe(201)
  })

  it("enforced: promoting a commenter to editor at the limit 402s", async () => {
    const { app, meta } = makeAuthedApp("sg_enf_promote", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })
    await meta.setMembership({ id: "m_u4", org_id: "default", user_id: "u4", role: "commenter" })

    const r = await app.request("/v1/workspace/members/u4", {
      ...jsonAs(as("u1@x.test"), { role: "editor" }),
      method: "PATCH",
    })
    expect(r.status).toBe(402)
    const body = await r.json()
    expect(body.code).toBe("billing_required")
  })

  it("enforced: re-roling an existing editor to owner passes", async () => {
    const { app, meta } = makeAuthedApp("sg_enf_rerole", [u(1), u(2), u(3)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })

    const r = await app.request("/v1/workspace/members/u3", {
      ...jsonAs(as("u1@x.test"), { role: "owner" }),
      method: "PATCH",
    })
    expect(r.status).toBe(200)
  })

  it("enforced: a 4th-editor invite for an existing account 402s through POST /v1/workspace/invites", async () => {
    const { app, meta } = makeAuthedApp("sg_invites_existing", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })

    const r = await app.request("/v1/workspace/invites", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "editor" }),
      method: "POST",
    })
    expect(r.status).toBe(402)
    const body = await r.json()
    expect(body.code).toBe("billing_required")
    expect(body.error).toContain("/settings/billing")
  })

  it("enforced: a 4th-editor invite to an unknown email 402s before creating a pending invite", async () => {
    const { app, meta } = makeAuthedApp("sg_invites_unknown", [u(1), u(2), u(3)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })

    const r = await app.request("/v1/workspace/invites", {
      ...jsonAs(as("u1@x.test"), { email: "stranger@x.test", role: "editor" }),
      method: "POST",
    })
    expect(r.status).toBe(402)
    const body = await r.json()
    expect(body.code).toBe("billing_required")
    expect(body.error).toContain("/settings/billing")
  })

  // DECIDED: seatGrantGate only counts seats against FREE_SEAT_LIMIT — it never reads
  // blockedReason "lapsed" itself. So a canceled subscription behaves exactly like no
  // subscription here: a workspace still under its 3 free seats can keep filling them.
  // Publishing stays blocked for a lapsed workspace, but that's billingGate's job (see
  // resolveBillingState's "lapsed" branch in packages/core/src/billing.ts), a separate
  // gate from this one.
  it("enforced: a lapsed workspace under the limit can still fill its free seats", async () => {
    const { app, meta } = makeAuthedApp("sg_enf_lapsed_ok", [u(1), u(2), u(3)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.upsertSubscription(subscriptionRow({ status: "canceled" }))

    const r = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u3@x.test", role: "editor" }),
      method: "PUT",
    })
    expect(r.status).toBe(201)
  })

  it("enforced: a lapsed workspace at the limit is still seat-gated", async () => {
    const { app, meta } = makeAuthedApp("sg_enf_lapsed_402", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })
    await meta.upsertSubscription(subscriptionRow({ status: "canceled" }))

    const r = await app.request("/v1/workspace/members", {
      ...jsonAs(as("u1@x.test"), { email: "u4@x.test", role: "editor" }),
      method: "PUT",
    })
    expect(r.status).toBe(402)
    const body = await r.json()
    expect(body.code).toBe("billing_required")
  })
})
