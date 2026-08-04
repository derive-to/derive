import { DEFAULT_ORG_SETTINGS, newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { createInProcessBackplane } from "../src/bus"
import { setInstanceChatModel } from "../src/lib/instance-settings"
import { catalogOf } from "../src/lib/model-catalog"
import { inMemoryRateLimiters } from "../src/lib/rate-limit"
import { as, makeAuthedApp } from "./helpers"

// CHAT, END TO END through the real routes: open a session on a document, send a message, and
// the document changes. This is the attended path — no queue, no runner, no dispatch tick — so
// the test drives it exactly as the browser will.
//
// Only the MODEL is faked. Everything else (auth, the ask grant, the subject authorization, the
// gate, the version write) is the real code path.

const revision = (content: string) =>
  `<revision>${JSON.stringify({ content, filename: "doc.md", confidence: 0.95, message: "shortened" })}</revision>`

/** A scripted model plus the fixture that makes chat reachable: a workspace, a context to hang
 *  the session on, and a document to talk about. */
const setup = async (name: string, reply: string) => {
  const users = [{ id: "u-ed", email: "ed@x.com", name: "Ed" }]
  const { app, meta } = makeAuthedApp(name, users, undefined, {
    deps: {
      callModel: async () => ({ text: reply, toolUses: [], costUsd: null, done: true }),
    },
  })

  // Chat is BETA and off by default, so every test that exercises it opts the workspace in
  // — which is itself the proof that the default is closed.
  await meta.setOrgSettings("default", {
    ...(await meta.getOrgSettings("default")),
    chatBeta: true,
    // Live publishing needs the workspace's OWN autonomy opt-in, which defaults off. The
    // suite sets it explicitly so the publish path is tested deliberately rather than by
    // accident — and the test below proves what happens without it.
    agentAutoEnabled: true,
  })

  // The document being chatted about.
  const res = await app.request("/v1/artifacts", {
    method: "POST",
    headers: as("ed@x.com"),
    body: (() => {
      const f = new FormData()
      f.set("file", new Blob(["# Original"], { type: "text/markdown" }), "doc.md")
      f.set("title", "Doc")
      return f
    })(),
  })
  const artifact = (await res.json()) as { short_id: string }

  // A context to own the session. Chat still needs one — see the NOT NULL constraint in the
  // design doc — so the fixture creates it directly rather than pretending otherwise.
  const agent = await meta.createAgent({
    id: newId("ag"),
    org_id: "default",
    name: `chat-${name}`,
    created_by: "u-ed",
    token: `tok-${name}`,
    role: "editor",
  })
  const cx = await meta.createContext({
    id: newId("cx"),
    org_id: "default",
    name: `chat-${name}`,
    agent_id: agent.id,
    manifest_artifact_id: (await meta.getByShortId(artifact.short_id))?.id ?? "",
    created_by: "u-ed",
  })
  return { app, meta, artifact, cx }
}

/** Open a session naming the document, then wait for the agent's reply to land. `serveAttended`
 *  is detached, so the transcript — not the response — is the completion signal. */
const chat = async (
  app: Awaited<ReturnType<typeof setup>>["app"],
  meta: Awaited<ReturnType<typeof setup>>["meta"],
  cxId: string,
  subject: unknown,
  body: string,
) => {
  const opened = await app.request(`/v1/contexts/${cxId}/sessions`, {
    method: "POST",
    headers: { ...as("ed@x.com"), "content-type": "application/json" },
    body: JSON.stringify({ body_md: "starting", subject }),
  })
  const { session } = (await opened.json()) as { session: { id: string; subject: unknown } }
  await app.request(`/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { ...as("ed@x.com"), "content-type": "application/json" },
    body: JSON.stringify({ body_md: body }),
  })
  for (let i = 0; i < 100; i++) {
    const msgs = await meta.listSessionMessages(session.id)
    if (msgs.some((m) => m.author_kind === "agent")) return { session, msgs }
    await new Promise((r) => setTimeout(r, 20))
  }
  return { session, msgs: await meta.listSessionMessages(session.id) }
}

describe("the document rail obeys the operator's deploy-wide model", () => {
  /**
   * This lane took `ctx.callModel` — the deploy's CONFIGURED default — directly, so the
   * operator's live switch moved the workspace chat, the comment mention and Slack, and left
   * the document rail answering on the old model while its own settings copy promised "across
   * this whole deployment". A lever with a hole in it is worse than no lever, because it is
   * trusted; these two tests are the hole.
   */
  const railSetup = async (name: string) => {
    const users = [{ id: "u-ed", email: "ed@x.com", name: "Ed" }]
    const { app, meta } = makeAuthedApp(name, users, undefined, {
      deps: {
        models: catalogOf([
          {
            id: "old",
            label: "Old",
            isDefault: true,
            build: () => async () => ({
              text: "answered by old",
              toolUses: [],
              costUsd: null,
              done: true,
            }),
          },
          {
            id: "new",
            label: "New",
            isDefault: false,
            build: () => async () => ({
              text: "answered by new",
              toolUses: [],
              costUsd: null,
              done: true,
            }),
          },
        ]),
      },
    })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })
    const res = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as("ed@x.com"),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Original"], { type: "text/markdown" }), "doc.md")
        f.set("title", "Doc")
        return f
      })(),
    })
    const artifact = (await res.json()) as { short_id: string }
    const agent = await meta.createAgent({
      id: newId("ag"),
      org_id: "default",
      name: `rail-${name}`,
      created_by: "u-ed",
      token: `tok-${name}`,
      role: "editor",
    })
    const cx = await meta.createContext({
      id: newId("cx"),
      org_id: "default",
      agent_id: agent.id,
      name: `rail-${name}`,
      manifest_artifact_id: (await meta.getByShortId(artifact.short_id))?.id ?? "",
      created_by: "u-ed",
    })
    return { app, meta, artifact, cx }
  }

  const askRail = async (name: string, pin: string | null) => {
    const { app, meta, artifact, cx } = await railSetup(name)
    if (pin) await setInstanceChatModel(meta, pin)
    const { msgs } = await chat(
      app,
      meta,
      cx.id,
      { kind: "artifact", id: artifact.short_id },
      "how long is it?",
    )
    return msgs.at(-1)
  }

  it("answers with the configured default when the operator has pinned nothing", async () => {
    expect((await askRail("rail-default", null))?.body_md).toContain("answered by old")
  })

  it("answers with the operator's pin, and records WHICH model wrote it", async () => {
    const last = await askRail("rail-pinned", "new")
    expect(last?.body_md).toContain("answered by new")
    // The rail never recorded a model, so a rail answer could not be attributed and its latency
    // counted for nobody — which is the other half of this lane being invisible.
    const meta = JSON.parse(last?.meta ?? "{}") as {
      model?: { id: string }
      model_ms?: number
    }
    expect(meta.model?.id).toBe("new")
    expect(typeof meta.model_ms).toBe("number")
  })
})

describe("chatting with a document", () => {
  it("edits it, and the agent replies in the transcript", async () => {
    const { app, meta, artifact, cx } = await setup("chat-edit", revision("# Shorter"))
    const { session, msgs } = await chat(
      app,
      meta,
      cx.id,
      { kind: "artifact", id: artifact.short_id, mode: "publish" },
      "make it shorter",
    )
    // The session carries the subject back, so a surface knows what it is looking at.
    expect(session.subject).toMatchObject({ kind: "artifact", id: artifact.short_id })
    // The agent answered...
    expect(msgs.at(-1)?.author_kind).toBe("agent")
    // ...and the document actually moved.
    const fresh = await meta.getByShortId(artifact.short_id)
    expect(fresh?.current_version).toBe(2)
  })

  it("answers a QUESTION without touching the document", async () => {
    const { app, meta, artifact, cx } = await setup("chat-ask", "It is one line long.")
    const { msgs } = await chat(
      app,
      meta,
      cx.id,
      { kind: "artifact", id: artifact.short_id },
      "how long is it?",
    )
    expect(msgs.at(-1)?.body_md).toContain("one line long")
    expect((await meta.getByShortId(artifact.short_id))?.current_version).toBe(1)
  })
})

describe("the subject is authorized separately from the context", () => {
  it("REFUSES a subject the asker cannot read", async () => {
    // Ask-access to a context is not read-access to a document. Without this check a session
    // would be a way to read any artifact by naming it.
    const { app, cx } = await setup("chat-authz", revision("# x"))
    const res = await app.request(`/v1/contexts/${cx.id}/sessions`, {
      method: "POST",
      headers: { ...as("ed@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "hi", subject: { kind: "artifact", id: "nope-not-real" } }),
    })
    expect(res.status).toBe(404)
  })

  it("rejects a malformed subject rather than silently ignoring it", async () => {
    const { app, cx } = await setup("chat-bad", revision("# x"))
    const res = await app.request(`/v1/contexts/${cx.id}/sessions`, {
      method: "POST",
      headers: { ...as("ed@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "hi", subject: { kind: "nonsense" } }),
    })
    expect(res.status).toBe(400)
  })
})

describe("the beta gate", () => {
  it("REFUSES a workspace that has explicitly turned chat OFF", async () => {
    // Chat is ON by default now, so the case worth gating is the workspace that opted OUT.
    // A flag that only hides a button is not a gate: the route is reachable directly, and this
    // is the lane that spends the operator's model key.
    const users = [{ id: "u-ed", email: "ed@x.com", name: "Ed" }]
    const { app } = makeAuthedApp("chat-beta-off", users, undefined, {
      deps: { callModel: async () => ({ text: "hi", toolUses: [], costUsd: null, done: true }) },
    })
    const made = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as("ed@x.com"),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Doc"], { type: "text/markdown" }), "doc.md")
        f.set("title", "Doc")
        return f
      })(),
    })
    const { short_id } = (await made.json()) as { short_id: string }
    // Opt OUT, which is now the deliberate act.
    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { ...as("ed@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ chatBeta: false }),
    })
    const res = await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as("ed@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "hello" }),
    })
    expect(res.status).toBe(404)
  })

  it("ANSWERS a workspace that has done nothing, because chat is on by default", () => {
    // The default itself is the product decision: an opt-in everybody has to find is a feature
    // nobody has. Asserted on the defaults rather than through a route so it cannot drift
    // silently when the settings shape moves.
    expect(DEFAULT_ORG_SETTINGS.chatBeta).toBe(true)
    // Automations stay opt-in: they run unattended and can write while nobody is watching.
    expect(DEFAULT_ORG_SETTINGS.automateBeta).toBe(false)
  })
})

describe("chat obeys the workspace's autonomy settings", () => {
  const withSettings = async (name: string, settings: Record<string, unknown>) => {
    const users = [{ id: "u-ed", email: "ed@x.com", name: "Ed" }]
    const { app, meta } = makeAuthedApp(name, users, undefined, {
      deps: {
        callModel: async () => ({
          text: revision("# New"),
          toolUses: [],
          costUsd: null,
          done: true,
        }),
      },
    })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
      ...settings,
    })
    const made = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as("ed@x.com"),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Doc"], { type: "text/markdown" }), "doc.md")
        f.set("title", "Doc")
        return f
      })(),
    })
    const { short_id } = (await made.json()) as { short_id: string }
    await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as("ed@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "make it shorter", mode: "publish" }),
    })
    for (let i = 0; i < 100; i++) {
      const a = await meta.getByShortId(short_id)
      if ((a?.current_version ?? 0) > 1) break
      if ((await meta.listProposals(a?.id ?? "")).length) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const art = await meta.getByShortId(short_id)
    return {
      version: art?.current_version,
      proposals: (await meta.listProposals(art?.id ?? "")).length,
    }
  }

  it("does NOT live-publish when the workspace has not opted into auto", async () => {
    // The default. mode:"publish" is the USER's consent for this document; agentAutoEnabled is
    // the WORKSPACE's consent for agents to write live at all. Both are required.
    const r = await withSettings("chat-auto-off", { agentAutoEnabled: false })
    expect(r.version).toBe(1)
    expect(r.proposals).toBe(1)
  })

  it("obeys the KILLSWITCH even with auto on", async () => {
    // An operator who flips the killswitch after a bad run must stop chat too — hardcoding
    // these flags meant chat sailed straight past it.
    const r = await withSettings("chat-killswitch", {
      agentAutoEnabled: true,
      agentKillswitch: true,
    })
    expect(r.version).toBe(1)
    expect(r.proposals).toBe(1)
  })
})

describe("access is re-checked on every turn, not just at session open", () => {
  it("REFUSES once the asker has lost access to the document", async () => {
    // A session id is long-lived; an ACL is not. Checking only at creation made the session a
    // permanent grant: someone removed from the workspace still held the id, and every turn
    // read the document's CURRENT contents back to them and could publish to it.
    const users = [
      { id: "u-ed", email: "ed@x.com", name: "Ed" },
      { id: "u-mo", email: "mo@x.com", name: "Mo" },
    ]
    const { app, meta } = makeAuthedApp("chat-revoke", users, "editor", {
      deps: {
        callModel: async () => ({
          text: revision("# Owned"),
          toolUses: [],
          costUsd: null,
          done: true,
        }),
      },
    })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
      agentAutoEnabled: true,
    })
    const made = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as("ed@x.com"),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Secret"], { type: "text/markdown" }), "s.md")
        f.set("title", "Secret")
        return f
      })(),
    })
    const { short_id } = (await made.json()) as { short_id: string }

    // Mo opens a chat session while still a member.
    const opened = await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as("mo@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "hello" }),
    })
    expect(opened.status).toBe(201)
    const { session } = (await opened.json()) as { session: { id: string } }

    // Mo is removed from the workspace, but still holds the session id.
    await meta.removeMembership("default", "u-mo")

    const before = (await meta.getByShortId(short_id))?.current_version
    await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { ...as("mo@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "rewrite the whole thing" }),
    })
    for (let i = 0; i < 60; i++) {
      const msgs = await meta.listSessionMessages(session.id)
      if (msgs.some((m) => m.author_kind === "agent")) break
      await new Promise((r) => setTimeout(r, 20))
    }
    // The document is untouched, and the transcript says why rather than going silent.
    expect((await meta.getByShortId(short_id))?.current_version).toBe(before)
    const last = (await meta.listSessionMessages(session.id)).at(-1)
    expect(last?.body_md ?? "").toMatch(/no longer have access|not found/i)
  })
})

describe("the allowlist, when the OPERATOR's key pays", () => {
  const setup = async (name: string, allowlist: string[] | undefined) => {
    const users = [{ id: "u-ed", email: "ed@x.com", name: "Ed" }]
    const { app, meta } = makeAuthedApp(name, users, undefined, {
      deps: {
        callModel: async () => ({
          text: revision("# New"),
          toolUses: [],
          costUsd: null,
          done: true,
        }),
        chatAllowlist: allowlist,
      },
    })
    // The workspace opts ITSELF in — which is exactly the move the allowlist has to survive.
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })
    const made = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as("ed@x.com"),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Doc"], { type: "text/markdown" }), "d.md")
        f.set("title", "Doc")
        return f
      })(),
    })
    const { short_id } = (await made.json()) as { short_id: string }
    return app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as("ed@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "hello" }),
    })
  }

  it("REFUSES a workspace that enabled chat but is not on the list", async () => {
    // The abuse this closes: chatBeta is gated on `manage`, so on a shared host any workspace
    // owner can switch it on. Without the allowlist that is a self-serve licence to spend the
    // operator's model key.
    const res = await setup("allow-no", ["ws_someone_else"])
    expect(res.status).toBe(404)
  })

  it("ALLOWS a listed workspace", async () => {
    const res = await setup("allow-yes", ["default"])
    expect(res.status).toBe(201)
  })

  it("an EMPTY list means no restriction — a single-tenant box is not a shared host", async () => {
    const res = await setup("allow-empty", [])
    expect(res.status).toBe(201)
  })
})

// A CHAT SESSION IS A WORKSPACE ACTION, not a document action.
//
// `authorize(c, "read", art)` is satisfied by a viewer LINK, so a signed-in stranger who was sent
// one could POST /v1/artifacts/chat-session against a document in a chat-enabled workspace and
// get 201 plus a live turn on the OPERATOR's model key — from outside the workspace entirely.
describe("chat requires membership, not merely read access", () => {
  const owner = { id: "u-own", email: "own@x.com", name: "Own" }
  const stranger = { id: "u-str", email: "str@x.com", name: "Str" }

  /** A workspace with chat on, a link-readable document, and a signed-in NON-MEMBER. */
  const linkReadable = async (name: string) => {
    // BOTH users exist and can sign in; the stranger's SEAT is removed below, which is the
    // only difference between them. That is the whole point: authentication is not membership.
    const { app, meta } = makeAuthedApp(name, [owner, stranger], "editor", {
      deps: {
        callModel: async () => ({
          text: revision("# Rewritten"),
          toolUses: [],
          costUsd: null,
          done: true,
        }),
      },
    })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
      agentAutoEnabled: true,
    })
    const made = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as(owner.email),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Public\n\nread me"], { type: "text/markdown" }), "p.md")
        f.set("title", "Public")
        // Anyone with the link can read it. This is a normal, supported sharing state.
        f.set("link_role", "viewer")
        f.set("listed", "public")
        return f
      })(),
    })
    expect(made.status).toBe(201)
    const { short_id } = (await made.json()) as { short_id: string }
    await meta.removeMembership("default", stranger.id)
    return { app, meta, short_id }
  }

  it("refuses to open a chat session for a signed-in NON-MEMBER", async () => {
    const { app, short_id } = await linkReadable("chat-nonmember")
    const res = await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as(stranger.email), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "rewrite this for me" }),
    })
    // 404, matching every other un-entitled surface: it should not confirm what it refuses.
    expect(res.status).toBe(404)
  })

  it("still lets a member open one on the same document", async () => {
    // The positive control — without it "404" could just mean the fixture is broken.
    const { app, short_id } = await linkReadable("chat-member-ok")
    const res = await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "rewrite this for me" }),
    })
    expect(res.status).toBe(201)
  })

  it("stops serving turns to a member who is removed but keeps a viewer link", async () => {
    // The one-turn-later version of the same hole: the per-turn ACL re-check folds in link_role,
    // so losing the SEAT was not enough to stop a session that was already open.
    const { app, meta, short_id } = await linkReadable("chat-removed-seat")
    await meta.setMembership({
      id: newId("mem"),
      org_id: "default",
      user_id: stranger.id,
      role: "editor",
    })
    const opened = await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as(stranger.email), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "hello" }),
    })
    expect(opened.status).toBe(201)
    const { session } = (await opened.json()) as { session: { id: string } }

    await meta.removeMembership("default", stranger.id)
    const before = (await meta.getByShortId(short_id))?.current_version

    await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { ...as(stranger.email), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "now rewrite the whole thing" }),
    })
    for (let i = 0; i < 60; i++) {
      const msgs = await meta.listSessionMessages(session.id)
      if (msgs.filter((m) => m.author_kind === "agent").length > 1) break
      await new Promise((r) => setTimeout(r, 20))
    }
    // The document is untouched, and the transcript says why rather than going silent.
    expect((await meta.getByShortId(short_id))?.current_version).toBe(before)
    const last = (await meta.listSessionMessages(session.id)).at(-1)
    expect(last?.body_md ?? "").toMatch(/not a member/i)
  })
})

// FOLLOW-UPS ARE THE LANE THAT SPENDS, and they had no ceiling of any kind.
//
// `askLimiter` guarded session CREATION only, and dispatch's monthly budget only covers work
// that goes through dispatch — an attended follow-up goes through neither. So one session, then
// an unbounded loop of follow-ups through it, was a completely unmetered way to spend the
// operator's model key. And the beta gate hung off `!s.context_id`, so chat wearing a context
// (a session opened with a `subject`) kept serving turns after the flag came off.
describe("follow-ups are limited, budgeted, and gated", () => {
  const ed = { id: "u-ed", email: "ed@x.com", name: "Ed" }

  const chatApp = async (name: string, deps: Record<string, unknown> = {}) => {
    const { app, meta } = makeAuthedApp(name, [ed], undefined, {
      deps: {
        callModel: async () => ({
          text: revision("# Rewritten"),
          toolUses: [],
          costUsd: null,
          done: true,
        }),
        ...deps,
      },
    })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
      agentAutoEnabled: true,
    })
    const made = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as(ed.email),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Doc\n\nbody"], { type: "text/markdown" }), "d.md")
        f.set("title", "Doc")
        return f
      })(),
    })
    const { short_id } = (await made.json()) as { short_id: string }
    const opened = await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as(ed.email), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "hello" }),
    })
    expect(opened.status).toBe(201)
    const { session } = (await opened.json()) as { session: { id: string } }
    const followUp = (text: string) =>
      app.request(`/v1/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { ...as(ed.email), "content-type": "application/json" },
        body: JSON.stringify({ body_md: text }),
      })
    return { app, meta, session, followUp }
  }

  it("rate-limits follow-ups with the same limiter that guards session creation", async () => {
    // askRate 2: opening the session spends one, so the second follow-up is the one over.
    const { followUp } = await chatApp("chat-followup-rl", {
      rateLimit: true,
      rateLimiters: inMemoryRateLimiters({ askRate: 2 }),
    })
    expect((await followUp("one")).status).toBe(201)
    expect((await followUp("two")).status).toBe(429)
  })

  it("refuses a follow-up over the monthly budget, before recording it", async () => {
    const { meta, session, followUp } = await chatApp("chat-followup-budget")
    // REAL ROWS, not a stubbed store. Two reasons. The store cannot be stubbed by assignment
    // anyway on the Postgres lane (helpers.ts hands back a Proxy with only a `get` trap, so the
    // write lands on an empty target and every read still reaches the real driver). And the
    // interesting half is precisely what a stub skips: `sumRunCostSince` doing real SUM
    // arithmetic over a real cost column, which is a code path that only started carrying
    // non-zero numbers when the model clients began pricing a turn at all.
    //
    // A workspace-pool plan (user_id null) capped at 1,000 micro-USD, and one finished run that
    // already spent 5,000 of it.
    await meta.createPlan({
      id: newId("pl"),
      org_id: "default",
      user_id: null,
      kind: "model",
      provider: "anthropic",
      secret_enc: "test",
      limits: JSON.stringify({ monthlyMicroUsd: 1_000 }),
    })
    await meta.createRun({
      id: newId("run"),
      org_id: "default",
      agent_id: "ag_budget_probe",
      reason: "manual",
      status: "succeeded",
      cost_micro_usd: 5_000,
    })
    expect(await meta.sumRunCostSince("default", new Date(0).toISOString())).toBe(5_000)
    const res = await followUp("and again")
    expect(res.status).toBe(429)
    // Refused BEFORE the append: a rejected follow-up must not reopen the session with nothing
    // willing to serve it.
    const msgs = await meta.listSessionMessages(session.id)
    expect(msgs.some((m) => m.body_md === "and again")).toBe(false)
  })

  it("stops serving a SUBJECT-bearing context session once chatBeta is off", async () => {
    // The gate used to hang off `!s.context_id`. Chat also wears a context: a session opened
    // through POST /v1/contexts/:id/sessions with a `subject` is gated on chatBeta at creation
    // and then, once open, served turns forever after the flag came off. A kill switch that
    // leaves every existing conversation running is not a kill switch.
    const { app, meta, session, followUp } = await chatApp("chat-followup-gate")
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: false,
    })
    const before = (await meta.listSessionMessages(session.id)).length
    const res = await followUp("keep going")
    // The message is recorded (the asker typed it) but NOTHING is served.
    expect(res.status).toBe(201)
    await new Promise((r) => setTimeout(r, 150))
    const after = await meta.listSessionMessages(session.id)
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)?.author_kind).toBe("asker")
    void app
  })
})

