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
  /** What the substrate actually uploaded. `name` is the one that MATTERS: publish.ts derives
   *  the stored content type from the filename EXTENSION and ignores the part's MIME type, so a
   *  test that only checks `type` passes while the artifact still flips to HTML. Both are
   *  recorded so the assertion is on the field the server reads. */
  writes: { path: string; type: string | null; name: string | null }[]
  finishes: Record<string, unknown>[]
  /** Artifact content GETs — the run lane must read its target before revising it. */
  reads: string[]
  /** GETs of the artifact RECORD. Should stay EMPTY: the document's type rides a header on
   *  the content read, so wanting it must not cost a second request. */
  recordReads: string[]
  /** Every `/v1/agent/model-credential` query the substrate made, in order. WHICH PROVIDER it
   *  asks about, and whether it asks a second time, is behaviour under test. */
  credentialQueries: string[]
}

/** What `/v1/agent/model-credential` hands back for one provider. `null` = nothing connected. */
type StubCredential = { kind: string; value: string } | null

/** A stub Derive: serves one claimable run, echoes tools, and records what the substrate did. */
const stubApi = (opts: {
  run: Record<string, unknown>
  /** Status for artifact writes — 403 exercises the refused-write path. */
  writeStatus?: number
  toolStatus?: number
  /** The target artifact's current source, as GET /v1/artifacts/:id/content serves it. A
   *  published artifact always HAS content, so the default is some — `""` is the deliberately
   *  broken case (a 200 with an empty body) and is exercised on its own below. */
  content?: string
  /** Status for that read — 404/500 exercises the unreadable-target path. */
  contentStatus?: number
  /** What the artifact RECORD reports as its stored type (the thing a revision must preserve). */
  artifactContentType?: string
  /** Per-provider credentials. Default: a claude-code api key, which is what every pre-existing
   *  test in this file implicitly assumed while injecting `callModel` over the top of it. */
  credentials?: Record<string, StubCredential>
  /** `reason` on an absent credential — "unreadable" vs nothing connected. */
  credentialReason?: string
}) => {
  const rec: Recorded = {
    claims: 0,
    tools: [],
    writes: [],
    finishes: [],
    reads: [],
    recordReads: [],
    credentialQueries: [],
  }
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
          rec.credentialQueries.push(url)
          const provider = new URL(url, "http://x").searchParams.get("provider") ?? ""
          const table = opts.credentials ?? { "claude-code": { kind: "api_key", value: "sk-stub" } }
          const credential = table[provider] ?? null
          return send(
            200,
            credential ? { credential } : { credential: null, reason: opts.credentialReason },
          )
        }
        if (url.endsWith("/tool")) {
          const parsed = JSON.parse(body || "{}")
          rec.tools.push({ tool: parsed.tool, args: parsed.args })
          if (opts.toolStatus && opts.toolStatus !== 200)
            return send(opts.toolStatus, { error: "tool refused" })
          return send(200, { result: { rows: 3, echo: parsed.args } })
        }
        // The target's current source. GET only: a POST to an artifact path is a WRITE.
        if (url.includes("/content") && req.method === "GET") {
          rec.reads.push(url)
          const status = opts.contentStatus ?? 200
          if (status >= 400) return send(status, { error: "nope" })
          // AS PRODUCTION SERVES IT. `Content-Type` is text/plain for EVERY artifact so the
          // bytes render as text instead of executing in a browser — it is the transport's, not
          // the document's. The DOCUMENT's type rides X-Derive-Content-Type alongside the other
          // X-Derive-* headers the route already emits. This stub used to answer text/markdown
          // on Content-Type, which made a fix that read the wrong header look correct here while
          // doing nothing at all in production.
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "x-derive-content-type": opts.artifactContentType ?? "text/markdown",
          })
          return res.end(opts.content ?? "# Roadmap\n\n## Now\nShip the thing.\n")
        }
        // A read of the artifact RECORD. Recorded so a test can assert the loop does NOT need
        // one: the type comes back on the content read, which the run already makes.
        if (/\/v1\/artifacts\/[^/]+$/.test(url) && req.method === "GET") {
          rec.recordReads.push(url)
          return send(200, {
            short_id: "art_1",
            current_content_type: opts.artifactContentType ?? "text/markdown",
            current_version: 1,
          })
        }
        if (url.endsWith("/finish")) {
          rec.finishes.push(JSON.parse(body || "{}"))
          return send(200, { ok: true })
        }
        // Artifact writes: proposals, versions, create.
        // Pull the file part's Content-Type straight out of the multipart body.
        const part = /name="file"; filename="([^"]*)"[\s\S]*?Content-Type:\s*([^\r\n]+)/i.exec(body)
        rec.writes.push({
          path: url,
          name: part?.[1] ?? null,
          type: part?.[2]?.trim() ?? null,
        })
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

