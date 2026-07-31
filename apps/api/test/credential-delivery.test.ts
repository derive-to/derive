import { describe, expect, it } from "vitest"
import { API_TOKEN_TTL_MS, signApiToken } from "../src/lib/api-token"
import { dispatchPass, type Substrate } from "../src/lib/dispatch"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// CREDENTIAL DELIVERY — "keys to the run".
//
// The decision (derive.to 1h3r7vsf): where a machine exists, a context's bound credentials are
// handed to the run and the agent writes ordinary code with real libraries. Derive is the vault
// (one place to store, rotate once, revoke on offboarding, deliver only what is bound); it is not
// a chaperone standing between the model and its SDKs.
//
// Delivery is its OWN endpoint per lane, not a field on the claim. Two reasons: the runs claim is
// batched (up to 10), so putting secrets on it would decrypt keys for runs that may never
// execute; and the executor only needs them at spawn time. This mirrors how the model-plan
// credential already works (`GET /v1/agent/model-credential?run=`), so the shape is the
// codebase's own, not a new one.
//
// SCOPE THIS PR: owner-operated executors only — a STANDING agent bearer, i.e. a runner the
// owner runs themselves. A dispatched capability token (dkrun_/dksess_, minted for a substrate
// WE chose) gets nothing until per-key hosted-delivery consent exists.
const SECRET = "test-secret-at-least-16-chars"

