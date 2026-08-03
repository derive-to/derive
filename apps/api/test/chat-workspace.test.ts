import { describe, expect, it } from "vitest"
import type { ModelTurn } from "../src/lib/agent-loop"
import { catalogOf } from "../src/lib/model-catalog"
import { inMemoryRateLimiters } from "../src/lib/rate-limit"
import { as, makeAuthedApp, publishAs } from "./helpers"

// THE WORKSPACE CHAT, end to end through the real routes: open a session about no document at
// all, and the model answers using Derive's own tools against the asker's real permissions.
//
// Only the MODEL is faked. Auth, membership, the beta gate, the tool surface, the tool
// handlers, the transcript and the model catalog are all the real code path — which is the
// point: the tools are the SAME ones /mcp serves, so a test that stubbed them would prove
// nothing about the thing that could actually go wrong.

const setup = async (
  name: string,
  model: (req: {
    system: string
    messages: { role: string; content: unknown }[]
    tools: { name: string }[]
  }) => Promise<ModelTurn>,
  opts?: { chatBeta?: boolean; extraUsers?: { id: string; email: string; name: string }[] },
) => {
  const users = [{ id: "u-ws", email: "ws@x.com", name: "Wes" }, ...(opts?.extraUsers ?? [])]
  const seen: { system: string; tools: string[] }[] = []
  const { app, meta } = makeAuthedApp(name, users, undefined, {
    deps: {
      callModel: async (req) => {
        seen.push({ system: req.system, tools: req.tools.map((t) => t.name) })
        return model(req as Parameters<typeof model>[0])
      },
      // TWO models, so the picker, the per-turn switch and the unknown-id refusal are all
      // exercised rather than merely possible. Both answer through the same scripted function;
      // what is under test is the ROUTING, not the provider.
      models: catalogOf([
        {
          id: "model-a",
          label: "A",
          isDefault: true,
          build: () => async (req) => {
            seen.push({ system: req.system, tools: req.tools.map((t) => t.name) })
            return model(req as Parameters<typeof model>[0])
          },
        },
        {
          id: "model-b",
          label: "B",
          isDefault: false,
          build: () => async (req) => {
            seen.push({ system: req.system, tools: req.tools.map((t) => t.name) })
            return model(req as Parameters<typeof model>[0])
          },
        },
      ]),
      rateLimiters: inMemoryRateLimiters(),
    },
  })
  await meta.setOrgSettings("default", {
    ...(await meta.getOrgSettings("default")),
    // Beta and off by default, so every test opts in — which is itself the proof the default
    // is closed (and the flag-off case below proves the gate).
    chatBeta: opts?.chatBeta ?? true,
  })
  return { app, meta, seen }
}

/** Open a workspace chat and wait for the reply to land. `serveAttended` is detached, so the
 *  TRANSCRIPT is the completion signal, never the response. */
const ask = async (
  app: Awaited<ReturnType<typeof setup>>["app"],
  meta: Awaited<ReturnType<typeof setup>>["meta"],
  body: string,
  extra?: Record<string, unknown>,
  who = "ws@x.com",
) => {
  const res = await app.request("/v1/chat-session", {
    method: "POST",
    headers: { ...as(who), "content-type": "application/json" },
    body: JSON.stringify({ workspace: "default", body_md: body, ...extra }),
  })
  if (res.status !== 201) return { res, session: null, msgs: [] }
  const { session } = (await res.clone().json()) as { session: { id: string } }
  for (let i = 0; i < 100; i++) {
    const msgs = await meta.listSessionMessages(session.id)
    if (msgs.some((m) => m.author_kind === "agent")) return { res, session, msgs }
    await new Promise((r) => setTimeout(r, 20))
  }
  return { res, session, msgs: await meta.listSessionMessages(session.id) }
}

