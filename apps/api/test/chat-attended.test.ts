import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
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
