import { describe, expect, it } from "vitest"
import { app, as, json, jsonAs, makeAuthedApp, publishAs, type TestUser, upload } from "./helpers"

describe("comments + the loop", () => {
  let shortId: string
  let threadId: string
  let rootId: string

  it("creates a comment as a new thread", async () => {
    shortId = (await (await upload("c.md", "# doc with mean sentiment", { title: "C" })).json())
      .short_id
    const res = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      json({
        body_md: "use median",
        author: "jess",
        anchor: { type: "TextQuoteSelector", exact: "mean" },
      }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.state).toBe("open")
    expect(cm.thread_id).toBe(cm.id)
    expect(cm.base_version).toBe(1)
    expect(cm.anchor).toContain("TextQuoteSelector")
    threadId = cm.thread_id
    rootId = cm.id
  })

  it("replies in the same thread", async () => {
    const cm = await (
      await app.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: "agreed", thread_id: threadId }),
      )
    ).json()
    expect(cm.thread_id).toBe(threadId)
    const list = await (await app.request(`/v1/artifacts/${shortId}/comments`)).json()
    expect(list.comments).toHaveLength(2)
  })

  it("resolves and reopens a thread, with state filtering", async () => {
    await app.request(`/v1/artifacts/${shortId}/comments/${rootId}/resolve`, { method: "POST" })
    expect(
      (await (await app.request(`/v1/artifacts/${shortId}/comments?state=open`)).json()).comments,
    ).toHaveLength(0)
    expect(
      (await (await app.request(`/v1/artifacts/${shortId}/comments?state=resolved`)).json())
        .comments,
    ).toHaveLength(2)

    await app.request(
      `/v1/artifacts/${shortId}/comments/${rootId}/resolve`,
      json({ state: "open" }),
    )
    expect(
      (await (await app.request(`/v1/artifacts/${shortId}/comments?state=open`)).json()).comments,
    ).toHaveLength(2)
  })

  it("resolves threads on republish via the resolves field", async () => {
    const sid = (await (await upload("r.md", "# r", {})).json()).short_id
    const cm = await (
      await app.request(`/v1/artifacts/${sid}/comments`, json({ body_md: "fix this" }))
    ).json()

    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# r2")]), "r.md")
    form.append("message", "address review")
    form.append("resolves", cm.id)
    await app.request(`/v1/artifacts/${sid}/versions`, { method: "POST", body: form })

    expect(
      (await (await app.request(`/v1/artifacts/${sid}/comments?state=open`)).json()).comments,
    ).toHaveLength(0)
  })

  it("validates body and 404s unknown artifacts", async () => {
    expect((await app.request(`/v1/artifacts/${shortId}/comments`, json({}))).status).toBe(400)
    expect((await app.request("/v1/artifacts/zzzzzzzz/comments")).status).toBe(404)
  })
})

describe("anchored comments", () => {
  it("flags comments anchored vs orphaned against the current version", async () => {
    const sid = (await (await upload("a.md", "alpha beta gamma", { title: "A" })).json()).short_id
    // anchor a comment to "beta"
    const anchor = { type: "TextQuoteSelector", exact: "beta", prefix: "alpha ", suffix: " gamma" }
    await app.request(`/v1/artifacts/${sid}/comments`, json({ body_md: "on beta", anchor }))

    let list = await (await app.request(`/v1/artifacts/${sid}/comments`)).json()
    expect(list.comments[0].anchored).toBe(true)

    // republish without "beta" → comment becomes orphaned
    const fd = new FormData()
    fd.append("file", new Blob([new TextEncoder().encode("alpha gamma delta")]), "a.md")
    fd.append("message", "v2")
    await app.request(`/v1/artifacts/${sid}/versions`, { method: "POST", body: fd })

    list = await (await app.request(`/v1/artifacts/${sid}/comments`)).json()
    expect(list.comments[0].anchored).toBe(false)
  })
})

