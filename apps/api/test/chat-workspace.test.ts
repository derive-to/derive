import type { MetaStore } from "@derive/core"
import { describe, expect, it } from "vitest"
import type { ModelTurn } from "../src/lib/agent-loop"
import { INSTANCE_SETTINGS_ID } from "../src/lib/instance-settings"
import { catalogOf } from "../src/lib/model-catalog"
import { setInstanceSlot } from "../src/lib/model-library"
import { inMemoryRateLimiters } from "../src/lib/rate-limit"
import { as, countingStore, makeAuthedApp, publishAs } from "./helpers"

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
    /** The real contract carries this, and a scripted model that STREAMS is the only way to
     *  exercise time-to-first-token. Optional, exactly as the adapters treat it. */
    onDelta?: (text: string) => void
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

describe("a streamed turn records time to first token", () => {
  /**
   * TTFT WAS SILENTLY NULL ON EVERY REAL TURN. `session-stream`'s `wrap` spreads the caller's
   * input and then REPLACES `onDelta` with its own publisher, so the turn meter — composed
   * around it — was never called back. Nothing failed: the answer arrived, `model_ms` was
   * recorded, and the one number that predicts how chat FEELS was absent from every row of the
   * operator's page. A missing measurement does not announce itself, which is exactly why this
   * test exists and why it asserts a VALUE rather than a shape.
   *
   * Two things have to hold, and they are independent: the meter must sit inside the wrapper,
   * and the wrapper must pass a caller's callback through. Either alone fixes today's bug; both
   * together mean the next person to compose here cannot reintroduce it by choosing an order.
   */
  it("stores ttft_ms from the deltas the model actually streamed", async () => {
    const { app, meta } = await setup("ws-ttft", async ({ onDelta }) => {
      // A real stream: something arrives, then the rest of the turn happens.
      onDelta?.("Hel")
      await new Promise((r) => setTimeout(r, 30))
      onDelta?.("lo")
      return { text: "Hello", toolUses: [], costUsd: null, done: true }
    })
    const { msgs } = await ask(app, meta, "hi")
    const answer = msgs.at(-1)
    expect(answer?.author_kind).toBe("agent")
    const stored = JSON.parse(answer?.meta ?? "{}") as {
      ttft_ms?: number | null
      model_ms?: number
      model?: { id: string }
    }
    // A NUMBER, not merely a key: `null` is precisely what the bug produced.
    expect(typeof stored.ttft_ms).toBe("number")
    expect(stored.ttft_ms).toBeGreaterThanOrEqual(0)
    // First token before the turn finished — the whole point of measuring the two separately.
    expect(stored.ttft_ms as number).toBeLessThanOrEqual(stored.model_ms as number)
    expect(stored.model?.id).toBe("model-a")
  })
})

