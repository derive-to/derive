import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { afterAll, describe, expect, it } from "vitest"
// The REAL runner, imported straight from the CLI package (plain JS): the same executor that
// drains ask-sessions now drains automation runs. Only the model is scripted (a fake `claude`
// bin that calls the source shim and emits a <revision>); everything else is the live stack.
import { DeriveClient, serveRun } from "../../../packages/cli/src/runner.js"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The runner resolves the run initiator's model plan and fails closed with no plan + no ambient
// token. In this test there's no connected plan, so stand in an ambient token (the fake model
// ignores it anyway) — this is the self-host "single global plan" path.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "sk-ant-test-e2e"

// Agentic pull, end to end on the LIVE stack: an automation BOUND to a mock (LocalBroker) source,
// run-now, the runner claims it, the model pulls through the source shim (→ the tool endpoint →
// the broker, credentials staying server-side), and the runner writes the pulled data back as a
// new artifact version through the autonomy gate. The one thing faked is the model's reasoning.

const owner: TestUser = { id: "u_pull_e2e", email: "pulle2e@derive.test", name: "Owner" }
const { app } = makeAuthedApp("agentic-pull-e2e", [owner], "commenter", {
  deps: { encryptionKey: "test-encryption-key" },
})

// Serve the real app on an ephemeral port so the runner (and the shim child process) reach it
// over a real socket, exactly like production.
const server = serve({ fetch: app.fetch, port: 0 })
const base = await new Promise<string>((resolve) => {
  const check = () => {
    const addr = server.address()
    if (addr && typeof addr === "object") resolve(`http://localhost:${addr.port}`)
    else setTimeout(check, 10)
  }
  check()
})
afterAll(() => server.close())

const post = (path: string, body: object) => app.request(path, jsonAs(as(owner.email), body))
const publish = async (title: string, content: string) => {
  const res = await publishAs(app, content, { title }, as(owner.email))
  return (await res.json()) as { short_id: string }
}
const detail = async (shortId: string) =>
  (await (await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })).json()) as {
    current_version: number
    tags: string[]
  }
const content = async (shortId: string) =>
  await (await app.request(`/v1/artifacts/${shortId}/content`, { headers: as(owner.email) })).text()

// A fake `claude` bin: ignores its args, calls the source shim the runner dropped into cwd, and
// emits a <revision> whose body carries the pulled data — proving the shim → tool endpoint →
// broker round-trip actually happened.
const fakeClaudeBin = (cwd: string): string => {
  const bin = join(cwd, "fake-claude.cjs")
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { execSync } = require("node:child_process")
let pulled = "(none)"
try {
  pulled = execSync("node derive-source.mjs stripe.read '{\\"query\\":\\"mrr\\"}'", { encoding: "utf8" }).trim()
} catch (e) { pulled = "SHIM_ERROR: " + (e.stderr || e.message) }
const revision = {
  content: "# Revenue Snapshot\\n\\nMRR: fresh\\nSource echo: " + pulled + "\\nUpdated: today",
  filename: "notes.md",
  confidence: 0.95,
  message: "pulled MRR from source",
}
process.stdout.write(JSON.stringify({ type: "system", session_id: "fake_ses" }) + "\\n")
process.stdout.write(JSON.stringify({ type: "result", result: "<revision>" + JSON.stringify(revision) + "</revision>" }) + "\\n")
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

describe("agentic pull — a scheduled/triggered artifact pulls from a mock source and updates", () => {
  it("run-now → the runner pulls through the bound source and publishes a new version", async () => {
    // Opt the workspace into live agent publishing (still with a review round).
    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ agentAutoEnabled: true }),
    })

    // Connect a mock source (LocalBroker auto-authorizes) and publish the artifact to keep fresh.
    const conn = (await (await post("/v1/connections", { toolkit: "stripe" })).json()) as {
      id: string
    }
    const doc = await publish(
      "Revenue Snapshot",
      "# Revenue Snapshot\n\nMRR: unknown\nUpdated: never",
    )

    // An automation bound to that source, targeting the doc for a LIVE update. Omitting agentId
    // auto-mints a managed editor agent; its token (returned once) is what the runner claims with.
    const auto = (await (
      await post("/v1/automations", {
        trigger: { kind: "manual" },
        instruction: `Pull the current MRR from the source and refresh ${doc.short_id}.`,
        refs: [
          { kind: "artifact", id: doc.short_id, mode: "publish" },
          { kind: "tag", tag: "revenue" },
        ],
        connectionIds: [conn.id],
      })
    ).json()) as { id: string; agent_token: string }
    expect(auto.agent_token).toBeTruthy()

    // Fire it.
    const runRes = await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(runRes.status).toBe(201)

    // The runner: claim this agent's due runs, then execute each. serveRun spawns the fake model,
    // which calls the shim to pull from the source, then the runner writes the revision.
    const cwd = mkdtempSync(join(tmpdir(), "pull-e2e-"))
    const client = new DeriveClient(base, auto.agent_token)
    const runs = await client.claimRuns()
    expect(runs).toHaveLength(1)
    const claimed = runs[0]
    if (!claimed) throw new Error("expected exactly one claimed run")
    // Least-privilege: the claim carries exactly the bound source's tools.
    expect(claimed.tools.map((t) => t.def.name).sort()).toEqual(["stripe.read", "stripe.write"])

    await serveRun(client, claimed, "You are this workspace's automation agent.", {
      server: base,
      token: auto.agent_token,
      cwd,
      mock: false,
      providerName: "claude-code",
      agentBin: fakeClaudeBin(cwd),
      model: "sonnet",
      timeoutMs: 30_000,
    })

    // The artifact got a new LIVE version, stamped with the archive tag, carrying the pulled data.
    const after = await detail(doc.short_id)
    expect(after.current_version).toBe(2)
    expect(after.tags).toContain("revenue")
    const body = await content(doc.short_id)
    expect(body).toContain("MRR: fresh")
    // Proof the pull actually round-tripped through the broker (the LocalBroker echo).
    expect(body).toContain("stripe.read")
    expect(body).toContain('"provider":"local"')

    // The ledger tells the same story: one succeeded run that published.
    const ledger = (await (
      await app.request("/v1/workspace/runs", { headers: as(owner.email) })
    ).json()) as { runs: { status: string; meta: string | null }[] }
    const run = ledger.runs.find((r) => r.meta?.includes("published"))
    expect(run?.status).toBe("succeeded")

    // eslint-disable-next-line no-console
    console.log(`\n[e2e] pulled + published ${doc.short_id} v${after.current_version}:\n${body}\n`)
  })
})

