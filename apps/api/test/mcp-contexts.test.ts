import { describe, expect, it } from "vitest"
import { createInProcessBackplane } from "../src/bus"
import { sha256 } from "../src/lib/crypto"
import { inMemoryRateLimiters } from "../src/lib/rate-limit"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The MCP ask surface after the 15→10 consolidation: `find` surfaces the askable
// contexts as typed {type:"context"} rows (the former list_contexts), and `use`
// acts on them (the former ask). Both act for the connection's on-behalf human
// (the token's registrant / the OAuth grantor), gated per call by that human's OWN
// ask-grant — canUserAskContext, the same rule the console enforces. `use` is
// registered on every connection and refuses a no-human connection at call time;
// `find` does NOT refuse it — it returns artifact rows plus a `contexts_note`
// explaining the contexts are hidden without a signed-in user.
//
// Cast: owner (Admin) registers the agents — the answering one and "OwnerBot",
// the MCP connection under test, whose acting human is therefore OWNER. dev
// (editor) publishes the manifest and creates the context, so dev is the
// CREATOR and owner is a plain member — the interesting side of every policy.

const owner: TestUser = { id: "u_mcx_own", email: "mcxown@derive.test", name: "Owner" }
const dev: TestUser = { id: "u_mcx_dev", email: "mcxdev@derive.test", name: "Dev" }

type App = ReturnType<typeof makeAuthedApp>["app"]

// A direct tools/call over the stateless /mcp endpoint (mcp-inbox-wait's shape).
// callRaw keeps the text + isError for error assertions; call JSON-parses a
// success payload.
const callRaw = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  const out = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  const t = r?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return { text: t, isError: !!r?.isError }
}
const call = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
): Promise<any> => JSON.parse((await callRaw(app, token, name, args)).text)

// find's browse/search rows are typed; the askable contexts come back as
// {type:"context"} rows — the former list_contexts payload, one per context, each
// carrying its own your_open_sessions. Pull just those out of a find result.
const contextsOf = (
  r: { results?: { type?: string }[] },
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
): any[] => (r.results ?? []).filter((x) => x.type === "context")

const setup = async (name: string, deps?: Record<string, unknown>) => {
  const made = makeAuthedApp(name, [owner, dev], "editor", deps ? { deps } : undefined)
  const { app, meta } = made
  await app.request("/v1/me", { headers: as(owner.email) })
  await app.request("/v1/me", { headers: as(dev.email) })
  // Agent registration is Admin-only, so owner mints both: the context's
  // answering agent and the MCP caller under test (acting human = owner).
  const answering = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
  ).json()
  const ownerBot = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
  ).json()
  // dev (editor) authors the manifest and creates the context — dev is creator.
  const manifest = await (
    await publishAs(app, "# Analytics manifest", { title: "Analytics manifest" }, as(dev.email))
  ).json()
  const cx = await (
    await app.request(
      "/v1/contexts",
      jsonAs(as(dev.email), {
        name: "Analytics",
        agent_id: answering.id,
        manifest_short_id: manifest.short_id,
      }),
    )
  ).json()
  return {
    app,
    meta,
    cx,
    manifestShortId: manifest.short_id as string,
    answeringToken: answering.token as string,
    ownerToken: ownerBot.token as string,
  }
}

