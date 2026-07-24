import { describe, expect, it } from "vitest"
import {
  anonApp,
  app,
  as,
  bearer,
  json,
  jsonAs,
  makeAuthedApp,
  pub,
  publishAs,
  quotaApp,
  TEST_TOKEN,
  type TestUser,
  upload,
} from "./helpers"

// Create an artifact (as the token/owner) on a given app instance and set its
// world link role; returns short_id. Like `artifactWithLink` above but parameterized
// on the app, for the dedicated rate-limit-enabled instance below (quotaApp's app
// is NOT auto-authed, so setup calls must carry the token explicitly).
const artifactWithLinkOn = async (
  targetApp: ReturnType<typeof quotaApp>["app"],
  linkRole: "none" | "viewer" | "commenter" | "editor",
) => {
  const shortId = (
    await (await pub(targetApp, "# feedback me", { title: "Anon rate limit" })).json()
  ).short_id as string
  const res = await targetApp.request(`/v1/artifacts/${shortId}/access`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...bearer(TEST_TOKEN) },
    body: JSON.stringify({ linkRole }),
  })
  expect(res.status).toBe(200)
  return shortId
}

// Create an artifact and set its world link role; returns short_id.
const artifactWithLink = async (linkRole: "none" | "viewer" | "commenter" | "editor") => {
  const shortId = (
    await (await upload("doc.md", "# feedback me", { title: "Anon commenting" })).json()
  ).short_id as string
  const res = await app.request(`/v1/artifacts/${shortId}/access`, {
    ...json({ linkRole }),
    method: "PATCH",
  })
  expect(res.status).toBe(200)
  return shortId
}

