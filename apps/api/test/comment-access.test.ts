import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  anonApp,
  app,
  as,
  bearer,
  json,
  jsonAs,
  makeAuthedApp,
  meta,
  publishAs,
  TEST_TOKEN,
  type TestUser,
  upload,
} from "./helpers"

// The general-access comment grant, enforced end to end at the route layer (the
// companion to packages/core's effectiveRole matrix). The invariant under test: an
// anonymous caller can never comment, no matter the grant — auth is the gate — while a
// signed-in caller reaching purely via the link rises to commenter when the link allows
// it. Mirrors the access matrix in SECURITY.md.
describe("comment access via the general-access link", () => {
  const alice: TestUser = { id: "u_ca_alice", email: "alice@ca.test", name: "Alice" }
  // Bob is signed in but reaches Alice's artifact purely via the link (his own isolated
  // workspace → no membership, no share): the "signed in via link" column.
  const bob: TestUser = { id: "u_ca_bob", email: "bob@ca.test", name: "Bob" }
  const { app } = makeAuthedApp("comment-access", [alice, bob], undefined, {
    isolated: true,
  })

  const setAccess = (shortId: string, linkRole: "viewer" | "commenter") =>
    app.request(`/v1/artifacts/${shortId}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(alice.email) },
      body: JSON.stringify({ linkRole }),
    })
  const comment = (shortId: string, headers: Record<string, string>) =>
    app.request(`/v1/artifacts/${shortId}/comments`, jsonAs(headers, { body_md: "hi" }))
  const view = (shortId: string, headers?: Record<string, string>) =>
    app.request(`/v1/artifacts/${shortId}`, headers ? { headers } : undefined)

  it("view link: anyone reaching may read, nobody reaching may comment", async () => {
    await app.request("/v1/me", { headers: as(alice.email) }) // provision Alice's workspace
    const shortId = (await (await publishAs(app, "<h1>doc</h1>", {}, as(alice.email))).json())
      .short_id
    expect((await setAccess(shortId, "viewer")).ok).toBe(true)

    // Reads succeed for a signed-in reacher and for an anonymous visitor.
    expect((await view(shortId, as(bob.email))).status).toBe(200)
    expect((await view(shortId)).status).toBe(200)
    // Comments are refused for both — a view link grants only viewer.
    expect((await comment(shortId, as(bob.email))).status).toBe(403)
    expect(
      (await app.request(`/v1/artifacts/${shortId}/comments`, json({ body_md: "hi" }))).status,
    ).toBe(403)
  })

  it("comment link: a signed-in reacher comments; an anonymous one is forced to auth", async () => {
    await app.request("/v1/me", { headers: as(alice.email) })
    const shortId = (await (await publishAs(app, "<h1>doc2</h1>", {}, as(alice.email))).json())
      .short_id
    expect((await setAccess(shortId, "commenter")).ok).toBe(true)

    // Signed in via the link → commenter → may comment.
    expect((await comment(shortId, as(bob.email))).ok).toBe(true)
    // Anonymous → still viewer → 403 even on a comment link (the invariant).
    expect(
      (await app.request(`/v1/artifacts/${shortId}/comments`, json({ body_md: "no" }))).status,
    ).toBe(403)

    // my_role reflects the grant per caller; the GET returns the persisted link role.
    const bobView = await (await view(shortId, as(bob.email))).json()
    expect(bobView.my_role).toBe("commenter")
    expect(bobView.link_role).toBe("commenter")
    expect(bobView.is_workspace_member).toBe(false)
    const anonView = await (await view(shortId)).json()
    expect(anonView.my_role).toBe("viewer")
    expect(anonView.is_workspace_member).toBe(false)
  })

  it("revoking the comment grant locks commenting again", async () => {
    await app.request("/v1/me", { headers: as(alice.email) })
    const shortId = (await (await publishAs(app, "<h1>doc3</h1>", {}, as(alice.email))).json())
      .short_id
    expect((await setAccess(shortId, "commenter")).ok).toBe(true)
    expect((await comment(shortId, as(bob.email))).ok).toBe(true)
    // Flip back to view-only: the same reacher can no longer comment.
    expect((await setAccess(shortId, "viewer")).ok).toBe(true)
    expect((await comment(shortId, as(bob.email))).status).toBe(403)
  })

  it("lets commenters interact with shared state and stamps their identity server-side", async () => {
    await app.request("/v1/me", { headers: as(alice.email) })
    const shortId = (await (await publishAs(app, "<h1>bugs</h1>", {}, as(alice.email))).json())
      .short_id
    expect((await setAccess(shortId, "commenter")).ok).toBe(true)
    const mutate = (body: unknown, headers: Record<string, string>) =>
      app.request(`/v1/artifacts/${shortId}/state/bugs`, jsonAs(headers, body))

    const added = await mutate(
      {
        op: "add",
        initial: [],
        value: { title: "Voting is stale", votes: 0 },
        actor: { id: alice.id, name: "Alice" },
      },
      as(bob.email),
    )
    expect(added.status).toBe(200)
    const addBody = (await added.json()) as {
      value: { id: string; title: string; votes: number }[]
      version: number
    }
    expect(addBody).toMatchObject({ version: 1, value: [{ title: "Voting is stale", votes: 0 }] })
    const itemId = addBody.value[0]?.id
    if (!itemId) throw new Error("shared-state add did not mint an item id")

    const voted = await mutate(
      {
        op: "update",
        initial: [],
        id: itemId,
        patch: { votes: { __derive_increment: 1 } },
      },
      as(bob.email),
    )
    expect(voted.status).toBe(200)
    expect(await voted.json()).toMatchObject({ version: 2, value: [{ id: itemId, votes: 1 }] })

    // Two people can hit the same vote control at once without one increment
    // overwriting the other. The route's CAS retry makes each interaction land.
    const simultaneous = await Promise.all([
      mutate(
        {
          op: "update",
          initial: [],
          id: itemId,
          patch: { votes: { __derive_increment: 1 } },
        },
        as(alice.email),
      ),
      mutate(
        {
          op: "update",
          initial: [],
          id: itemId,
          patch: { votes: { __derive_increment: 1 } },
        },
        as(bob.email),
      ),
    ])
    expect(simultaneous.every((response) => response.status === 200)).toBe(true)

    // State is artifact-readable, but the attributed ledger stays collaborator-only.
    const publicRead = await app.request(`/v1/artifacts/${shortId}/state/bugs`)
    expect(publicRead.status).toBe(200)
    expect(await publicRead.json()).toMatchObject({ version: 4, value: [{ votes: 3 }] })
    const activity = await app.request(`/v1/artifacts/${shortId}/state/bugs/activity`, {
      headers: as(bob.email),
    })
    expect((await activity.json()).activity).toMatchObject([
      { action: "update", item_id: itemId },
      { action: "update", item_id: itemId },
      { action: "update", item_id: itemId, actor: { id: bob.id, name: "Bob" } },
      { action: "add", item_id: itemId, actor: { id: bob.id, name: "Bob" } },
    ])

    expect((await mutate({ op: "add", initial: [], value: {} }, {})).status).toBe(403)
    expect((await app.request(`/v1/artifacts/${shortId}/state/bugs/activity`)).status).toBe(403)
    expect((await setAccess(shortId, "viewer")).ok).toBe(true)
    expect(
      (await mutate({ op: "add", initial: [], value: { title: "no" } }, as(bob.email))).status,
    ).toBe(403)
  })

  it("explains when a production-backed preview is waiting for the new tables", async () => {
    const seeded = makeAuthedApp("comment-access-schema", [alice], undefined, { isolated: true })
    await seeded.app.request("/v1/me", { headers: as(alice.email) })
    const shortId = (
      await (await publishAs(seeded.app, "<h1>preview</h1>", {}, as(alice.email))).json()
    ).short_id
    // Postgres test stores are deferred proxies, so replace the dependency before
    // createApp closes over it instead of trying to patch one of its methods later.
    const missingSchema = new Proxy(seeded.meta, {
      get(target, prop, receiver) {
        if (prop === "getSharedState")
          return async () => {
            throw Object.assign(new Error('relation "shared_state" does not exist'), {
              code: "42P01",
            })
          }
        return Reflect.get(target, prop, receiver)
      },
    })
    const { app: preview } = makeAuthedApp("comment-access-schema-route", [alice], undefined, {
      isolated: true,
      deps: { meta: missingSchema },
    })

    const response = await preview.request(`/v1/artifacts/${shortId}/state/bugs`, {
      headers: as(alice.email),
    })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: "shared_state_schema_unavailable",
    })
  })
})

// Workspace seat access (the team-draft default): a member reaches the doc at
// their SEAT role — the review loop works on a pasted link — while outsiders and
// anonymous stay out entirely.
describe("comment access via workspace seat", () => {
  const dana: TestUser = {
    id: "u_ca_dana",
    email: "dana@ca.test",
    name: "Dana",
    username: "danac",
  }
  const memo: TestUser = {
    id: "u_ca_memo",
    email: "memo@ca.test",
    name: "Memo",
    username: "memoc",
  }
  // Otto signs in to the SAME app but never joins Dana's workspace (isolated:
  // everyone provisions their own; Dana then invites only Memo) — the
  // signed-in-outsider column of the state table.
  const otto: TestUser = { id: "u_ca_otto", email: "otto@ca.test", name: "Otto" }
  const { app } = makeAuthedApp("comment-access-org", [dana, memo, otto], undefined, {
    isolated: true,
  })

  it("a member comments on a team-draft doc via their seat; an outsider gets 404", async () => {
    await app.request("/v1/me", { headers: as(dana.email) }) // provision Dana's workspace
    await app.request("/v1/me", { headers: as(otto.email) }) // Otto provisions his own
    // Dana seats Memo in her workspace; Otto stays outside.
    expect(
      (
        await app.request("/v1/workspace/members", {
          ...jsonAs(as(dana.email), { user: "memoc", role: "commenter" }),
          method: "PUT",
        })
      ).ok,
    ).toBe(true)

    // The factory default (the team draft) — no fields sent.
    const a = await (await publishAs(app, "<h1>draft</h1>", {}, as(dana.email))).json()
    expect(a.workspace_access).toBe("member")
    expect(a.link_role).toBe("none")
    expect(a.listed).toBe("none")

    // Memo (workspace member, no share) reaches it at his seat (commenter) and comments.
    expect(
      (
        await app.request(
          `/v1/artifacts/${a.short_id}/comments`,
          jsonAs(as(memo.email), { body_md: "left a note via the pasted link" }),
        )
      ).ok,
    ).toBe(true)
    const memoView = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(memo.email) })
    ).json()
    expect(memoView.is_workspace_member).toBe(true)

    // Otto is signed in but outside the workspace: the same URL is inert (404,
    // indistinguishable from not existing). Anonymous likewise.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(otto.email) })).status,
    ).toBe(404)
    expect((await app.request(`/v1/artifacts/${a.short_id}`)).status).toBe(404)
  })
})

// The comment-nudge pill (GTM step 09): the public viewer needs an open-thread
// count to render "N comments · sign in to join", but anon never sees comment
// BODIES (collaboration, not content). So the detail response carries a single
// derived count, and only where the prompt can fire: an anonymous caller on a
// link that grants commenting.
describe("open_comment_count on the artifact detail", () => {
  const idOf = async (res: Response): Promise<string> => (await res.json()).short_id

  const grantCommentLink = async (short: string) => {
    const res = await app.request(`/v1/artifacts/${short}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bearer(TEST_TOKEN) },
      body: JSON.stringify({ linkRole: "commenter" }),
    })
    if (res.status !== 200) throw new Error(`access patch failed: ${res.status}`)
  }

  const seedComment = async (short: string, threadId: string, state?: "resolved") => {
    const art = await meta.getByShortId(short)
    if (!art) throw new Error("artifact missing")
    await meta.createComment({
      id: randomUUID(),
      artifact_id: art.id,
      thread_id: threadId,
      base_version: 1,
      body_md: "hi",
      author: "amy",
    })
    if (state === "resolved") await meta.setThreadState(art.id, threadId, "resolved")
  }

  it("anon on a can-comment link gets open_comment_count (resolved threads excluded)", async () => {
    const short = await idOf(await upload("cn.md", "# Hi", { visibility: "public", title: "CN" }))
    await grantCommentLink(short)
    await seedComment(short, "t-open-1")
    await seedComment(short, "t-open-1") // same thread — still one open thread
    await seedComment(short, "t-open-2")
    await seedComment(short, "t-done", "resolved")

    const detail = await (await anonApp.request(`/v1/artifacts/${short}`)).json()
    expect(detail.open_comment_count).toBe(2)
  })

  it("absent on a view-only link — no activity leak where the prompt can't fire", async () => {
    const short = await idOf(await upload("cnv.md", "# Hi", { visibility: "public", title: "CNV" }))
    await seedComment(short, "t-open")

    const detail = await (await anonApp.request(`/v1/artifacts/${short}`)).json()
    expect(detail.link_role).toBe("viewer")
    expect(detail.open_comment_count).toBeUndefined()
  })

  it("absent for authenticated callers — they load real threads instead", async () => {
    const short = await idOf(await upload("cna.md", "# Hi", { visibility: "public", title: "CNA" }))
    await grantCommentLink(short)

    const detail = await (
      await app.request(`/v1/artifacts/${short}`, { headers: bearer(TEST_TOKEN) })
    ).json()
    expect(detail.open_comment_count).toBeUndefined()
  })
})
