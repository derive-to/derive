import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { afterAll, describe, expect, it } from "vitest"
import { dispatchPass } from "../src/lib/dispatch"
import { nodeSubstrate } from "../src/lib/substrate-node"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

/**
 * THE NODE SUBSTRATE, FOR REAL. No fake substrate, no in-process shortcut.
 *
 * Every other hosted-dispatch test swaps in a substrate that records what it was asked to boot,
 * which is right for testing the dispatch logic and proves nothing about the part that actually
 * runs on someone's box: `spawn`. This one uses the REAL nodeSubstrate to launch the REAL derive
 * CLI as a child process, which claims its run over a real socket with its capability token,
 * writes a revision, and settles — the full loop, out-of-process.
 *
 * The one thing faked is the model: a script standing in for the coding agent, so the test is
 * deterministic and free. Everything around it — the spawn, the child's ENVIRONMENT, the token,
 * the HTTP claim, the published write — is the production path.
 *
 * This exists because of a specific near-miss. The child's environment is built by allowlist
 * (see substrate-node.ts), and the first version of that allowlist omitted AGENT_BIN/CLAUDE_BIN
 * — the variables the runner resolves its agent through. Nothing failed loudly: the runner would
 * simply fall back to `claude` on PATH. No unit test covered it because no unit test spawns
 * anything. This one does, and it passes only if the child can actually find its agent.
 */

const SECRET = "node-substrate-live-secret-16"
const owner: TestUser = { id: "u_nsl", email: "nsl@derive.test", name: "Owner" }
const { app, meta } = makeAuthedApp("node-substrate-live", [owner], "commenter", {
  deps: { encryptionKey: SECRET },
})

// A real socket: the child is a separate process and reaches the API over the network, exactly
// as a container or a box would.
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

/** A stand-in for the coding agent: emits the stream-json a real one would, with a revision. */
const fakeAgent = (dir: string): string => {
  const bin = join(dir, "fake-agent.cjs")
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const revision = {
  content: "# Weekly Numbers\\n\\nRefreshed by a hosted run.\\n",
  filename: "numbers.md",
  confidence: 0.95,
  message: "hosted refresh",
}
process.stdout.write(JSON.stringify({ type: "system", session_id: "live" }) + "\\n")
process.stdout.write(
  JSON.stringify({ type: "result", result: "<revision>" + JSON.stringify(revision) + "</revision>" }) + "\\n",
)
`,
    { mode: 0o755 },
  )
  return bin
}

describe("hosted run on the node substrate — a real child process", () => {
  it("spawns the CLI, which claims its run, writes a version, and settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nsl-"))

    // Configure the child THROUGH THE ENVIRONMENT — which is the point. These are exactly the
    // variables a self-host sets, and they only reach the child if the substrate's allowlist
    // passes them. AGENT_BIN in particular was missing from the first version of that list, and
    // its absence is silent: the runner falls back to `claude` on PATH.
    const prior = { ...process.env }
    process.env.AGENT_BIN = fakeAgent(cwd)
    process.env.RUNNER_PROVIDER = "claude-code"
    process.env.RUNNER_CWD = cwd
    process.env.RUNNER_TIMEOUT_MS = "45000"

    // A plan, because resolveModelEnv fails closed — a run resolves its initiator's plan or
    // does not start. Same one-time step a person does before their first automation.
    await app.request(
      "/v1/me/model-credentials",
      jsonAs(as(owner.email), {
        provider: "claude-code",
        kind: "api_key",
        token: "live-e2e-plan", // gitleaks:allow — a fixture string, never a real credential
      }),
    )

    const doc = (await (
      await publishAs(app, "# Weekly Numbers\n\nStale.\n", { title: "Numbers" }, as(owner.email))
    ).json()) as { short_id: string; id: string }

    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          trigger: { kind: "manual" },
          instruction: "Refresh the weekly numbers.",
          refs: [{ kind: "artifact", id: doc.short_id, mode: "publish" }],
        }),
      )
    ).json()) as { id: string }

    const run = (await (
      await app.request(`/v1/automations/${auto.id}/run`, {
        method: "POST",
        headers: as(owner.email),
      })
    ).json()) as { id: string }

    // THE REAL SUBSTRATE. The CLI is spawned as a detached child; its only credential is the
    // capability token dispatch mints, delivered through the environment this substrate builds.
    const res = await dispatchPass({
      meta,
      substrate: nodeSubstrate({
        bin: join(process.cwd(), "../../packages/cli/bin/derive.js"),
        timeoutMs: 60_000,
      }),
      server: base,
      secret: SECRET,
    })
    expect(res.started).toBe(1)

    // Wait for the child to finish the loop. Polling the run's own state rather than sleeping a
    // fixed amount, so this is as fast as the machine allows and still deterministic.
    const deadline = Date.now() + 60_000
    let settled = await meta.getRun(run.id)
    while (
      Date.now() < deadline &&
      settled?.status !== "succeeded" &&
      settled?.status !== "failed"
    ) {
      await new Promise((r) => setTimeout(r, 250))
      settled = await meta.getRun(run.id)
    }

    // The whole point: a real out-of-process run moved a real artifact forward.
    expect(settled?.status, `run did not settle. meta=${settled?.meta}`).toBe("succeeded")
    const after = (await (
      await app.request(`/v1/artifacts/${doc.short_id}`, { headers: as(owner.email) })
    ).json()) as { current_version: number }
    expect(after.current_version).toBe(2)

    process.env = prior
  }, 90_000)
})