describe("find — ask-scoped context discovery", () => {
  it("shows only what the acting human may ask; invited admits via the roster", async () => {
    const { app, cx, manifestShortId, ownerToken } = await setup("mcx-list")
    // Default ask_policy is `invited` (creator + roster): owner is a plain
    // member, so OwnerBot sees no context rows — and learns nothing exists.
    const before = await call(app, ownerToken, "find", {})
    expect(contextsOf(before)).toHaveLength(0)
    // The creator invites owner; the same call now surfaces the context row,
    // offline (its runner has never polled), with the manifest identity attached.
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/askers`,
          jsonAs(as(dev.email), { email: owner.email }),
        )
      ).status,
    ).toBe(201)
    const after = await call(app, ownerToken, "find", {})
    const ctxs = contextsOf(after)
    expect(ctxs).toMatchObject([
      {
        type: "context",
        id: cx.id,
        name: "Analytics",
        online: false,
        manifest: { short_id: manifestShortId, title: "Analytics manifest" },
      },
    ])
    expect(ctxs[0].your_open_sessions).toEqual([])
  })

  it("workspace policy admits every member; a web-opened session shows as resumable", async () => {
    const { app, cx, ownerToken } = await setup("mcx-list-ws")
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    // A session the human opened in the CONSOLE is the same session the agent
    // may resume — the MCP surface is the human's own seat. On a find context
    // row, that open session rides in the row's own your_open_sessions.
    const opened = await (
      await app.request(
        `/v1/contexts/${cx.id}/sessions`,
        jsonAs(as(owner.email), { body_md: "Q?" }),
      )
    ).json()
    const res = await call(app, ownerToken, "find", {})
    const ctxs = contextsOf(res)
    expect(ctxs).toHaveLength(1)
    expect(ctxs[0].your_open_sessions).toMatchObject([{ id: opened.session.id, state: "open" }])
  })

  it("a connection with no acting human returns a note, not context rows (find never refuses)", async () => {
    const { app, meta } = await setup("mcx-list-nohuman")
    // A pre-column legacy token: a registered agent with no created_by. Only
    // reachable by seeding the store directly — the API always stamps a creator.
    const raw = "dk_agt_mcx_legacy"
    const orgs = await meta.listWorkspaces(owner.id)
    await meta.createAgent({
      id: "ag_mcx_legacy",
      org_id: orgs[0]?.id ?? "",
      name: "Legacy",
      token: sha256(raw),
      role: "editor",
      created_by: null,
    })
    // INTENTIONAL behavior change from the retired list_contexts (which errored):
    // find does NOT refuse a no-human connection. It returns artifact rows and
    // adds a contexts_note saying the askable contexts are hidden without a
    // signed-in user — so no context row appears, but the browse itself succeeds.
    const r = await call(app, raw, "find", {})
    expect(r.contexts_note).toContain("no signed-in user")
    expect(contextsOf(r)).toHaveLength(0)
  })
})

// A REST answer from the context's agent — the runner's settle write.
const answerAs = (app: App, token: string, sessionId: string, body: Record<string, unknown>) =>
  app.request(`/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

describe("use — open, check, and the grant edges", () => {
  it("opens a session as the acting human; the console sees it as theirs", async () => {
    const { app, cx, ownerToken } = await setup("mcx-ask-open")
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    const res = await call(app, ownerToken, "use", {
      context: "Analytics",
      instruction: "What changed this week?",
      wait: 0,
    })
    expect(res.state).toBe("open")
    expect(res.context).toBe("Analytics")
    // The runner has never polled — the caller is told it looks offline.
    expect(res.note).toContain("OFFLINE")
    // The session is the HUMAN's: the console lists it exactly like a web ask.
    const sessions = await (
      await app.request(`/v1/contexts/${cx.id}/sessions`, { headers: as(owner.email) })
    ).json()
    expect(sessions.sessions).toMatchObject([
      { id: res.session_id, asker_id: owner.id, state: "open" },
    ])
  })

  it("returns the answer inline once the runner settled; check mode carries the transcript", async () => {
    const { app, cx, ownerToken, answeringToken } = await setup("mcx-ask-answered")
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    const opened = await call(app, ownerToken, "use", {
      context: cx.id,
      instruction: "Q?",
      wait: 0,
    })
    expect(
      (
        await answerAs(app, answeringToken, opened.session_id, {
          body_md: "42.",
          state: "answered",
          meta: { confidence: 0.9, artifacts: [{ short_id: "abc12345", title: "Q2 report" }] },
        })
      ).status,
    ).toBe(201)
    const res = await call(app, ownerToken, "use", { session_id: opened.session_id, wait: 0 })
    expect(res.state).toBe("answered")
    expect(res.answer).toMatchObject({ body_md: "42.", meta: { confidence: 0.9 } })
    // Check-only mode re-grounds a resumed caller: asker turn + agent turn.
    expect(res.transcript).toMatchObject([
      { author: "asker", body_md: "Q?" },
      { author: "agent", body_md: "42." },
    ])
  })

  it("clips an oversized answer and transcript entries, steering to the console", async () => {
    const { app, cx, ownerToken, answeringToken } = await setup("mcx-ask-clip")
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    // A 5k question and a 50k answer — both over their caps (1.5k/entry, 40k answer).
    const opened = await call(app, ownerToken, "use", {
      context: cx.id,
      instruction: "q".repeat(5_000),
      wait: 0,
    })
    expect(
      (
        await answerAs(app, answeringToken, opened.session_id, {
          body_md: "a".repeat(50_000),
          state: "answered",
        })
      ).status,
    ).toBe(201)
    const res = await call(app, ownerToken, "use", { session_id: opened.session_id, wait: 0 })
    // The answer keeps a generous prefix; the steer names the console.
    expect(res.answer.body_md.length).toBeLessThan(45_000)
    expect(res.answer.body_md).toContain("truncated")
    expect(res.answer.body_md).toContain(`/contexts/${cx.id}`)
    // Transcript entries are tight — the question comes back clipped too.
    const asker = res.transcript.find((m: { author: string }) => m.author === "asker")
    expect(asker.body_md.length).toBeLessThan(2_000)
    expect(asker.body_md).toContain(`/contexts/${cx.id}`)
    // Clipping truncates — the kept prefix is verbatim, not reflowed.
    expect(res.transcript.at(-1).body_md.startsWith("a".repeat(1_500))).toBe(true)
  })

  it("names the askable contexts when the ref misses — and stays silent when none are", async () => {
    const { app, cx, ownerToken } = await setup("mcx-ask-miss")
    // No grant at all: the miss must not enumerate what exists.
    const dark = await callRaw(app, ownerToken, "use", {
      context: "Analytics",
      instruction: "Q?",
      wait: 0,
    })
    expect(dark.isError).toBe(true)
    expect(dark.text).not.toContain("Analytics")
    // Granted, a typo'd ref names what CAN be asked (askable by definition).
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    const miss = await callRaw(app, ownerToken, "use", {
      context: "Analytcs",
      instruction: "Q?",
      wait: 0,
    })
    expect(miss.isError).toBe(true)
    expect(miss.text).toContain("Analytics")
  })

  it("a stranger's session_id reads as missing, never forbidden", async () => {
    const { app, cx, ownerToken } = await setup("mcx-ask-leak")
    // dev (the creator) opens a session in the console; owner's agent probes it.
    const opened = await (
      await app.request(
        `/v1/contexts/${cx.id}/sessions`,
        jsonAs(as(dev.email), { body_md: "mine" }),
      )
    ).json()
    const r = await callRaw(app, ownerToken, "use", { session_id: opened.session.id })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("No session")
    expect(r.text).not.toContain("forbidden")
  })
})

describe("use({wait}) — the settle wake and the session loop", () => {
  // The workspace-policy flip every case here needs (dev is creator; the MCP
  // caller acts for owner, a plain member).
  const openPolicy = async (app: App, cxId: string) =>
    expect(
      (
        await app.request(
          `/v1/contexts/${cxId}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)

  it("blocks, then wakes the instant the runner answers — not at timeout", async () => {
    const backplane = createInProcessBackplane()
    const { app, cx, ownerToken, answeringToken } = await setup("mcx-wake", { backplane })
    await openPolicy(app, cx.id)
    const opened = await call(app, ownerToken, "use", {
      context: "Analytics",
      instruction: "Q?",
      wait: 0,
    })
    const started = Date.now()
    const waiting = call(app, ownerToken, "use", { session_id: opened.session_id, wait: 20 })
    // A beat for the waiter to subscribe, then the runner settles over REST.
    await new Promise((r) => setTimeout(r, 150))
    expect(
      (
        await answerAs(app, answeringToken, opened.session_id, {
          body_md: "Here.",
          state: "answered",
        })
      ).status,
    ).toBe(201)
    const res = await waiting
    // Well under the 20s wait — the wake did it, not the timeout. (If this
    // asserts flaky in CI, the bound is the thing to loosen, never the wake.)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(res.state).toBe("answered")
    expect(res.answer).toMatchObject({ body_md: "Here." })
  })

  it("a follow-up rides the same session and re-opens it; closed refuses with a pointer", async () => {
    const { app, cx, ownerToken, answeringToken } = await setup("mcx-follow")
    await openPolicy(app, cx.id)
    const opened = await call(app, ownerToken, "use", {
      context: "Analytics",
      instruction: "Q?",
      wait: 0,
    })
    expect(
      (
        await answerAs(app, answeringToken, opened.session_id, {
          body_md: "A.",
          state: "answered",
        })
      ).status,
    ).toBe(201)
    const follow = await call(app, ownerToken, "use", {
      session_id: opened.session_id,
      instruction: "And why?",
      wait: 0,
    })
    expect(follow.state).toBe("open")
    // The asker closes in the console; the agent's next follow-up is refused
    // with the reopen pointer (same 409 semantics the REST path has).
    expect(
      (
        await app.request(`/v1/sessions/${opened.session_id}`, {
          ...jsonAs(as(owner.email), { state: "closed" }),
          method: "PATCH",
        })
      ).status,
    ).toBe(200)
    const refused = await callRaw(app, ownerToken, "use", {
      session_id: opened.session_id,
      instruction: "still there?",
      wait: 0,
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("closed")
  })

  it("the ask cap trips a looping agent; the check mode stays uncapped", async () => {
    const { app, cx, ownerToken } = await setup("mcx-cap", {
      rateLimit: true,
      rateLimiters: inMemoryRateLimiters({ askRate: 2 }),
    })
    await openPolicy(app, cx.id)
    const first = await call(app, ownerToken, "use", {
      context: "Analytics",
      instruction: "1",
      wait: 0,
    })
    await call(app, ownerToken, "use", { context: "Analytics", instruction: "2", wait: 0 })
    const third = await callRaw(app, ownerToken, "use", {
      context: "Analytics",
      instruction: "3",
      wait: 0,
    })
    expect(third.isError).toBe(true)
    expect(third.text).toContain("Rate limit")
    // Reads don't spend the budget: checking a session still works while capped.
    const check = await call(app, ownerToken, "use", { session_id: first.session_id, wait: 0 })
    expect(check.state).toBe("open")
  })
})

// create_context and the FRONTMATTER-ONLY skill rule: a context's skills load from the
// manifest's `skills:` frontmatter pins (lib/manifest-pins.ts) — a prose derive://skills/...
// mention in the body is deliberately not parsed. The REST create reports skills_count; the
// MCP create_context said nothing, so a body-only mention came back as a working context with
// skills:[] and no signal. It now reports the pin count and, when the body names skills that
// nothing pinned, says how to pin them — without adding a skills param or parsing prose.
describe("automate create_context — skills_count comes from frontmatter pins", () => {
  // The automate tool is owner-only, and /v1/agents caps registration at editor — so the
  // owner-role MCP caller is seeded straight into the store, acting for the workspace owner.
  const setupOwnerBot = async (name: string) => {
    const { app, meta } = makeAuthedApp(name, [owner])
    await app.request("/v1/me", { headers: as(owner.email) })
    const raw = `dk_agt_${name}`
    await meta.createAgent({
      id: `ag_${name}`,
      org_id: "default",
      name: "OwnerBot",
      token: sha256(raw),
      role: "owner",
      created_by: owner.id,
    })
    const createContext = async (contextName: string, content: string) => {
      const manifest = await (
        await publishAs(app, content, { title: `${contextName} manifest` }, as(owner.email))
      ).json()
      return call(app, raw, "automate", {
        action: "create_context",
        name: contextName,
        manifest_short_id: manifest.short_id,
      })
    }
    return { createContext }
  }

  it("counts the frontmatter pins, with no hint when the declaration is right", async () => {
    const { createContext } = await setupOwnerBot("mcx-cc-pins")
    const md = [
      "---",
      "skills:",
      "  - id: skl11111",
      "    version: 2",
      "  - id: skl22222",
      "---",
      "# QA manifest",
      "Run the checks with derive://skills/loop in mind.",
    ].join("\n")
    const r = await createContext("QA", md)
    expect(r.context_id).toBeTruthy()
    expect(r.skills_count).toBe(2)
    // Pinned properly: the body mention changes nothing and earns no lecture.
    expect(r.skills_hint).toBeUndefined()
  })

  it("a body-only derive://skills mention pins nothing — and the response says so", async () => {
    const { createContext } = await setupOwnerBot("mcx-cc-prose")
    const r = await createContext("QA", "# QA manifest\nRead derive://skills/loop before acting.")
    expect(r.context_id).toBeTruthy()
    expect(r.skills_count).toBe(0)
    // The hint teaches the fix: pins live in frontmatter, one `- id:` per skill.
    expect(r.skills_hint).toContain("frontmatter")
    expect(r.skills_hint).toContain("- id:")
  })

  it("no pins and no mention is just zero — silence, not a warning", async () => {
    const { createContext } = await setupOwnerBot("mcx-cc-plain")
    const r = await createContext("QA", "# QA manifest\nRun the checks.")
    expect(r.context_id).toBeTruthy()
    expect(r.skills_count).toBe(0)
    expect(r.skills_hint).toBeUndefined()
  })
})
