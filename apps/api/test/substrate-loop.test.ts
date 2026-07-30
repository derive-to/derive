import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loopSubstrate } from "../src/lib/substrate-loop"

// THE LOOP SUBSTRATE, against a stub of our own API.
//
// The substrate is an HTTP client of Derive — that is the whole design, and it is why the same
// file runs on Node and Cloudflare. So it is tested the way it actually behaves: a real HTTP
// server on a loopback port, real fetch, real status codes. A mocked fetch would test the mock.
//
// These were live scripts first, which is how the write-check bug below was found. Committing
// them means CI runs them; a script in someone's scratchpad protects nothing.

interface Recorded {
  claims: number
  tools: { tool: string; args: unknown }[]
  writes: { path: string }[]
  finishes: Record<string, unknown>[]
}

/** A stub Derive: serves one claimable run, echoes tools, and records what the substrate did. */
const stubApi = (opts: {
  run: Record<string, unknown>
  /** Status for artifact writes — 403 exercises the refused-write path. */
  writeStatus?: number
  toolStatus?: number
}) => {
  const rec: Recorded = { claims: 0, tools: [], writes: [], finishes: [] }
  let server: Server
  const ready = new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => {
        body += c
      })
      req.on("end", async () => {
        const url = req.url ?? ""
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { "content-type": "application/json" })
          res.end(JSON.stringify(obj))
        }
        if (url.endsWith("/runs/claim")) {
          rec.claims += 1
          return send(200, { runs: [opts.run] })
        }
        if (url.includes("/model-credential")) {
          return send(200, { credential: { kind: "api_key", value: "sk-stub" } })
        }
        if (url.endsWith("/tool")) {
          const parsed = JSON.parse(body || "{}")
          rec.tools.push({ tool: parsed.tool, args: parsed.args })
          if (opts.toolStatus && opts.toolStatus !== 200)
            return send(opts.toolStatus, { error: "tool refused" })
          return send(200, { result: { rows: 3, echo: parsed.args } })
        }
        if (url.endsWith("/finish")) {
          rec.finishes.push(JSON.parse(body || "{}"))
          return send(200, { ok: true })
        }
        // Artifact writes: proposals, versions, create.
        rec.writes.push({ path: url })
        const status = opts.writeStatus ?? 201
        return send(status, status < 400 ? { short_id: "art_new" } : { error: "forbidden" })
      })
    })
    server.listen(0, () =>
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
    )
  })
  return {
    rec,
    url: ready,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const revision = (content = "# New", confidence: number | null = 0.95) =>
  `<revision>${JSON.stringify({ content, filename: "notes.md", confidence, message: "m" })}</revision>`

/** Runs the substrate to completion — `start` returns once the work BEGINS, so the test awaits
 *  the settle by polling the stub's recorded finishes. */
const runToSettle = async (
  server: string,
  rec: Recorded,
  callModel: Parameters<typeof loopSubstrate>[0]["callModel"],
) => {
  await loopSubstrate({ callModel }).start({ runId: "run_1", token: "tok", server })
  // Poll for up to 10s, not 2s. `start` returns once the work BEGINS, so the settle lands on
  // its own schedule — and under a full parallel suite the original 2s budget was occasionally
  // shorter than the run, which reads as "the substrate never finished" when it simply had not
  // finished YET. A generous ceiling costs nothing on the happy path (it exits on the first
  // finish) and buys a test that fails for real reasons only.
  const deadline = Date.now() + 10_000
  while (rec.finishes.length === 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20))
  return rec.finishes[0] ?? null
}

const baseRun = {
  id: "run_1",
  instruction: "Refresh the roadmap",
  targets: [{ kind: "artifact", id: "art_1" }],
  flags: { agentKillswitch: false, agentAutoEnabled: true },
}

describe("loop substrate: the happy path", () => {
  let api: ReturnType<typeof stubApi>
  let url: string
  beforeAll(async () => {
    api = stubApi({ run: baseRun })
    url = await api.url
  })
  afterAll(() => api.close())

  it("claims, runs the model, and settles with an outcome and the spend", async () => {
    const fin = await runToSettle(url, api.rec, async () => ({
      text: revision(),
      toolUses: [],
      costUsd: 0.004,
      done: true,
    }))
    expect(api.rec.claims).toBe(1)
    expect(fin?.status).toBe("succeeded")
    // 0.004 USD → 4000 micro-USD, rounded up. Reported on the SETTLE, not merely computed.
    expect(fin?.cost_micro_usd).toBe(4000)
    expect(api.rec.writes.some((w) => w.path.includes("/proposals"))).toBe(true)
  })
})