describe("what a workspace turn costs to route", () => {
  /**
   * A REGRESSION TEST WITH A NUMBER IN IT. The model library's first cut quietly TRIPLED this:
   * the gate asked the library whether anything could answer, the turn asked which model was
   * pinned, and the turn asked again for the catalog — three reads of ONE settings row on the
   * attended path, where each is a Hyperdrive round trip on the hosted tier and somebody is
   * waiting on all of them.
   *
   * Counted end to end through the real route, because the mechanism that holds it at one (a
   * per-turn memo, and a gate that reads the CONFIGURED catalog since the library can only add
   * to it) lives in two files and a unit test of either would miss the other. It found the third
   * read the first time it ran.
   *
   * At the STORE BOUNDARY through the shared `countingStore`, and specifically NOT by assigning
   * over `meta.getOrgSettings`: the pg store is itself a Proxy, so patching a method counts
   * nothing there. This test made exactly that mistake first and passed on SQLite while
   * measuring zero on Postgres — which is what the helper's own comment warns about.
   */
  // The same user `setup` seeds: the probe app's own store is discarded, so a user seeded
  // only there is a member of nothing in the store the requests actually reach.
  const owner = { id: "u-ws", email: "ws@x.com", name: "Wes" }
  const answer = async () => ({ text: "hi", toolUses: [], costUsd: null, done: true })

  it("reads the instance settings row ONCE for a whole turn", async () => {
    const base = await setup("ws-read-count", answer)
    const { proxy, countWhere, reset } = countingStore(base.meta as MetaStore)
    // Its OWN name: two apps sharing one share a Postgres schema and race to create it. The
    // probe's own store is built and never used — `deps.meta` overrides it with the wrapper.
    const { app } = makeAuthedApp("ws-read-count-probe", [owner], undefined, {
      deps: {
        meta: proxy,
        models: catalogOf([{ id: "model-a", label: "A", isDefault: true, build: () => answer }]),
        rateLimiters: inMemoryRateLimiters(),
      },
    })
    reset()
    const { session } = await ask(app, base.meta, "hello", undefined, owner.email)
    // WAIT LONGER THAN `ask` DOES, on purpose. Its 2s budget is generous on embedded SQLite and
    // marginal on the Postgres lane, where the turn settles through a container — the surrounding
    // suite's occasional reds there are that window, not the turn, which logs its outcome either
    // way. A budget test that flakes gets deleted rather than read, so this one waits.
    let msgs = await base.meta.listSessionMessages(session?.id ?? "")
    for (let i = 0; i < 400 && !msgs.some((m) => m.author_kind === "agent"); i++) {
      await new Promise((r) => setTimeout(r, 25))
      msgs = await base.meta.listSessionMessages(session?.id ?? "")
    }
    // The turn really ran — a count of zero on a turn that never happened proves nothing, which
    // is the OTHER way this assertion could pass while measuring nothing.
    expect(msgs.at(-1)?.author_kind).toBe("agent")
    expect(countWhere("getOrgSettings", (a) => a[0] === INSTANCE_SETTINGS_ID)).toBe(1)
  })
})

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

  it("settles a turn that outruns the runtime's budget instead of hanging on it", async () => {
    // THE PRODUCTION HANG, at unit scale. On Workers an attended turn is detached through
    // waitUntil, and Cloudflare ends that work ~30s after the response — the isolate stops, so a
    // turn still waiting on the model writes nothing and the session stays `working` for ever
    // with no answer and no error. Measured on two real hung turns: wallTimeMs 30418 and 30586
    // against cpuTimeMs 153 and 230, i.e. idle on a slow model rather than busy.
    //
    // A model that never answers stands in for the slow gateway. What matters is that the turn
    // settles ITSELF while it is still alive, so the transcript ends in a sentence rather than a
    // spinner. `attendedTurnBudgetMs` is tiny here so the test does not sit for 22 seconds.
    const never = () => new Promise<never>(() => {}) // never resolves, never rejects
    const users = [{ id: "u-ws", email: "ws@x.com", name: "Wes" }]
    const { app, meta } = makeAuthedApp("ws-budget", users, undefined, {
      deps: {
        attendedTurnBudgetMs: 50,
        callModel: never,
        models: catalogOf([{ id: "model-a", label: "A", isDefault: true, build: () => never }]),
        rateLimiters: inMemoryRateLimiters(),
      },
    })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })
    const opened = await app.request("/v1/chat-session", {
      method: "POST",
      headers: { ...as("ws@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: "something expensive" }),
    })
    expect(opened.status).toBe(201)
    const { session } = (await opened.json()) as { session: { id: string } }
    for (let i = 0; i < 100; i++) {
      const s = await meta.getSession(session.id)
      if (s && s.state !== "working" && s.state !== "open") {
        const msgs = await meta.listSessionMessages(session.id)
        expect(s.state).toBe("failed")
        // An honest sentence in the transcript, not silence.
        expect(msgs.at(-1)?.author_kind).toBe("agent")
        expect(msgs.at(-1)?.body_md ?? "").toMatch(/took longer/i)
        return
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error("the turn never settled — it hung, which is the bug")
  })

  it("switches model mid-conversation when the operator flips the deploy override", async () => {
    // THE OUTAGE LEVER. The deploy default lives in configuration, so changing it needs a
    // redeploy — the wrong shape for a provider that has gone slow or dark while people are
    // typing. This is the same choice held where it can be changed in seconds, and it has to
    // reach conversations that are ALREADY going: an override every existing conversation
    // ignores is not a lever.
    const { app, meta } = await setup("ws-override", async () => ({
      text: "ok",
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    const { session, msgs } = await ask(app, meta, "hello")
    expect(JSON.parse(msgs.at(-1)?.meta ?? "{}").model).toMatchObject({ id: "model-a" })

    // The OPERATOR flips it, deploy-wide. No redeploy, no restart.
    await setInstanceSlot(meta, "chat", "model-b")
    await app.request(`/v1/sessions/${session?.id}/messages`, {
      method: "POST",
      headers: { ...as("ws@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "and again" }), // no model named
    })
    for (let i = 0; i < 100; i++) {
      const all = await meta.listSessionMessages(session?.id ?? "")
      if (all.filter((m) => m.author_kind === "agent").length === 2) {
        // The NEXT turn uses the override even though this conversation was on model-a.
        expect(JSON.parse(all.at(-1)?.meta ?? "{}").model).toMatchObject({ id: "model-b" })
        // and the answer already given still records what actually produced it
        expect(JSON.parse(all[1]?.meta ?? "{}").model).toMatchObject({ id: "model-a" })
        return
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error("second turn never landed")
  })

  it("lets a person's explicit pick beat the operator override", async () => {
    // The override is the deploy's opinion; a model named on THIS turn is the person's, made
    // now, and it wins.
    const { app, meta } = await setup("ws-override-beaten", async () => ({
      text: "ok",
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    await setInstanceSlot(meta, "chat", "model-b")
    const { msgs } = await ask(app, meta, "hi", { model: "model-a" })
    expect(JSON.parse(msgs.at(-1)?.meta ?? "{}").model).toMatchObject({ id: "model-a" })
  })

  it("ignores an override that names nothing rather than failing every turn", async () => {
    // A typo in one field must cost the override, not the workspace's whole chat surface.
    const { app, meta } = await setup("ws-override-typo", async () => ({
      text: "ok",
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    await setInstanceSlot(meta, "chat", "not-a-real-model")
    const { msgs } = await ask(app, meta, "hi")
    expect(msgs.at(-1)?.author_kind).toBe("agent")
    expect(JSON.parse(msgs.at(-1)?.meta ?? "{}").model).toMatchObject({ id: "model-a" })
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