describe("@mentions + in-app notifications", () => {
  const alice: TestUser = { id: "u_m_alice", email: "ma@dock.test", name: "Alice" }
  const bob: TestUser = { id: "u_m_bob", email: "mb@dock.test", name: "Bob" }
  const { app, meta: m } = makeAuthedApp("mentions", [alice, bob], "editor")
  let shortId: string

  it("lists provisioned workspace members in the mention directory, filtered by ?q=", async () => {
    shortId = (await (await publishAs(app, "<h1>doc</h1>", {}, as(alice.email))).json()).short_id
    await app.request("/v1/me", { headers: as(bob.email) }) // provisions bob as a member
    const all = await (await app.request("/v1/users", { headers: as(alice.email) })).json()
    const ids = all.users.map((u: { id: string }) => u.id)
    expect(ids).toContain(alice.id)
    expect(ids).toContain(bob.id)

    const filtered = await (
      await app.request("/v1/users?q=bob", { headers: as(alice.email) })
    ).json()
    expect(filtered.users).toHaveLength(1)
    expect(filtered.users[0]).toMatchObject({ id: bob.id, name: "Bob", email: bob.email })
  })

  it("stores mentions on the comment and notifies the mentioned user, never the author", async () => {
    const res = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(alice.email), {
        body_md: "hey please take a look",
        mentions: [
          { id: bob.id, name: "Bob" },
          { id: alice.id, name: "Alice" }, // self-mention must NOT notify Alice
        ],
      }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.mentions).toEqual([
      { id: bob.id, name: "Bob" },
      { id: alice.id, name: "Alice" },
    ])

    const bobN = await (await app.request("/v1/notifications", { headers: as(bob.email) })).json()
    expect(bobN.unread).toBe(1)
    expect(bobN.notifications[0]).toMatchObject({
      kind: "mention",
      actor: "Alice",
      artifact_short_id: shortId,
      thread_id: cm.thread_id,
      comment_id: cm.id,
      read: 0,
    })
    expect(bobN.notifications[0].preview).toContain("take a look")

    const aliceN = await (
      await app.request("/v1/notifications", { headers: as(alice.email) })
    ).json()
    expect(aliceN.unread).toBe(0)
  })

  it("drops mentions of unknown user ids (no junk notifications)", async () => {
    await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(alice.email), {
        body_md: "ghost ping",
        mentions: [{ id: "u_does_not_exist", name: "Ghost" }],
      }),
    )
    // Bob still has only his single earlier notification; no row for the ghost id.
    const ghost = await m.listNotifications("u_does_not_exist", 10)
    expect(ghost).toHaveLength(0)
  })

  it("marks notifications read", async () => {
    const before = await (await app.request("/v1/notifications", { headers: as(bob.email) })).json()
    expect(before.unread).toBe(1)
    const read = await app.request("/v1/notifications/read", jsonAs(as(bob.email), { all: true }))
    expect((await read.json()).unread).toBe(0)
    const after = await (await app.request("/v1/notifications", { headers: as(bob.email) })).json()
    expect(after.unread).toBe(0)
    expect(after.notifications[0].read).toBe(1)
  })

  it("requires auth for the directory and the notification feed", async () => {
    expect((await app.request("/v1/users")).status).toBe(401)
    expect((await app.request("/v1/notifications")).status).toBe(401)
    expect((await app.request("/v1/notifications/events")).status).toBe(401)
  })

  it("enqueues a comment.mention webhook carrying the notified names", async () => {
    await app.request("/v1/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", ...as(alice.email) },
      body: JSON.stringify({
        url: "https://hooks.example.com/mention",
        events: ["comment.mention"],
      }),
    })
    await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(alice.email), { body_md: "ping again", mentions: [{ id: bob.id, name: "Bob" }] }),
    )
    const due = await m.claimDueDeliveries(new Date(Date.now() + 1000).toISOString(), 50)
    const mention = due.find((d) => d.event_type === "comment.mention")
    expect(mention).toBeTruthy()
    const payload = JSON.parse(mention?.payload ?? "{}")
    expect(payload.data.mentioned).toContain("Bob")
    expect(payload.data.author).toBe("Alice")
  })

  it("pushes a live notification event to the mentioned user's stream", async () => {
    const res = await app.request("/v1/notifications/events", { headers: as(bob.email) })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body?.getReader()
    if (!reader) throw new Error("no stream body")
    const dec = new TextDecoder()
    const readUntil = async (needle: string, timeoutMs = 2500) => {
      let buf = ""
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const r = await Promise.race([
          reader.read(),
          new Promise<{ value?: Uint8Array; done: boolean }>((res) =>
            setTimeout(() => res({ value: undefined, done: false }), 100),
          ),
        ])
        if (r.value) buf += dec.decode(r.value, { stream: true })
        if (buf.includes(needle)) return buf
        if (r.done) break
      }
      throw new Error(`SSE timeout waiting for "${needle}"; got:\n${buf}`)
    }
    try {
      await readUntil("event: ready")
      await app.request(
        `/v1/artifacts/${shortId}/comments`,
        jsonAs(as(alice.email), { body_md: "live ping", mentions: [{ id: bob.id, name: "Bob" }] }),
      )
      const got = await readUntil("event: notification")
      expect(got).toContain('"kind":"mention"')
      expect(got).toContain("live ping")
    } finally {
      await reader.cancel()
    }
  })
})