describe("loop substrate: the gate decides the write", () => {
  it("a target with no publish mode PROPOSES, even when the workspace allows auto", async () => {
    // Consent is per target. Absent an explicit publish mode the run may not live-publish, no
    // matter how the workspace is configured — the model never gets to choose.
    const api = stubApi({ run: baseRun })
    const url = await api.url
    const fin = await runToSettle(url, api.rec, async () => ({
      text: revision(),
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    expect(fin?.meta).toMatchObject({ outcome: "proposed" })
    expect(api.rec.writes[0]?.path).toContain("/proposals")
    await api.close()
  })

  it("mode=publish on an opted-in workspace writes a VERSION", async () => {
    const api = stubApi({
      run: { ...baseRun, targets: [{ kind: "artifact", id: "art_1", mode: "publish" }] },
    })
    const url = await api.url
    const fin = await runToSettle(url, api.rec, async () => ({
      text: revision(),
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    expect(fin?.meta).toMatchObject({ outcome: "published" })
    expect(api.rec.writes[0]?.path).toContain("/versions")
    await api.close()
  })

  it("a TAINTED run cannot publish, whatever the target's mode says", async () => {
    // The structural injection defense, at the substrate: taint comes from the CLAIM (the
    // server's view), so an executor cannot talk its way out of it.
    const api = stubApi({
      run: {
        ...baseRun,
        tainted: true,
        targets: [{ kind: "artifact", id: "art_1", mode: "publish" }],
      },
    })
    const url = await api.url
    const fin = await runToSettle(url, api.rec, async () => ({
      text: revision(),
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    expect(fin?.meta).toMatchObject({ outcome: "proposed" })
    expect(api.rec.writes[0]?.path).toContain("/proposals")
    await api.close()
  })

  it("the killswitch demotes to a proposal", async () => {
    const api = stubApi({
      run: {
        ...baseRun,
        flags: { agentKillswitch: true, agentAutoEnabled: true },
        targets: [{ kind: "artifact", id: "art_1", mode: "publish" }],
      },
    })
    const url = await api.url
    const fin = await runToSettle(url, api.rec, async () => ({
      text: revision(),
      toolUses: [],
      costUsd: null,
      done: true,
    }))
    expect(fin?.meta).toMatchObject({ outcome: "proposed" })
    await api.close()
  })
})

describe("loop substrate: failures", () => {
  it("a REFUSED write settles FAILED — never a success with an artifact id", async () => {
    // The bug this file was written for. `call` returns a raw Response and does not throw, so an
    // unchecked write meant a 403 was ignored and the run settled `succeeded` with an artifact id:
    // a failed write recorded as a successful run, which is the worst shape a ledger bug takes.
    const api = stubApi({ run: baseRun, writeStatus: 403 })
    const url = await api.url
    const fin = await runToSettle(url, api.rec, async () => ({
      text: revision(),
      toolUses: [],
      costUsd: 0.002,
      done: true,
    }))
    expect(fin?.status).toBe("failed")
    expect(JSON.stringify(fin?.meta)).toContain("403")
    // Retryable: the expensive part (the model run) already happened, and a 5xx on publish is
    // exactly the transient case.
    expect(fin?.meta).toMatchObject({ retryable: true })
    // And the spend is still reported — the model ran, so it still cost money.
    expect(fin?.cost_micro_usd).toBe(2000)
    await api.close()
  })

  it("a model that never emits the block settles FAILED and NOT retryable", async () => {
    // Deterministic: a model that ignored the contract twice ignores it a third time, so a retry
    // spends the owner's plan again for the identical answer.
    const api = stubApi({ run: baseRun })
    const url = await api.url
    const fin = await runToSettle(url, api.rec, async () => ({
      text: "I updated it, trust me.",
      toolUses: [],
      costUsd: 0.001,
      done: true,
    }))
    expect(fin?.status).toBe("failed")
    expect(fin?.meta).toMatchObject({ retryable: false })
    expect(api.rec.writes).toHaveLength(0)
    await api.close()
  })

  it("a failing TOOL is handed to the model, not fatal to the run", async () => {
    // A dead source is information the model should react to, not a reason to lose the work.
    const api = stubApi({ run: baseRun, toolStatus: 502 })
    const url = await api.url
    let turn = 0
    const fin = await runToSettle(url, api.rec, async () => {
      turn += 1
      return turn === 1
        ? {
            text: "",
            toolUses: [{ id: "t1", name: "svc.read", input: {} }],
            costUsd: null,
            done: false,
          }
        : { text: revision("# Degraded"), toolUses: [], costUsd: null, done: true }
    })
    expect(api.rec.tools).toHaveLength(1)
    expect(fin?.status).toBe("succeeded")
    await api.close()
  })
})

describe("loop substrate: tools go through the run's endpoint", () => {
  it("a tool call is proxied, not made directly — so least-privilege and taint still apply", async () => {
    const api = stubApi({
      run: {
        ...baseRun,
        tools: [{ def: { name: "svc.read", description: "d", params: {} }, ref: "r" }],
      },
    })
    const url = await api.url
    let turn = 0
    await runToSettle(url, api.rec, async () => {
      turn += 1
      return turn === 1
        ? {
            text: "",
            toolUses: [{ id: "t1", name: "svc.read", input: { q: "x" } }],
            costUsd: null,
            done: false,
          }
        : { text: revision(), toolUses: [], costUsd: null, done: true }
    })
    expect(api.rec.tools).toEqual([{ tool: "svc.read", args: { q: "x" } }])
    await api.close()
  })
})

// ---- the ASK lane -----------------------------------------------------------------------------
//
// A session is somebody asking; a run is an automation firing. They share the turn (call the
// model, nudge once, gate, write) and differ in exactly two places, both of which are exercised
// here: how the work ARRIVES, and how it SETTLES.
//
// The arrival difference is the bug this lane was written for. The runs claim returns a LIST you
// search by id; the sessions claim returns ONE session, because the capability token already
// names it. While the loop only knew the runs claim, handing it a session id searched a list of
// runs for a session id, found nothing, and exited "clean" — the ask was never served and died
// unanswered at the give-up horizon.

interface AskRecorded {
  runClaims: number
  sessionClaims: number
  tools: { tool: string; args: unknown }[]
  creates: { body: string }[]
  answers: Record<string, unknown>[]
  patches: Record<string, unknown>[]
  manifestReads: string[]
}

const SESSION = {
  id: "ses_1",
  messages: [
    { id: "sm_1", author_kind: "asker", body_md: "how many signups last week?" },
    { id: "sm_2", author_kind: "agent", body_md: "About 400." },
    { id: "sm_3", author_kind: "asker", body_md: "and the week before?" },
  ],
}

/** A stub Derive serving ONE claimable session. */
const stubAskApi = (opts: {
  session?: unknown
  manifest?: string
  flags?: { agentKillswitch: boolean; agentAutoEnabled: boolean }
  tools?: { def: { name: string; description: string; params: Record<string, unknown> } }[]
}) => {
  const rec: AskRecorded = {
    runClaims: 0,
    sessionClaims: 0,
    tools: [],
    creates: [],
    answers: [],
    patches: [],
    manifestReads: [],
  }
  let server: Server
  const ready = new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => {
        body += c
      })
      req.on("end", () => {
        const url = req.url ?? ""
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { "content-type": "application/json" })
          res.end(JSON.stringify(obj))
        }
        if (url.endsWith("/runs/claim")) {
          rec.runClaims += 1
          return send(200, { runs: [] })
        }
        if (url.endsWith("/sessions/claim")) {
          rec.sessionClaims += 1
          return send(200, {
            session: opts.session === undefined ? SESSION : opts.session,
            context: {
              id: "cx_1",
              name: "Analytics",
              manifest_short_id: opts.manifest === undefined ? null : "man_1",
            },
            flags: opts.flags ?? { agentKillswitch: false, agentAutoEnabled: false },
            tools: opts.tools ?? [],
          })
        }
        if (url.includes("/model-credential"))
          return send(200, { credential: { kind: "api_key", value: "sk-stub" } })
        if (url.endsWith("/content")) {
          rec.manifestReads.push(url)
          res.writeHead(200, { "content-type": "text/markdown" })
          return res.end(opts.manifest ?? "")
        }
        if (url.endsWith("/tool")) {
          const parsed = JSON.parse(body || "{}")
          rec.tools.push({ tool: parsed.tool, args: parsed.args })
          return send(200, { result: { rows: 7 } })
        }
        if (url.endsWith("/messages")) {
          rec.answers.push(JSON.parse(body || "{}"))
          return send(201, { message: { id: "sm_out" } })
        }
        if (req.method === "PATCH") {
          rec.patches.push(JSON.parse(body || "{}"))
          return send(200, { session: { id: "ses_1", state: "failed" } })
        }
        // The only remaining write is creating the answer's page.
        rec.creates.push({ body })
        return send(201, { short_id: "art_new" })
      })
    })
    server.listen(0, () =>
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
    )
  })
  return {
    rec,
    url: ready,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** Serve one ask to completion. The `dksess_` prefix is the whole lane selector — the same
 *  discriminator the CLI runner uses — so this is also the assertion that a session token never
 *  reaches the run path. */
const askToSettle = async (
  server: string,
  rec: AskRecorded,
  callModel: Parameters<typeof loopSubstrate>[0]["callModel"],
) => {
  await loopSubstrate({ callModel }).start({
    runId: "ses_1",
    token: "dksess_stub",
    server,
  })
  const deadline = Date.now() + 10_000
  while (rec.answers.length === 0 && rec.patches.length === 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20))
  return rec.answers[0] ?? null
}

const answerTurn = (text: string) => async () => ({
  text,
  toolUses: [],
  costUsd: 0.001,
  done: true,
})

describe("loop substrate: an ask arrives through the SESSION claim", () => {
  it("never hands a session id to the runs claim — the silent no-op regression", async () => {
    // THE BUG. `/v1/agent/runs/claim` answers with a list the caller searches by id, so a session
    // id matched nothing and the substrate returned as though the work were already claimed. No
    // error, no settle, no answer: the ask simply sat there until the give-up horizon failed it.
    // A session must arrive through its own claim, which returns ONE session and no list at all.
    const api = stubAskApi({})
    const url = await api.url
    const ans = await askToSettle(url, api.rec, answerTurn("About 380 the week before."))
    expect(api.rec.sessionClaims).toBe(1)
    expect(api.rec.runClaims).toBe(0)
    expect(ans).not.toBeNull()
    await api.close()
  })

  it("answers in prose, names the asker message, and writes nothing", async () => {
    // An ask is the same turn where the model chose not to write. No block is the ANSWER, not a
    // contract miss, so nothing is nudged and nothing is published.
    const api = stubAskApi({})
    const url = await api.url
    const ans = await askToSettle(url, api.rec, answerTurn("About 380 the week before."))
    expect(ans?.body_md).toBe("About 380 the week before.")
    expect(ans?.state).toBe("answered")
    // `answers` is the LATEST ASKER message, not the last message: a follow-up that landed
    // mid-turn must keep the session open rather than be settled over unseen.
    expect(ans?.answers).toBe("sm_3")
    expect(api.rec.creates).toHaveLength(0)
    // Spend rides on the answer, as it does on an attended chat turn.
    expect((ans?.meta as { cost_micro_usd: number }).cost_micro_usd).toBe(1000)
    await api.close()
  })

  it("ESCALATES when the model says to, and still delivers the answer", async () => {
    const api = stubAskApi({})
    const url = await api.url
    const ans = await askToSettle(
      url,
      api.rec,
      answerTurn(
        `My best read is 380.\n<revision>${JSON.stringify({
          escalate: true,
          escalation_reason: "two sources disagree",
          caveats: ["one feed was stale"],
        })}</revision>`,
      ),
    )
    expect(ans?.state).toBe("escalated")
    expect(ans?.body_md).toBe("My best read is 380.")
    expect(ans?.meta).toMatchObject({
      escalation_reason: "two sources disagree",
      caveats: ["one feed was stale"],
    })
    await api.close()
  })

  it("publishes a page the answer produced and links it under the answer", async () => {
    const api = stubAskApi({ flags: { agentKillswitch: false, agentAutoEnabled: true } })
    const url = await api.url
    const ans = await askToSettle(
      url,
      api.rec,
      answerTurn(
        `Here is the chart.\n<revision>${JSON.stringify({
          content: "<!doctype html><h1>Signups</h1>",
          filename: "signups.html",
          confidence: 0.95,
          message: "signups chart",
        })}</revision>`,
      ),
    )
    expect(api.rec.creates).toHaveLength(1)
    expect(ans?.meta).toMatchObject({ artifacts: [{ short_id: "art_new" }] })
    // The PROSE is the answer. A one-line version note is for the history sidebar, and posting it
    // instead would replace the answer with "signups chart".
    expect(ans?.body_md).toBe("Here is the chart.")
    await api.close()
  })

  it("the KILLSWITCH files the page privately instead of putting it in front of everyone", async () => {
    // The gate binds the ask lane exactly as it binds a run. The flags come from the CLAIM, fresh
    // server-side, so a switch flipped a second ago is honoured on this very ask.
    const api = stubAskApi({ flags: { agentKillswitch: true, agentAutoEnabled: true } })
    const url = await api.url
    await askToSettle(
      url,
      api.rec,
      answerTurn(
        `Here it is.\n<revision>${JSON.stringify({
          content: "<!doctype html><h1>x</h1>",
          filename: "x.html",
          confidence: 1,
        })}</revision>`,
      ),
    )
    expect(api.rec.creates[0]?.body).toContain("workspace_access")
    await api.close()
  })

  it("REFUSES a page on disk out loud — this executor has no filesystem", async () => {
    // The CLI runner can publish a page the model wrote to a file because it has a disk. This
    // does not. Dropping the key would report a successful answer with the chart silently
    // missing, which reads as the model ignoring the request; the caveat says what happened and
    // what to do instead, and the prose answer still lands.
    const api = stubAskApi({})
    const url = await api.url
    const ans = await askToSettle(
      url,
      api.rec,
      answerTurn(
        `Chart attached.\n<revision>${JSON.stringify({
          artifact: { title: "Signups", path: "chart.html" },
        })}</revision>`,
      ),
    )
    expect(api.rec.creates).toHaveLength(0)
    expect(ans?.state).toBe("answered")
    expect(ans?.body_md).toBe("Chart attached.")
    expect(JSON.stringify(ans?.meta)).toContain("no filesystem")
    await api.close()
  })

  it("a failed turn SETTLES the session rather than leaving it open", async () => {
    // An unsettled ask is re-dispatched on every lease lapse, paying for a whole turn each round,
    // until the horizon fails it anyway. Failing it now costs one turn instead of several.
    const api = stubAskApi({})
    const url = await api.url
    await askToSettle(url, api.rec, async () => {
      throw new Error("429 slow down")
    })
    expect(api.rec.answers).toHaveLength(0)
    expect(api.rec.patches[0]).toEqual({ state: "failed" })
    await api.close()
  })

  it("a lost claim race is a clean exit, not a failure", async () => {
    const api = stubAskApi({ session: null })
    const url = await api.url
    await loopSubstrate({ callModel: answerTurn("hello") }).start({
      runId: "ses_1",
      token: "dksess_stub",
      server: url,
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(api.rec.sessionClaims).toBe(1)
    expect(api.rec.answers).toHaveLength(0)
    expect(api.rec.patches).toHaveLength(0)
    await api.close()
  })
})

describe("loop substrate: an ask is served AS ITS CONTEXT", () => {
  it("uses the context's manifest as the register, and proxies tools through the session", async () => {
    // A hosted answer must be the answer the context was written to give, not a generic one —
    // otherwise moving an ask onto this substrate silently changes what the agent knows.
    const api = stubAskApi({
      manifest: "---\nrepos:\n  - url: x\n---\nYou are the analytics desk. Cite the table.",
      tools: [{ def: { name: "warehouse.query", description: "SQL", params: {} } }],
    })
    const url = await api.url
    let seenSystem = ""
    let turn = 0
    await askToSettle(url, api.rec, async ({ system }) => {
      seenSystem = system
      turn += 1
      return turn === 1
        ? {
            text: "",
            toolUses: [{ id: "t1", name: "warehouse.query", input: { sql: "select 1" } }],
            costUsd: null,
            done: false,
          }
        : { text: "380.", toolUses: [], costUsd: null, done: true }
    })
    expect(seenSystem).toContain("You are the analytics desk")
    // Frontmatter is repo/skill pointers for an executor with a disk to materialize. This has
    // neither, so the BODY is the prompt and the pointers are not passed off as context.
    expect(seenSystem).not.toContain("repos:")
    // The ask contract, not the automation one: "you are not answering a person" would be a lie.
    expect(seenSystem).toContain("Someone ASKED you this")
    expect(api.rec.tools).toEqual([{ tool: "warehouse.query", args: { sql: "select 1" } }])
    await api.close()
  })
})
