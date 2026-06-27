import { type ElementSelector, elementLabel, fingerprintOf, roleOf, scanElements } from "@dock/core"
import { describe, expect, it } from "vitest"
import { app, as, json, jsonAs, makeAuthedApp, publishAs, type TestUser, upload } from "./helpers"

// Build an element selector for the first element matching `tag` in `html`, the
// way the browser client would (same fields, from a scan).
const elSelFor = (html: string, tag: string, ordinal = 0): ElementSelector => {
  const ds = scanElements(html)
  const d = ds.find((x) => x.tag === tag && x.ordinal === ordinal)
  if (!d) throw new Error(`no ${tag}#${ordinal}`)
  const role = roleOf(d)
  return {
    type: "ElementSelector",
    tag: d.tag,
    role,
    id: d.id,
    fingerprint: fingerprintOf(d),
    ordinal: d.ordinal,
    docFraction: d.srcFraction,
    before: ds[d.index - 1]?.text,
    after: ds[d.index + 1]?.text,
    snapshot: { tag: d.tag, label: elementLabel({ ...d, role }) },
  }
}

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

describe("the outdated state machine (re-anchor sweep on republish)", () => {
  const anchor = { type: "TextQuoteSelector", exact: "beta", prefix: "alpha ", suffix: " gamma" }
  const republish = (sid: string, body: string, message: string) => {
    const fd = new FormData()
    fd.append("file", new Blob([new TextEncoder().encode(body)]), "a.md")
    fd.append("message", message)
    return app.request(`/v1/artifacts/${sid}/versions`, { method: "POST", body: fd })
  }
  const byState = async (sid: string, state: string) =>
    (await (await app.request(`/v1/artifacts/${sid}/comments?state=${state}`)).json()).comments

  it("flips open→outdated when the quote vanishes, and back to open when it returns", async () => {
    const sid = (await (await upload("a.md", "alpha beta gamma", { title: "A" })).json()).short_id
    await app.request(`/v1/artifacts/${sid}/comments`, json({ body_md: "on beta", anchor }))
    expect(await byState(sid, "open")).toHaveLength(1)

    // v2 drops "beta" → the thread is now outdated (persisted, not just a flag).
    await republish(sid, "alpha gamma delta", "v2 drops beta")
    expect(await byState(sid, "open")).toHaveLength(0)
    const outdated = await byState(sid, "outdated")
    expect(outdated).toHaveLength(1)
    expect(outdated[0].state).toBe("outdated")

    // v3 brings "beta" back → the thread reopens automatically.
    await republish(sid, "alpha beta gamma again", "v3 restores beta")
    expect(await byState(sid, "outdated")).toHaveLength(0)
    expect(await byState(sid, "open")).toHaveLength(1)
  })

  it("never resurrects a resolved thread, even if its quote later vanishes", async () => {
    const sid = (await (await upload("a.md", "alpha beta gamma", { title: "A" })).json()).short_id
    const cm = await (
      await app.request(`/v1/artifacts/${sid}/comments`, json({ body_md: "on beta", anchor }))
    ).json()
    await app.request(`/v1/artifacts/${sid}/comments/${cm.id}/resolve`, { method: "POST" })

    await republish(sid, "alpha gamma delta", "v2 drops beta")
    expect(await byState(sid, "resolved")).toHaveLength(1)
    expect(await byState(sid, "outdated")).toHaveLength(0)
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
    // The directory identifies people by handle + name, never email (you can still
    // FIND someone by their address via ?q=, but it is never returned).
    expect(filtered.users[0]).toMatchObject({ id: bob.id, name: "Bob" })
    expect(filtered.users[0].email).toBeUndefined()
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
    const due = await m.claimDueDeliveries(
      new Date(Date.now() + 1000).toISOString(),
      50,
      new Date(Date.now() + 60_000).toISOString(),
    )
    // The outbox now also carries first-party channel rows (e.g. kind="email") for the
    // same event, so select the configured-webhook delivery specifically.
    const mention = due.find(
      (d) => d.event_type === "comment.mention" && (d.kind === "generic" || d.kind === "slack"),
    )
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

describe("element anchors (non-text) through publish + sweep", () => {
  const page = (img: string) =>
    `<!doctype html><html><body><p>Intro</p>${img}<p>Outro</p></body></html>`
  const byState = async (sid: string, state: string) =>
    (await (await app.request(`/v1/artifacts/${sid}/comments?state=${state}`)).json()).comments

  it("flags an element anchor resolved, and orphaned when the element is removed", async () => {
    const v1 = page(`<img id="hero" src="/a.png" alt="Hero chart">`)
    const sid = (await (await upload("e.html", v1, { title: "E" })).json()).short_id
    const anchor = elSelFor(v1, "img")
    await app.request(`/v1/artifacts/${sid}/comments`, json({ body_md: "fix this image", anchor }))

    let list = await (await app.request(`/v1/artifacts/${sid}/comments`)).json()
    expect(list.comments[0].anchored).toBe(true)
    // The webhook/quote referent is the snapshot label, not a text quote.
    expect(JSON.parse(list.comments[0].anchor).snapshot.label).toBe("Image — Hero chart")

    // Remove the image entirely → no forward-walk can recover it → orphaned/outdated.
    await upload("e.html", page(""), {}, sid)
    expect(await byState(sid, "open")).toHaveLength(0)
    expect(await byState(sid, "outdated")).toHaveLength(1)
    list = await (await app.request(`/v1/artifacts/${sid}/comments`)).json()
    expect(list.comments[0].anchored).toBe(false)
    // The preserved snapshot still describes what it pointed at.
    expect(JSON.parse(list.comments[0].anchor).snapshot.label).toBe("Image — Hero chart")
  })

  it("survives an id rename via the content fingerprint (one-jump)", async () => {
    const v1 = page(`<img id="A" src="/x.png" alt="hero">`)
    const sid = (await (await upload("e.html", v1, { title: "E" })).json()).short_id
    await app.request(
      `/v1/artifacts/${sid}/comments`,
      json({ body_md: "on the image", anchor: elSelFor(v1, "img") }),
    )
    // id changes but src+alt (the fingerprint) hold → resolves directly, stays open.
    await upload("e.html", page(`<img id="B" src="/x.png" alt="hero">`), {}, sid)
    expect(await byState(sid, "outdated")).toHaveLength(0)
    expect(await byState(sid, "open")).toHaveLength(1)
  })

  it("forward-walks recovery across versions where no single signal survives end-to-end", async () => {
    // The comment is made on v1. Across v2..v4 the id and the content (src+alt) each
    // change, but never both in the same step — so every hop keeps ONE strong signal
    // while v1→v4 shares neither. One-jump resolution fails; the forward-walk recovers
    // it and self-heals the stored selector.
    const v1 = page(`<img id="A" src="/1.png" alt="hero one">`)
    const sid = (await (await upload("e.html", v1, { title: "E" })).json()).short_id
    await app.request(
      `/v1/artifacts/${sid}/comments`,
      json({ body_md: "on the hero", anchor: elSelFor(v1, "img") }),
    )
    // v2: id A kept, content changes. v3: content kept, id → B. v4: id B kept, content changes.
    await upload("e.html", page(`<img id="A" src="/2.png" alt="hero two">`), {}, sid)
    await upload("e.html", page(`<img id="B" src="/2.png" alt="hero two">`), {}, sid)
    await upload("e.html", page(`<img id="B" src="/3.png" alt="hero three">`), {}, sid)

    // Recovered, not orphaned.
    expect(await byState(sid, "outdated")).toHaveLength(0)
    expect(await byState(sid, "open")).toHaveLength(1)

    // Self-healed: the stored selector now matches the current element (id B, /3.png)
    // and still resolves against the current version.
    const list = await (await app.request(`/v1/artifacts/${sid}/comments`)).json()
    const healed = JSON.parse(list.comments[0].anchor)
    expect(healed.id).toBe("B")
    expect(list.comments[0].anchored).toBe(true)
    // The original snapshot rode through the recovery.
    expect(healed.snapshot.label).toBe("Image — hero one")
  })

  it("rejects an oversized anchor (storage/bandwidth abuse) but accepts a normal one", async () => {
    const sid = (
      await (
        await upload("e.html", page(`<img id="x" src="/a.png" alt="A">`), { title: "E" })
      ).json()
    ).short_id
    // A normal element anchor is fine.
    const ok = await app.request(
      `/v1/artifacts/${sid}/comments`,
      json({ body_md: "ok", anchor: elSelFor(page(`<img id="x" src="/a.png" alt="A">`), "img") }),
    )
    expect(ok.status).toBe(201)
    // A multi-MB anchor (e.g. a giant snapshot.html) is refused, not stored.
    const huge = await app.request(
      `/v1/artifacts/${sid}/comments`,
      json({
        body_md: "abuse",
        anchor: {
          type: "ElementSelector",
          tag: "img",
          fingerprint: "x",
          snapshot: { html: "A".repeat(2_000_000) },
        },
      }),
    )
    expect(huge.status).toBe(400)
  })
})
