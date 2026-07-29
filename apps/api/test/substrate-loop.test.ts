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