describe("credential delivery (keys to the run)", () => {
  const owner: TestUser = { id: "u_cd_own", email: "cdown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_cd_mem", email: "cdmem@derive.test", name: "Member" }
  const { app, meta } = makeAuthedApp("credential-delivery", [owner, member], "editor", {
    deps: { encryptionKey: SECRET },
  })

  const makeConnection = async (body: Record<string, unknown>, who = owner.email) =>
    (await (await app.request("/v1/connections", jsonAs(as(who), body))).json()) as { id: string }

  const makeContext = async (name: string, connectionIds?: string[]) => {
    const manifest = await publishAs(app, "# How to answer", { title: name }, as(owner.email))
    const { short_id } = (await manifest.json()) as { short_id: string }
    return (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name,
          manifest_short_id: short_id,
          ...(connectionIds ? { connection_ids: connectionIds } : {}),
        }),
      )
    ).json()) as { id: string; agent_token: string }
  }

  const askIn = async (contextId: string) => {
    const ask = await app.request(
      `/v1/contexts/${contextId}/sessions`,
      jsonAs(as(owner.email), { body_md: "How much did we refund last month?" }),
    )
    return ((await ask.json()) as { session: { id: string } }).session.id
  }

  /** The capability token dispatch mints for a hosted substrate.
   *
   *  `perOrgLimit` is raised because the default (3) is a WORKSPACE IN-FLIGHT ceiling, not a
   *  per-pass batch size: the asks the earlier tests leave open are counted as in flight and
   *  never settle here, so at the default this session is refused dispatch forever and the test
   *  fails for a reason that has nothing to do with credentials. Several passes for the same
   *  reason — the session we want can be behind others in the queue. */
  const capabilityTokenFor = async (sessionId: string) => {
    const started: { runId: string; token: string }[] = []
    const substrate: Substrate = {
      name: "fake",
      async start(input) {
        started.push(input)
      },
    }
    for (let pass = 0; pass < 6; pass++) {
      await dispatchPass({
        meta,
        substrate,
        server: "https://derive.test",
        secret: SECRET,
        perOrgLimit: 50,
      })
      const hit = started.find((s) => s.runId === sessionId)
      if (hit) return hit.token
    }
    return ""
  }

  const stripeKey = "rk_live_fixture_restricted_9f3a"

  it("delivers a bound secret to a STANDING runner, named for the vendor's own env var", async () => {
    const conn = await makeConnection({
      toolkit: "stripe",
      kind: "secret",
      secret: stripeKey,
      scope: "workspace",
      scopes_label: "read-only, charges and refunds",
    })
    const ctx = await makeContext("Revenue questions", [conn.id])
    const session = await askIn(ctx.id)

    const res = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(ctx.agent_token),
    })
    expect(res.status).toBe(200)
    const { credentials } = (await res.json()) as {
      credentials: { toolkit: string; env: string[]; value: string; label: string | null }[]
    }
    expect(credentials).toHaveLength(1)
    const cred = credentials[0]
    // The value is the real key — that is the whole point of this endpoint.
    expect(cred?.value).toBe(stripeKey)
    // Named the way the vendor's own SDK reads it, so `stripe` works with no instruction,
    // PLUS a canonical name that exists for every connection whether we recognize it or not.
    expect(cred?.env).toContain("STRIPE_API_KEY")
    expect(cred?.env).toContain("DERIVE_CONN_STRIPE")
    // The label is what the prompt shows a human-readable agent: what this key can do.
    expect(cred?.label).toBe("read-only, charges and refunds")
  })

  it("a minted dkapi_ REST bearer gets NOTHING — the keyring is not a REST read", async () => {
    // #559 made every REST route agent-reachable from an agent's shell. A delivery path readable
    // by that token would hand any agent the whole workspace's credentials. The token resolves
    // through agentFor to a synthetic `oauth:<client>` principal with no run/session scope — i.e.
    // it looks exactly like a standing runner to a naive check — so this is refused explicitly
    // rather than relying on its agent id failing to match a context's.
    const conn = await makeConnection({
      toolkit: "stripe",
      kind: "secret",
      secret: stripeKey,
      scope: "workspace",
    })
    const ctx = await makeContext("Minted", [conn.id])
    const session = await askIn(ctx.id)

    const minted = await signApiToken(
      SECRET,
      owner.id,
      "default",
      "owner",
      "cli",
      Date.now() + API_TOKEN_TTL_MS,
    )
    const res = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(minted),
    })
    expect([401, 403]).toContain(res.status)
    expect(await res.text()).not.toContain(stripeKey)
    // ...and the SAME session over the standing bearer does deliver, so this test fails if the
    // route simply does not exist. A refusal that is really a 404 proves nothing.
    const control = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(ctx.agent_token),
    })
    expect(control.status).toBe(200)
    expect(await control.text()).toContain(stripeKey)
  })

  it("a logged-in human gets nothing either — no read-back, at any role", async () => {
    // The connections routes are write-only by construction (no endpoint returns a stored
    // secret, including to an admin). Delivery must not become the read-back hole in that.
    const conn = await makeConnection({
      toolkit: "stripe",
      kind: "secret",
      secret: stripeKey,
      scope: "workspace",
    })
    const ctx = await makeContext("Human", [conn.id])
    const session = await askIn(ctx.id)
    const res = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: as(owner.email),
    })
    expect([401, 403]).toContain(res.status)
    expect(await res.text()).not.toContain(stripeKey)
    // Control, as above: the route is live for the runner, so this is a refusal and not a 404.
    const control = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(ctx.agent_token),
    })
    expect(control.status).toBe(200)
  })

  it("a DISPATCHED capability token gets an empty list — hosted delivery needs consent first", async () => {
    // A dkrun_/dksess_ token was minted for a substrate Derive chose, which may be a machine we
    // operate. Putting a customer's key in our container is a different consent decision from
    // putting it on their own box, so it waits for a per-key opt-in. Empty + a reason rather
    // than 403: the executor is not misbehaving, there is simply nothing for it.
    const conn = await makeConnection({
      toolkit: "stripe",
      kind: "secret",
      secret: stripeKey,
      scope: "workspace",
    })
    const ctx = await makeContext("Hosted", [conn.id])
    const session = await askIn(ctx.id)
    const token = await capabilityTokenFor(session)
    expect(token).toBeTruthy()

    const res = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(token),
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(stripeKey)
    const parsed = JSON.parse(body) as { credentials: unknown[]; reason?: string }
    expect(parsed.credentials).toEqual([])
    expect(parsed.reason).toMatch(/hosted/i)
  })

  it("another context's runner cannot read this session's credentials", async () => {
    const conn = await makeConnection({
      toolkit: "stripe",
      kind: "secret",
      secret: stripeKey,
      scope: "workspace",
    })
    const mine = await makeContext("Mine", [conn.id])
    const theirs = await makeContext("Theirs")
    const session = await askIn(mine.id)
    const res = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(theirs.agent_token),
    })
    expect([403, 404]).toContain(res.status)
    expect(await res.text()).not.toContain(stripeKey)
    // Control: this session's OWN runner is served, so the refusal above is about ownership
    // rather than a missing route.
    const control = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(mine.agent_token),
    })
    expect(control.status).toBe(200)
  })

  it("the CLAIM still carries no credential — delivery is a separate, deliberate read", async () => {
    const conn = await makeConnection({
      toolkit: "stripe",
      kind: "secret",
      secret: stripeKey,
      scope: "workspace",
    })
    const ctx = await makeContext("ClaimClean", [conn.id])
    const session = await askIn(ctx.id)
    // Both doors the executor can arrive through.
    const queue = await app.request(`/v1/contexts/${ctx.id}/queue`, {
      headers: bearer(ctx.agent_token),
    })
    expect(await queue.text()).not.toContain(stripeKey)
    const claim = await app.request(
      "/v1/agent/sessions/claim",
      jsonAs(bearer(await capabilityTokenFor(session)), {}),
    )
    expect(await claim.text()).not.toContain(stripeKey)
  })

  it("a departed member's personal key is not delivered", async () => {
    // Offboarding revokes reach that instant — the same live-membership recheck the tool lane
    // gets, reused rather than reimplemented (spendableConnections).
    const theirs = await makeConnection(
      { toolkit: "gmail", kind: "secret", secret: "personal-key-fixture-x", scope: "personal" },
      member.email,
    )
    // The owner cannot bind someone else's personal connection, so the member owns the context.
    const manifest = await publishAs(app, "# m", { title: "Personal" }, as(member.email))
    const { short_id } = (await manifest.json()) as { short_id: string }
    const ctx = (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(member.email), {
          name: "Their inbox",
          manifest_short_id: short_id,
          connection_ids: [theirs.id],
        }),
      )
    ).json()) as { id: string; agent_token: string }
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(member.email), { body_md: "anything?" }),
    )
    const session = ((await ask.json()) as { session: { id: string } }).session.id

    const before = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(ctx.agent_token),
    })
    expect(((await before.json()) as { credentials: unknown[] }).credentials).toHaveLength(1)

    await meta.removeMembership("default", member.id)
    const after = await app.request(`/v1/agent/sessions/${session}/credentials`, {
      headers: bearer(ctx.agent_token),
    })
    expect(((await after.json()) as { credentials: unknown[] }).credentials).toEqual([])
  })

  it("the run lane delivers too, and withholds from a dispatched run token", async () => {
    const conn = await makeConnection({
      toolkit: "game",
      kind: "secret",
      secret: "sk_game_run_lane_fixture",
      scope: "workspace",
    })
    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          trigger: { kind: "manual" },
          instruction: "Refresh the standings.",
          connectionIds: [conn.id],
        }),
      )
    ).json()) as { id: string; agent_token: string }
    await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    const claimed = (await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(auto.agent_token) })
    ).json()) as { runs: { id: string }[] }
    const runId = claimed.runs[0]?.id ?? ""
    expect(runId).toBeTruthy()

    const mine = await app.request(`/v1/agent/runs/${runId}/credentials`, {
      headers: bearer(auto.agent_token),
    })
    expect(mine.status).toBe(200)
    const got = (await mine.json()) as { credentials: { value: string; env: string[] }[] }
    expect(got.credentials[0]?.value).toBe("sk_game_run_lane_fixture")
    expect(got.credentials[0]?.env).toContain("DERIVE_CONN_GAME")
  })
})