describe("loop substrate: the run SEES the document it is revising", () => {
  // THE REGRESSION. A live run against a real artifact produced a wholly invented document —
  // three runs of one automation, three unrelated results, fabricated figures, and an instruction
  // ("keep every existing section unchanged") that was unsatisfiable because the model had never
  // been shown the document. The contract still demanded "the complete new artifact source", so
  // the model wrote a plausible one from nothing. At mode=publish that silently destroys the doc.
  //
  // The container executor had always read the target first. This is the loop substrate being
  // held to the same behaviour.

  const EXISTING = "# Roadmap\n\n## Q3\nShip the thing.\n\n## Q4\nShip the other thing.\n"

  it("puts the target's CURRENT SOURCE in the prompt, so a preserve instruction can be obeyed", async () => {
    const api = stubApi({
      run: { ...baseRun, instruction: "Add a Q5 section. Keep every existing section unchanged." },
      content: EXISTING,
    })
    const url = await api.url
    let system = ""
    // The model here does what a real one can only do when it HAS the document: echo it back with
    // the addition. Without the fix the prompt contains no document, this assertion on `system`
    // fails, and the "revision preserves the original" assertion fails with it.
    const fin = await runToSettle(url, api.rec, async (input) => {
      system = input.system
      const kept = system.includes("## Q4") ? EXISTING : "# Something Else Entirely\n"
      return {
        text: revision(`${kept}\n## Q5\nShip more.\n`),
        toolUses: [],
        costUsd: null,
        done: true,
      }
    })
    // It READ the target, over HTTP, before asking the model anything.
    expect(api.rec.reads).toContain("/v1/artifacts/art_1/content")
    // And the document reached the prompt, delimited and whole.
    expect(system).toContain("--- BEGIN DOCUMENT ---")
    expect(system).toContain("## Q3")
    expect(system).toContain("## Q4")
    expect(fin?.status).toBe("succeeded")
  })

  it("a run with NO artifact target reads nothing — it is creating, not revising", async () => {
    const api = stubApi({ run: { ...baseRun, targets: [] }, content: EXISTING })
    const url = await api.url
    let system = ""
    const fin = await runToSettle(url, api.rec, async (input) => {
      system = input.system
      return { text: revision(), toolUses: [], costUsd: null, done: true }
    })
    expect(api.rec.reads).toEqual([])
    expect(system).not.toContain("--- BEGIN DOCUMENT ---")
    expect(fin?.status).toBe("succeeded")
    await api.close()
  })

  it("an UNREADABLE target fails the run rather than letting the model invent one", async () => {
    // The whole point. "No document" and "a document I was not shown" look identical to a model,
    // so proceeding on a failed read reproduces the bug exactly. Retryable, because a 5xx is
    // transient and the alternative is a fabricated document in somebody's version history.
    const api = stubApi({ run: baseRun, contentStatus: 500 })
    const url = await api.url
    let called = false
    const fin = await runToSettle(url, api.rec, async () => {
      called = true
      return { text: revision(), toolUses: [], costUsd: null, done: true }
    })
    expect(called).toBe(false)
    expect(api.rec.writes).toEqual([])
    expect(fin?.status).toBe("failed")
    expect(fin?.meta).toMatchObject({ retryable: true })
    await api.close()
  })

  it("an EMPTY body is unreadable too — a 200 with nothing in it is not a document", async () => {
    // The same bug arrived at from the other direction. A 200 with an empty body took the
    // success path, and `""` then flowed in as the document: the model was told to keep every
    // existing section of a document with no sections, and produced a fabricated one. There is
    // no legitimate empty published artifact (current_version === 0 is filtered upstream), so
    // an empty read is a read that did not work — fail closed, retryable, same as a 500.
    const api = stubApi({ run: baseRun, content: "   \n" })
    const url = await api.url
    let called = false
    const fin = await runToSettle(url, api.rec, async () => {
      called = true
      return { text: revision(), toolUses: [], costUsd: null, done: true }
    })
    expect(called).toBe(false)
    expect(api.rec.writes).toEqual([])
    expect(fin?.status).toBe("failed")
    expect(fin?.meta).toMatchObject({ retryable: true })
    await api.close()
  })

  it("a LARGE document switches the ask to search/replace edits", async () => {
    // Past EDITS_THRESHOLD_CHARS a whole-document reply cannot fit in the output budget, so the
    // contract changes shape — the same switch attended chat makes, from the same helper. Without
    // it a run against a big artifact hits the token ceiling and truncates mid-document.
    const big = `# Big\n\n${"filler paragraph. ".repeat(1200)}\n## Keep Me\nimportant\n`
    expect(big.length).toBeGreaterThan(12_000)
    const api = stubApi({ run: baseRun, content: big })
    const url = await api.url
    let system = ""
    await runToSettle(url, api.rec, async (input) => {
      system = input.system
      return {
        text: `<edits>${JSON.stringify({ edits: [], confidence: 0.9 })}</edits>`,
        toolUses: [],
        costUsd: null,
        done: true,
      }
    })
    expect(system).toContain("<edits>")
    expect(system).not.toContain("<revision>")
    await api.close()
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
  it("a tool call is proxied, not made directly — so least-privilege still applies", async () => {
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

// ---- THE CREDENTIAL PATH -----------------------------------------------------------------------
//
// Every test above this line injects `callModel`, which short-circuits `resolveModel` entirely —
// so the whole of "which provider, which credential kind, which model id" shipped with no test at
// all, and shipped broken three separate ways: an `oauth` plan token (the DEFAULT choice in the
// connect UI) was sent as `x-api-key`, the ANTHROPIC model id was fed the GATEWAY's model id, and
// the provider was hardcoded while the payer preflight is provider-agnostic. Each of those is
// 100% of hosted runs on some deployment, not an edge case.
//
// These tests therefore inject NOTHING. The substrate resolves a real credential from the stub
// API and builds a real Anthropic client; only `globalThis.fetch` is intercepted, and only for
// api.anthropic.com — every Derive call still goes over the loopback server, as before. That is
// the smallest possible seam: anything less and the code under test is the mock again.

interface ModelCall {
  headers: Record<string, string>
  body: { model?: string; max_tokens?: number }
}

/** Intercept api.anthropic.com; delegate everything else to the real fetch. Returns the
 *  recorded calls and a restore function. */
const interceptAnthropic = (reply?: unknown) => {
  const calls: ModelCall[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!href.startsWith("https://api.anthropic.com")) return real(input as RequestInfo, init)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    calls.push({ headers, body: JSON.parse(String(init?.body ?? "{}")) })
    return new Response(
      JSON.stringify(
        reply ?? {
          content: [{ type: "text", text: revision() }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1_000, output_tokens: 500 },
        },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  const restore = () => {
    globalThis.fetch = real
  }
  return { calls, restore }
}

/** Drive one run with NO injected model, and hand back what the model call looked like. */
const runWithRealCredential = async (
  stub: ReturnType<typeof stubApi>,
  opts: { model?: string } = {},
  reply?: unknown,
) => {
  const url = await stub.url
  const probe = interceptAnthropic(reply)
  try {
    await loopSubstrate(opts).start({ runId: "run_1", token: "tok", server: url })
    const deadline = Date.now() + 10_000
    while (stub.rec.finishes.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20))
  } finally {
    probe.restore()
  }
  return { calls: probe.calls, finish: stub.rec.finishes[0] ?? null }
}

describe("loop substrate: resolving the model credential", () => {
  it("sends an OAUTH plan token as a bearer, with the oauth beta — never as x-api-key", async () => {
    // The bug this exists for. `oauth` is a `claude setup-token` plan token and the DEFAULT
    // option in the connect UI (apps/web settings/model-plan-manager.tsx); it was sent as
    // `x-api-key`, which 401s. The CLI runner has always mapped kind → CLAUDE_CODE_OAUTH_TOKEN;
    // this is that mapping on the wire.
    const api = stubApi({
      run: { ...baseRun, targets: [] },
      credentials: { "claude-code": { kind: "oauth", value: "sk-ant-oat01-plan" } },
    })
    const { calls, finish } = await runWithRealCredential(api)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-ant-oat01-plan")
    expect(calls[0]?.headers["anthropic-beta"]).toBe("oauth-2025-04-20")
    expect(calls[0]?.headers["x-api-key"]).toBeUndefined()
    // And it actually completed — the point is a working run, not merely a well-formed header.
    expect(finish?.status).toBe("succeeded")
    await api.close()
  })

  it("sends an API KEY as x-api-key, with no bearer", async () => {
    const api = stubApi({
      run: { ...baseRun, targets: [] },
      credentials: { "claude-code": { kind: "api_key", value: "sk-ant-api03-key" } },
    })
    const { calls, finish } = await runWithRealCredential(api)
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-ant-api03-key")
    expect(calls[0]?.headers.authorization).toBeUndefined()
    expect(calls[0]?.headers["anthropic-beta"]).toBeUndefined()
    expect(finish?.status).toBe("succeeded")
    await api.close()
  })

  it("asks for claude-code and sends an ANTHROPIC model id, not the gateway's", async () => {
    // DERIVE_MODEL_NAME is the gateway's model id (`accounts/fireworks/models/...`) and used to
    // arrive here as the Anthropic model id, which 404s `model_not_found` on every hosted run of
    // every deploy that had configured chat. Unset must fall back to a real Anthropic id.
    const api = stubApi({ run: { ...baseRun, targets: [] } })
    const { calls } = await runWithRealCredential(api)
    expect(api.rec.credentialQueries[0]).toContain("provider=claude-code")
    expect(api.rec.credentialQueries[0]).toContain("run=run_1")
    expect(calls[0]?.body.model).toBe("claude-sonnet-5")
    expect(calls[0]?.body.model).not.toMatch(/fireworks|\//)
    await api.close()
  })

  it("honours an explicit model override", async () => {
    const api = stubApi({ run: { ...baseRun, targets: [] } })
    const { calls } = await runWithRealCredential(api, { model: "claude-opus-4-8" })
    expect(calls[0]?.body.model).toBe("claude-opus-4-8")
    await api.close()
  })

  it("prices the turn from the reported usage, so the budget has something to sum", async () => {
    // `costOf` was `() => null` unconditionally, so sumRunCostSince summed zero and overBudget
    // returned false for every workspace on every check. 1M in + 0.5M out on Sonnet 5 is
    // 1×$3 + 0.5×$15 = $10.50 → 10,500,000 micro-USD, reported on the settle.
    const api = stubApi({ run: { ...baseRun, targets: [] } })
    const { finish } = await runWithRealCredential(
      api,
      {},
      {
        content: [{ type: "text", text: revision() }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
      },
    )
    expect(finish?.cost_micro_usd).toBe(10_500_000)
    await api.close()
  })

  it("reports UNKNOWN rather than zero for a model it cannot price", async () => {
    // Null for THAT model only. "Cost nothing" and "never found out" are different facts and
    // only one of them belongs in a sum.
    const api = stubApi({ run: { ...baseRun, targets: [] } })
    const { finish } = await runWithRealCredential(
      api,
      { model: "some-private-deployment" },
      {
        content: [{ type: "text", text: revision() }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
      },
    )
    expect(finish?.cost_micro_usd).toBeNull()
    await api.close()
  })

  it("fails LOUDLY on a Codex-only workspace instead of misrouting it to Anthropic", async () => {
    // The payer preflight is provider-agnostic — it asks "can anything pay", not "with what" —
    // so a Codex-only workspace passes it, queues runs, and could never execute them. The old
    // code asked only about claude-code and reported "no model plan connected", which its owner
    // could only read as a lie: they had connected one.
    const api = stubApi({
      run: { ...baseRun, targets: [] },
      credentials: { codex: { kind: "api_key", value: "sk-openai" } },
    })
    const { calls, finish } = await runWithRealCredential(api)
    expect(calls).toHaveLength(0) // nothing was sent to Anthropic
    expect(api.rec.credentialQueries.map((q) => q.includes("provider=codex"))).toContain(true)
    expect(finish?.status).toBe("failed")
    const meta = finish?.meta as { why: string; retryable: boolean }
    expect(meta.why).toContain("Codex")
    expect(meta.why).toContain("derive runner")
    expect(meta.retryable).toBe(false)
    await api.close()
  })

  it("fails loudly on a credential kind it cannot send", async () => {
    // `login` is Codex's rotating auth.json blob and needs a filesystem. Anything unrecognized
    // gets the same treatment: guessing produces a 401 dressed up as a model error.
    const api = stubApi({
      run: { ...baseRun, targets: [] },
      credentials: { "claude-code": { kind: "login", value: "{}" } },
    })
    const { calls, finish } = await runWithRealCredential(api)
    expect(calls).toHaveLength(0)
    expect(finish?.status).toBe("failed")
    expect((finish?.meta as { why: string }).why).toContain('"login"')
    await api.close()
  })

  it("still distinguishes an unreadable plan from no plan at all", async () => {
    const api = stubApi({
      run: { ...baseRun, targets: [] },
      credentials: {},
      credentialReason: "unreadable",
    })
    const { finish } = await runWithRealCredential(api)
    expect((finish?.meta as { why: string }).why).toContain("reconnect")
    await api.close()
  })

  it("says nothing is connected when nothing is, for any provider", async () => {
    const api = stubApi({ run: { ...baseRun, targets: [] }, credentials: {} })
    const { finish } = await runWithRealCredential(api)
    expect((finish?.meta as { why: string }).why).toContain("no model plan connected")
    await api.close()
  })
})

describe("how the loop REACHES the API", () => {
  // THE REGRESSION. This substrate is an HTTP client of its own deployment. On Node that is a
  // loopback call and global fetch is right; on Workers it exits the isolate, crosses the edge
  // and comes back to the SAME Worker. One run survived that. The cron tick starting three at
  // once did not: every self-subrequest sat until it timed out, so each scheduled run died on
  // `/v1/agent/runs/claim failed (522)` while a run booted from the queue nudge succeeded —
  // which is exactly the shape that makes it look like the schedule lane is broken.
  //
  // Guarded by making global fetch a landmine: if anything in the loop stops honouring
  // `fetchImpl`, the run cannot complete.
  it("uses the injected transport for EVERY call, never global fetch", async () => {
    const api = stubApi({ run: baseRun })
    const url = await api.url
    const realFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async () => {
      throw new Error("global fetch used: on Workers this is a self-subrequest and times out")
    }) as typeof fetch
    try {
      await loopSubstrate({
        callModel: answerTurn(revision()),
        fetchImpl: (req) => {
          seen.push(new URL(req.url).pathname)
          return realFetch(req)
        },
      }).start({ runId: "run_1", token: "tok", server: url })

      const deadline = Date.now() + 10_000
      while (api.rec.finishes.length === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20))

      // It ran to completion without global fetch ever being reachable...
      expect(api.rec.finishes).toHaveLength(1)
      // ...and the claim in particular — the call that 522'd in production — went through the
      // injected transport.
      expect(seen).toContain("/v1/agent/runs/claim")
      expect(seen.length).toBeGreaterThan(1)
    } finally {
      globalThis.fetch = realFetch
      await api.close()
    }
  })

  it("falls back to global fetch when no transport is injected — Node keeps working", async () => {
    const api = stubApi({ run: baseRun })
    const url = await api.url
    try {
      const settled = await runToSettle(url, api.rec, answerTurn(revision()))
      expect(settled).toBeTruthy()
    } finally {
      await api.close()
    }
  })
})

describe("the revised document KEEPS its own format", () => {
  // THE REGRESSION, and the third lane to need the same fix. Attended chat already learned this
  // (lib/session-turn.ts): deriving the content type from the model's filename converts a
  // Markdown document to HTML the moment the model omits or mangles the name, because the edits
  // contract falls back to `index.html` — correct when CREATING an artifact, wrong when REVISING
  // one. Observed on production, same document, same approval flow:
  //
  //     v1  text/markdown   upload
  //     v2  text/markdown   chat edit          (already fixed)
  //     v3  text/html       automation run     (this)
  //
  // At v3 the document stops rendering as markdown and reads as one unformatted blob, and
  // nothing reports an error.
  it("writes text/markdown for a markdown target even when the model says index.html", async () => {
    const api = stubApi({ run: baseRun, content: "# Roadmap\n\n## Now\nShip it.\n" })
    const url = await api.url
    try {
      // `filename: "index.html"` is exactly what the edits contract falls back to.
      const settled = await runToSettle(
        url,
        api.rec,
        answerTurn(
          `<revision>${JSON.stringify({
            content: "# Roadmap\n\n## Now\nShip it.\n\n## Status\nReviewed.\n",
            filename: "index.html",
            confidence: 0.95,
            message: "m",
          })}</revision>`,
        ),
      )
      expect(settled).toBeTruthy()
      expect(api.rec.writes.length).toBeGreaterThan(0)
      // The target was served as text/markdown, so the revision must be written as markdown.
      // The FILENAME is the assertion that matters — publish.ts reads the extension and ignores
      // the part's MIME type, so checking only `type` would pass with the bug still present.
      for (const w of api.rec.writes) {
        expect(w.name).toMatch(/\.md$/i)
        expect(w.type).toBe("text/markdown")
      }
    } finally {
      await api.close()
    }
  })

  it("still honours the filename when CREATING, where there is no document to keep", async () => {
    // No artifact target: nothing to preserve, so the model's filename is the only signal.
    const api = stubApi({ run: { ...baseRun, targets: [] } })
    const url = await api.url
    try {
      const settled = await runToSettle(
        url,
        api.rec,
        answerTurn(
          `<revision>${JSON.stringify({
            content: "<h1>New</h1>",
            filename: "index.html",
            confidence: 0.95,
            message: "m",
          })}</revision>`,
        ),
      )
      expect(settled).toBeTruthy()
      for (const w of api.rec.writes) {
        expect(w.name).toBe("index.html")
        expect(w.type).toBe("text/html")
      }
    } finally {
      await api.close()
    }
  })
})

describe("what filename the model is SHOWN", () => {
  // The upstream half of the content-type bug. Both lanes passed a bare short_id, so the prompt
  // said "its filename is art_1" — no extension, no format signal. Asked to name its output the
  // model guessed, and the edits contract's fallback made that guess index.html. That is why the
  // flip was intermittent rather than constant: it depended on what the model felt like naming.
  //
  // Correcting the type on the way out (landOverHttp) is not a substitute. A model that believes
  // it is editing an extensionless file will also write HTML into a Markdown document's BODY,
  // and no amount of re-stamping the content type afterwards undoes that.
  it("tells the model a markdown target's name ends in .md", async () => {
    const api = stubApi({ run: baseRun, content: "# Roadmap\n\n## Now\nShip it.\n" })
    const url = await api.url
    let systemSeen = ""
    try {
      await runToSettle(url, api.rec, async (input) => {
        systemSeen = input.system ?? ""
        return { text: revision(), toolUses: [], costUsd: 0.001, done: true }
      })
      expect(systemSeen).toContain("its filename is art_1.md")
      expect(systemSeen).not.toContain("its filename is art_1\n")
    } finally {
      await api.close()
    }
  })
})

describe("what the run READS to learn the document's format", () => {
  // The type is needed to preserve it on the write. The first working version of that fix
  // fetched the artifact RECORD for it — a whole extra request per run, re-running auth and
  // re-reading a row the content route already had in hand and used six lines later. It also
  // answered with the artifact's CURRENT type, which is the wrong answer for a `?v=N` read.
  //
  // It rides X-Derive-Content-Type on the content read instead, next to the X-Derive-* headers
  // that route already emits. This pins that it stays free.
  it("learns it from the content read, without a second request", async () => {
    const api = stubApi({ run: baseRun, artifactContentType: "text/markdown" })
    const url = await api.url
    try {
      const settled = await runToSettle(
        url,
        api.rec,
        answerTurn(
          `<revision>${JSON.stringify({
            content: "# Roadmap\n\n## Now\nShip it.\n\n## Status\nDone.\n",
            filename: "index.html",
            confidence: 0.95,
            message: "m",
          })}</revision>`,
        ),
      )
      expect(settled).toBeTruthy()
      // It read the content exactly once...
      expect(api.rec.reads.length).toBe(1)
      // ...never asked for the record...
      expect(api.rec.recordReads).toEqual([])
      // ...and still preserved the format.
      for (const w of api.rec.writes) expect(w.name).toMatch(/\.md$/i)
    } finally {
      await api.close()
    }
  })
})