// ---- Streaming the reply --------------------------------------------------
// The attended turn used to settle SILENTLY: served in-process, it never went through the
// runner report path that publishes, so a watching client learned the answer had landed only
// on its next poll. Streaming makes the terminal event mandatory — deltas with no settle leave
// a reader watching a reply that never officially finishes. These pin both halves.

/* (helper folded into the tests below) */

describe("an attended reply streams, then settles", () => {
  it("publishes coalesced deltas and a terminal settle, in that order, on the asker's channel", async () => {
    const seen: { channel: string; type: string; body: Record<string, unknown> }[] = []
    const inner = createInProcessBackplane()
    const plane = {
      ...inner,
      publish(channel: string, e: Record<string, unknown>) {
        seen.push({ channel, type: String(e.type), body: e })
        inner.publish(channel, e as never)
      },
      // Deltas take the RECEIPT-bearing publish (that count is what lets the stream switch
      // itself off when no tab is open), so the capture has to cover it too. Returning 1 stands
      // in for an open tab; the zero-listener shutoff is unit-tested in session-stream.test.ts.
      async publishWithReceipt(channel: string, e: Record<string, unknown>) {
        seen.push({ channel, type: String(e.type), body: e })
        inner.publish(channel, e as never)
        return 1
      },
    }
    const users = [{ id: "u-st", email: "st@x.com", name: "St" }]
    const { app, meta } = makeAuthedApp("chat-stream", users, undefined, {
      deps: {
        backplane: plane as never,
        // A model that streams its answer in pieces, exactly as the real adapter does.
        callModel: async ({ onDelta }) => {
          for (const piece of ["Hello", ", ", "world"]) onDelta?.(piece)
          return { text: "Hello, world", toolUses: [], costUsd: null, done: true }
        },
      },
    })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })
    const created = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as("st@x.com"),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Doc"], { type: "text/markdown" }), "doc.md")
        f.set("title", "Doc")
        return f
      })(),
    })
    const { short_id } = (await created.json()) as { short_id: string }

    const opened = await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as("st@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "hi", mode: "propose" }),
    })
    expect(opened.status).toBe(201)
    const sessionId = ((await opened.json()) as { session: { id: string } }).session.id

    // serveAttended is detached — wait for the transcript to carry the agent's reply.
    for (let i = 0; i < 60; i++) {
      const msgs = await meta.listSessionMessages(sessionId)
      if (msgs.some((m) => m.author_kind === "agent")) break
      await new Promise((r) => setTimeout(r, 25))
    }

    const mine = seen.filter((e) => e.body.session_id === sessionId)
    const deltas = mine.filter((e) => e.type === "session.delta")
    const settles = mine.filter((e) => e.type === "session.settled")

    // Deltas landed, on the ASKER's channel, and their text is the whole reply in order.
    expect(deltas.length).toBeGreaterThan(0)
    expect(new Set(deltas.map((d) => d.channel))).toEqual(new Set(["u:u-st"]))
    expect(deltas.map((d) => d.body.text).join("")).toBe("Hello, world")
    expect(deltas.map((d) => d.body.seq)).toEqual(deltas.map((_, i) => i + 1))
    // COALESCED: three model pieces did not become three publishes.
    expect(deltas.length).toBeLessThan(3)

    // ...and the turn ended with exactly one terminal event, AFTER every delta.
    expect(settles).toHaveLength(1)
    expect(mine.at(-1)?.type).toBe("session.settled")
    expect(settles[0]?.body.state).toBe("answered")
  })

  it("still settles when there is no model, so a client never waits forever", async () => {
    const seen: { type: string; body: Record<string, unknown> }[] = []
    const inner = createInProcessBackplane()
    const plane = {
      ...inner,
      publish(channel: string, e: Record<string, unknown>) {
        seen.push({ type: String(e.type), body: e })
        inner.publish(channel, e as never)
      },
    }
    const users = [{ id: "u-nm", email: "nm@x.com", name: "Nm" }]
    // No callModel at all — the self-host default.
    const { app, meta } = makeAuthedApp("chat-nomodel-stream", users, undefined, {
      deps: { backplane: plane as never },
    })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })
    const created = await app.request("/v1/artifacts", {
      method: "POST",
      headers: as("nm@x.com"),
      body: (() => {
        const f = new FormData()
        f.set("file", new Blob(["# Doc"], { type: "text/markdown" }), "doc.md")
        f.set("title", "Doc")
        return f
      })(),
    })
    const { short_id } = (await created.json()) as { short_id: string }
    const opened = await app.request("/v1/artifacts/chat-session", {
      method: "POST",
      headers: { ...as("nm@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ short_id, body_md: "hi", mode: "propose" }),
    })
    // Chat is unreachable with no model wired, so either it refuses up front or it answers
    // in the transcript — both are terminal. What must NOT happen is a silent hang.
    if (opened.status === 201) {
      const sessionId = ((await opened.json()) as { session: { id: string } }).session.id
      for (let i = 0; i < 60; i++) {
        const msgs = await meta.listSessionMessages(sessionId)
        if (msgs.some((m) => m.author_kind === "agent")) break
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(seen.filter((e) => e.type === "session.settled")).toHaveLength(1)
    } else {
      expect(opened.status).toBeGreaterThanOrEqual(400)
    }
  })
})