describe("scenario 2 — the QA context: an automation that runs WITH its methodology", () => {
  it("a context-bound run materializes the manifest into the executor's system prompt", async () => {
    // The QA methodology is an ordinary artifact...
    const methodology = await publish(
      "QA Methodology",
      "# QA Methodology\n\nAlways check the health endpoint first. Grade PASS or FAIL. UNIQUE-MARKER-7391.",
    )
    // ...a context packages it (the agent auto-mints, #525)...
    const ctxRes = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), { name: "QA Runner", manifest_short_id: methodology.short_id }),
    )
    expect(ctxRes.status).toBe(201)
    const ctx = (await ctxRes.json()) as { id: string; agent_token: string }

    // ...and the automation binds it: no agentId passed, so it runs AS the context's agent.
    const report = await publish("QA Report", "# QA Report\n\nStatus: never run")
    const auto = (await (
      await post("/v1/automations", {
        trigger: { kind: "manual" },
        instruction: `Run the QA checks and update ${report.short_id}.`,
        refs: [{ kind: "artifact", id: report.short_id, mode: "publish" }],
        contextId: ctx.id,
      })
    ).json()) as { id: string; context_id: string; agent_token?: string }
    expect(auto.context_id).toBe(ctx.id)
    // The context's agent acts — no second agent was minted for the automation.
    expect(auto.agent_token).toBeUndefined()

    await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })

    // The claim carries the context, and serveRun materializes it: prove the methodology text
    // reached the MODEL by having the fake executor echo its own --append-system-prompt arg.
    const cwd = mkdtempSync(join(tmpdir(), "qa-ctx-"))
    const bin = join(cwd, "fake-claude.cjs")
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const i = process.argv.indexOf("--append-system-prompt")
const sys = i >= 0 ? process.argv[i + 1] : "(none)"
const marker = sys.includes("UNIQUE-MARKER-7391") ? "METHODOLOGY-PRESENT" : "METHODOLOGY-MISSING"
const revision = { content: "# QA Report\\n\\nStatus: PASS (" + marker + ")", filename: "notes.md", confidence: 0.9, message: "qa run" }
process.stdout.write(JSON.stringify({ type: "system", session_id: "fake" }) + "\\n")
process.stdout.write(JSON.stringify({ type: "result", result: "<revision>" + JSON.stringify(revision) + "</revision>" }) + "\\n")
`,
    )
    chmodSync(bin, 0o755)
    // Drive the REAL hosted entry (runOnce): it claims, resolves the bound context through
    // bootHost (manifest + skills over the live socket, as the context's own agent), and runs.
    const { runOnce } = (await import("../../../packages/cli/src/runner.js")) as unknown as {
      runOnce: (cfg: Record<string, unknown>) => Promise<{ served: number; failed: number }>
    }
    const counts = await runOnce({
      server: base,
      token: ctx.agent_token,
      cwd,
      mock: false,
      providerName: "claude-code",
      agentBin: bin,
      model: "sonnet",
      timeoutMs: 30_000,
    })
    expect(counts).toMatchObject({ served: 1, failed: 0 })

    const body = await content(report.short_id)
    expect(body).toContain("Status: PASS")
    // The load-bearing assertion: the context's manifest text reached the MODEL's system
    // prompt. This is what makes the automation a scheduled use(context, instruction) rather
    // than a bare job that happens to share an agent.
    expect(body).toContain("METHODOLOGY-PRESENT")
  })
})