describe("anonymous commenting", () => {
  it("anon can comment on a commenter link with a name", async () => {
    const shortId = await artifactWithLink("commenter")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "love this section", author: "Glen from Customer.io" }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.author).toBe("Glen from Customer.io")
  })

  it("anon without a name is rejected", async () => {
    const shortId = await artifactWithLink("commenter")
    for (const body of [
      { body_md: "hi" },
      { body_md: "hi", author: "" },
      { body_md: "hi", author: "   " },
    ]) {
      const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`, json(body))
      expect(res.status).toBe(400)
    }
  })

  it("anon with an overlong name is rejected", async () => {
    const shortId = await artifactWithLink("commenter")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "x".repeat(81) }),
    )
    expect(res.status).toBe(400)
  })

  it("anon cannot comment on a viewer link", async () => {
    const shortId = await artifactWithLink("viewer")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "Guest" }),
    )
    expect(res.status).toBe(403)
  })

  it("anon cannot comment on a private artifact", async () => {
    const shortId = await artifactWithLink("none")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "Guest" }),
    )
    expect(res.status).toBe(403)
  })

  it("anon can comment on an editor link but never edit or delete", async () => {
    const shortId = await artifactWithLink("editor")
    const created = await (
      await anonApp.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: "guest note", author: "Guest" }),
      )
    ).json()
    // Edit: PATCH is not on the anon allow-list -> 403 at the door.
    const edit = await anonApp.request(`/v1/artifacts/${shortId}/comments/${created.id}`, {
      ...json({ body_md: "hijacked" }),
      method: "PATCH",
    })
    expect(edit.status).toBe(403)
    const del = await anonApp.request(`/v1/artifacts/${shortId}/comments/${created.id}`, {
      ...json({}),
      method: "DELETE",
    })
    expect(del.status).toBe(403)
    const resolve = await anonApp.request(
      `/v1/artifacts/${shortId}/comments/${created.id}/resolve`,
      json({ state: "resolved" }),
    )
    expect(resolve.status).toBe(403)
  })

  it("anon can read comments on a commenter link", async () => {
    const shortId = await artifactWithLink("commenter")
    await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "first!", author: "Guest" }),
    )
    const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`)
    expect(res.status).toBe(200)
    const list = await res.json()
    expect(list.comments).toHaveLength(1)
    expect(list.comments[0].author).toBe("Guest")
  })

  it("anon still cannot read comments on a viewer link", async () => {
    const shortId = await artifactWithLink("viewer")
    const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`)
    expect(res.status).toBe(404)
  })

  it("signed-in callers ignore a body author (session name wins)", async () => {
    // A real signed-in session is cheap here via makeAuthedApp/as/jsonAs (same
    // pattern as comment-access.test.ts), so exercise the actual route code
    // rather than asserting it in review.
    const alice: TestUser = { id: "u_ac_alice", email: "alice@anon-comments.test", name: "Alice" }
    const { app: app2 } = makeAuthedApp("anon-comments-signedin", [alice])
    const shortId = (await (await publishAs(app2, "<h1>doc</h1>", {}, as(alice.email))).json())
      .short_id as string
    const res = await app2.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(alice.email), { body_md: "hi", author: "Spoof" }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.author).toBe("Alice")
    expect(cm.author).not.toBe("Spoof")
  })

  it("anon comment creation is capped at 5/min per IP", async () => {
    // A fresh app + store (own in-memory limiter instance) so this test's budget
    // can never be consumed by another test in the file — quotaApp isolates both.
    const { app: rlApp } = quotaApp("rl-anon-comment", { rateLimit: true })
    const shortId = await artifactWithLinkOn(rlApp, "commenter")
    let last = 0
    for (let i = 0; i < 6; i++) {
      // No Authorization header: rlApp (from quotaApp) is not auto-authed, so this
      // is a genuinely anonymous caller, same as anonApp above.
      const res = await rlApp.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: `spam ${i}`, author: "Flood" }),
      )
      last = res.status
    }
    expect(last).toBe(429)
  })

  it("guest comments carry guest:true on the wire; signed rows do not", async () => {
    const shortId = await artifactWithLink("commenter")
    const guest = await (
      await anonApp.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: "guest here", author: "Guest" }),
      )
    ).json()
    expect(guest.guest).toBe(true)
    const owner = await (
      await app.request(`/v1/artifacts/${shortId}/comments`, json({ body_md: "owner here" }))
    ).json()
    expect(owner.guest).toBeUndefined()
  })
})

// The mention[] array on a guest comment is caller-supplied and unauthenticated. Email
// has no downstream re-filter (bells + Slack DMs do), so the route must gate the email
// fan-out to the artifact's collaborators. Otherwise a guest could email any registered
// user an attacker-chosen author + body. We drive the real route and inspect the outbox.
describe("guest comment mention-email is collaborator-gated", () => {
  const claim = (m: ReturnType<typeof quotaApp>["meta"]) =>
    m.claimDueDeliveries(
      new Date(Date.now() + 60_000).toISOString(),
      100,
      new Date(Date.now() + 120_000).toISOString(),
    )

  it("mentioning a NON-collaborator enqueues no email", async () => {
    const collab: TestUser = { id: "u_gm_collab", email: "collab@gm.test", name: "Collab" }
    // Registered (getUsers resolves them, they have an email) but NOT a workspace member
    // and NOT an artifact share — a non-collaborator, the exact relay target.
    const outsider: TestUser = { id: "u_gm_out", email: "outsider@gm.test", name: "Outsider" }
    const { app: gmApp, meta } = quotaApp(
      "gm-noncollab",
      {},
      [collab, outsider],
      [{ user_id: collab.id, role: "editor" }],
    )
    const shortId = await artifactWithLinkOn(gmApp, "commenter")
    const res = await gmApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({
        body_md: "look here",
        author: "Guest",
        mentions: [{ id: outsider.id, name: "Outsider" }],
      }),
    )
    expect(res.status).toBe(201)
    const emails = (await claim(meta)).filter((d) => d.kind === "email")
    expect(emails).toHaveLength(0)
  })

  it("mentioning a collaborator enqueues an email to them", async () => {
    const collab: TestUser = { id: "u_gm_collab2", email: "collab2@gm.test", name: "Collab" }
    const { app: gmApp, meta } = quotaApp(
      "gm-collab",
      {},
      [collab],
      [{ user_id: collab.id, role: "editor" }],
    )
    const shortId = await artifactWithLinkOn(gmApp, "commenter")
    const res = await gmApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({
        body_md: "look here",
        author: "Guest",
        mentions: [{ id: collab.id, name: "Collab" }],
      }),
    )
    expect(res.status).toBe(201)
    const emails = (await claim(meta)).filter((d) => d.kind === "email")
    expect(emails).toHaveLength(1)
    expect(emails[0]?.payload).toContain(collab.email)
  })
})

// A guest row has a null author_id, and its author byline is a self-attested, unverified
// name. So authorship must NOT fall back to a display-name match for guest rows: a member
// who renames their profile to a guest's name must never edit or delete that guest's comment.
describe("guest comment cannot be hijacked by a name-colliding member", () => {
  it("a member whose name equals the guest's gets 403 on PATCH and DELETE", async () => {
    const owner: TestUser = { id: "u_hj_owner", email: "owner@hj.test", name: "Owner" }
    // The attacker: a signed-in member who renamed their profile to the guest's byline.
    const evil: TestUser = { id: "u_hj_evil", email: "evil@hj.test", name: "Collision" }
    const { app: hjApp } = makeAuthedApp("guest-hijack", [owner, evil], "editor")
    const shortId = (await (await publishAs(hjApp, "<h1>doc</h1>", {}, as(owner.email))).json())
      .short_id as string
    const acc = await hjApp.request(`/v1/artifacts/${shortId}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ linkRole: "commenter" }),
    })
    expect(acc.status).toBe(200)
    // A guest posts, self-naming "Collision" (the same display name the evil member wears).
    const guest = await (
      await hjApp.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: "guest note", author: "Collision" }),
      )
    ).json()
    expect(guest.guest).toBe(true)
    const edit = await hjApp.request(`/v1/artifacts/${shortId}/comments/${guest.id}`, {
      ...jsonAs(as(evil.email), { body_md: "hijacked" }),
      method: "PATCH",
    })
    expect(edit.status).toBe(403)
    const del = await hjApp.request(`/v1/artifacts/${shortId}/comments/${guest.id}`, {
      ...jsonAs(as(evil.email), {}),
      method: "DELETE",
    })
    expect(del.status).toBe(403)
  })
})