describe("the workspace chat", () => {
  it("answers using the real find tool, over the asker's own artifacts", async () => {
    const { app, meta, seen } = await setup(
      "ws-find",
      // Turn 1 searches; turn 2 answers with whatever the REAL find tool returned.
      (() => {
        let n = 0
        return async (req) => {
          n++
          if (n === 1)
            return {
              text: "",
              toolUses: [{ id: "t1", name: "find", input: { query: "roadmap" } }],
              costUsd: null,
              done: false,
            }
          const last = req.messages.at(-1)?.content
          const text = JSON.stringify(last)
          return {
            text: text.includes("Q3 Roadmap") ? "You have a Q3 Roadmap." : `no hit: ${text}`,
            toolUses: [],
            costUsd: null,
            done: true,
          }
        }
      })(),
    )
    await publishAs(app, "# Q3 Roadmap\n\nship the thing", { title: "Q3 Roadmap" }, as("ws@x.com"))

    const { msgs } = await ask(app, meta, "what do we have about the roadmap?")
    expect(msgs.at(-1)?.author_kind).toBe("agent")
    // The REAL tool ran against the REAL store and the model saw the artifact.
    expect(msgs.at(-1)?.body_md).toBe("You have a Q3 Roadmap.")
    // The model was offered exactly the chat subset — not the whole MCP surface.
    expect(seen[0]?.tools.sort()).toEqual(["call", "find", "publish", "read", "use"])
  })

  it("records which model answered, and a follow-up can switch models mid-conversation", async () => {
    const { app, meta } = await setup("ws-model", async () => ({
      text: "sure",
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    const { session, msgs } = await ask(app, meta, "hello")
    // Default model, recorded on the message: a transcript that cannot say what wrote it is
    // not a record.
    expect(JSON.parse(msgs.at(-1)?.meta ?? "{}").model).toMatchObject({ id: "model-a" })

    await app.request(`/v1/sessions/${session?.id}/messages`, {
      method: "POST",
      headers: { ...as("ws@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "again, bigger model", model: "model-b" }),
    })
    for (let i = 0; i < 100; i++) {
      const all = await meta.listSessionMessages(session?.id ?? "")
      if (all.filter((m) => m.author_kind === "agent").length === 2) {
        // The switch applies to the NEW turn and leaves the old answer's provenance alone.
        expect(JSON.parse(all.at(-1)?.meta ?? "{}").model).toMatchObject({ id: "model-b" })
        expect(JSON.parse(all[1]?.meta ?? "{}").model).toMatchObject({ id: "model-a" })
        return
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error("second turn never landed")
  })

  it("sticks to the conversation's model without being told again", async () => {
    const { app, meta } = await setup("ws-sticky", async () => ({
      text: "ok",
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    const { session } = await ask(app, meta, "hi", { model: "model-b" })
    await app.request(`/v1/sessions/${session?.id}/messages`, {
      method: "POST",
      headers: { ...as("ws@x.com"), "content-type": "application/json" },
      // NO model named: the choice must persist from the transcript, not fall back to default.
      body: JSON.stringify({ body_md: "and again" }),
    })
    for (let i = 0; i < 100; i++) {
      const all = await meta.listSessionMessages(session?.id ?? "")
      if (all.filter((m) => m.author_kind === "agent").length === 2) {
        expect(JSON.parse(all.at(-1)?.meta ?? "{}").model).toMatchObject({ id: "model-b" })
        return
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error("second turn never landed")
  })

  it("refuses an unknown model instead of quietly answering with another", async () => {
    const { app, meta } = await setup("ws-badmodel", async () => ({
      text: "x",
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    const { res } = await ask(app, meta, "hi", { model: "model-zzz" })
    expect(res.status).toBe(400)
  })

  it("lists the deploy's models, default first", async () => {
    const { app } = await setup("ws-models", async () => ({
      text: "x",
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    const res = await app.request("/v1/chat/models", { headers: as("ws@x.com") })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      models: [
        { id: "model-a", label: "A", is_default: true },
        { id: "model-b", label: "B", is_default: false },
      ],
    })
  })

  it("is 404 when the workspace has not enabled chat", async () => {
    const { app, meta } = await setup(
      "ws-flagoff",
      async () => ({ text: "x", toolUses: [], costUsd: null, done: true }),
      { chatBeta: false },
    )
    const { res } = await ask(app, meta, "hi")
    expect(res.status).toBe(404)
  })

  it("is 404 for a signed-in NON-MEMBER: being able to sign in is not standing to spend the key", async () => {
    const stranger = { id: "u-out", email: "out@x.com", name: "Outsider" }
    const { app, meta } = await setup(
      "ws-nonmember",
      async () => ({ text: "x", toolUses: [], costUsd: null, done: true }),
      { extraUsers: [stranger] },
    )
    // A real, signed-in account with NO seat in the workspace it is naming — which is the
    // shape that must be refused. Seeded as a member and then removed, because that is the
    // only way to have an account the auth layer knows and the workspace does not.
    await app.request("/v1/me", { headers: as(stranger.email) })
    await meta.removeMembership("default", stranger.id)
    const { res } = await ask(app, meta, "hi", {}, stranger.email)
    expect(res.status).toBe(404)
  })

  it("re-checks the seat every turn: a removed member stops being answered", async () => {
    const member = { id: "u-gone", email: "gone@x.com", name: "Gone" }
    const { app, meta } = await setup(
      "ws-removed",
      async () => ({ text: "sure", toolUses: [], costUsd: null, done: true }),
      { extraUsers: [member] },
    )
    const { session } = await ask(app, meta, "hello", {}, member.email)
    // The ACL changes AFTER the session exists, and the session id is long-lived.
    await meta.removeMembership("default", member.id)
    await app.request(`/v1/sessions/${session?.id}/messages`, {
      method: "POST",
      headers: { ...as(member.email), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "still there?" }),
    })
    for (let i = 0; i < 100; i++) {
      const all = await meta.listSessionMessages(session?.id ?? "")
      if (all.filter((m) => m.author_kind === "agent").length === 2) {
        // Refused IN THE TRANSCRIPT, with a reason — not a silent session the UI polls forever.
        expect(all.at(-1)?.body_md ?? "").toMatch(/no longer a member/i)
        return
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error("second turn never landed")
  })

  it("lists a person's own conversations with a preview, and nobody else's", async () => {
    const other = { id: "u-two", email: "two@x.com", name: "Two" }
    const { app, meta } = await setup(
      "ws-history",
      async () => ({ text: "answered", toolUses: [], costUsd: null, done: true }),
      { extraUsers: [other] },
    )
    await ask(app, meta, "first question about pricing")
    await ask(app, meta, "second question", {}, other.email)

    const mine = await (
      await app.request("/v1/chat-sessions?workspace=default", { headers: as("ws@x.com") })
    ).json()
    expect(mine.sessions).toHaveLength(1)
    expect(mine.sessions[0].preview).toContain("pricing")
    const theirs = await (
      await app.request("/v1/chat-sessions?workspace=default", { headers: as(other.email) })
    ).json()
    expect(theirs.sessions).toHaveLength(1)
    expect(theirs.sessions[0].preview).toContain("second")
  })

  it("keeps a failed turn in the transcript rather than leaving the session open", async () => {
    const { app, meta } = await setup("ws-fail", async () => {
      throw new Error("gateway exploded")
    })
    const { session, msgs } = await ask(app, meta, "hi")
    expect(msgs.at(-1)?.author_kind).toBe("agent")
    expect(msgs.at(-1)?.body_md).toMatch(/could not reach the model/i)
    expect((await meta.getSession(session?.id ?? ""))?.state).toBe("failed")
  })

  it("lets the asker Stop a workspace chat session — it has no context to gate on", async () => {
    // A workspace-chat session's context_id is always null, so the PATCH close route must not
    // require a linked context the way the agent-fail branch does. It used to: Stop 404ed on
    // every one of these sessions, the one lane the /chat page actually serves.
    const { app, meta } = await setup("ws-stop", async () => ({
      text: "answered",
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    const opened = await app.request("/v1/chat-session", {
      method: "POST",
      headers: { ...as("ws@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: "hi" }),
    })
    expect(opened.status).toBe(201)
    const { session } = (await opened.json()) as { session: { id: string } }
    const stopped = await app.request(`/v1/sessions/${session.id}`, {
      method: "PATCH",
      headers: { ...as("ws@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    })
    expect(stopped.status).toBe(200)
    expect((await meta.getSession(session.id))?.state).toBe("closed")
  })

  it("refuses to Stop someone else's workspace chat session", async () => {
    const other = { id: "u-nosy", email: "nosy@x.com", name: "Nosy" }
    const { app } = await setup(
      "ws-stop-other",
      async () => ({ text: "answered", toolUses: [], costUsd: null, done: true }),
      { extraUsers: [other] },
    )
    const opened = await app.request("/v1/chat-session", {
      method: "POST",
      headers: { ...as("ws@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: "hi" }),
    })
    const { session } = (await opened.json()) as { session: { id: string } }
    const stopped = await app.request(`/v1/sessions/${session.id}`, {
      method: "PATCH",
      headers: { ...as(other.email), "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    })
    expect(stopped.status).toBe(404)
  })
})
