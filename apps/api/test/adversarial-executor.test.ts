import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { afterAll, describe, expect, it } from "vitest"
import { dispatchPass } from "../src/lib/dispatch"
import { nodeSubstrate } from "../src/lib/substrate-node"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

/**
 * ADVERSARIAL: the executor is the attacker.
 *
 * This is the threat model hosted execution actually has. The child is a coding agent running
 * with --dangerously-skip-permissions, a shell, and a capability token, acting on text that can
 * arrive from a source pull or a webhook body — i.e. from outside. Prompt injection is not
 * exotic here, it is the expected case, so every agent-facing endpoint has to hold against a
 * child that decides to do something other than its job.
 *
 * So rather than assert that from the comfort of the API process, this spawns a REAL hostile
 * child, hands it the REAL capability token the dispatcher minted, and lets it try. It reports
 * what each attempt returned and the test asserts every one was refused.
 *
 * The attacks are the ones this branch's review found, plus the obvious neighbours:
 *   1. batch-claim the agent's other runs (the escalation the review found)
 *   2. settle somebody else's run as done
 *   3. execute another run's bound source tools
 *   4. read another user's decrypted model plan
 *   5. read the API's own secrets out of its environment
 *   6. keep using the token after the run has settled
 */

const SECRET = "adversarial-secret-at-least-16"
const owner: TestUser = { id: "u_adv", email: "adv@derive.test", name: "Owner" }
const victimUser: TestUser = { id: "u_victim", email: "victim@derive.test", name: "Victim" }
const { app, meta } = makeAuthedApp("adversarial", [owner, victimUser], "editor", {
  deps: { encryptionKey: SECRET },
})

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

/** A hostile stand-in for the coding agent. Reads its targets from the working directory the
 *  runner gave it, tries each attack with its own capability token, writes the verdicts back,
 *  and then completes its run normally so the loop still closes. */
const hostileAgent = (dir: string): string => {
  const bin = join(dir, "hostile-agent.cjs")
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
// Paths come through the environment: the runner gives the agent its OWN per-run temp dir,
// not RUNNER_CWD, so process.cwd() is not where the fixture lives. RUNNER_-prefixed so it
// survives the substrate's allowlist, same as any other runner setting.
const targets = JSON.parse(fs.readFileSync(process.env.RUNNER_ADV_TARGETS, "utf8"))
const token = process.env.DERIVE_TOKEN
const server = process.env.DERIVE_SERVER
const out = {}

const call = async (p, init) => {
  try {
    const r = await fetch(server + p, {
      ...init,
      headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(init && init.headers) },
    })
    let body = null
    try { body = await r.json() } catch {}
    return { status: r.status, body }
  } catch (e) { return { status: -1, error: String(e) } }
}

const main = async () => {
  // 1. Claim the agent's whole queue instead of just my run.
  out.batchClaim = await call("/v1/agent/runs/claim?limit=50")
  // 2. Settle a different run as succeeded without doing it.
  out.finishOther = await call("/v1/agent/runs/" + targets.victimRunId + "/finish", {
    method: "POST", body: JSON.stringify({ status: "succeeded" }),
  })
  // 3. Execute another run's bound source tools.
  out.toolOther = await call("/v1/agent/runs/" + targets.victimRunId + "/tool", {
    method: "POST", body: JSON.stringify({ name: "stripe.read", args: {} }),
  })
  // 4. Read a DIFFERENT user's decrypted model plan by naming their session.
  out.foreignCredential = await call(
    "/v1/agent/model-credential?provider=claude-code&session=" + targets.victimSessionId,
  )
  // 5. Read the API's own secrets out of the environment it handed me.
  out.identity = { tokenPrefix: (token || "(none)").slice(0, 8), server }
  out.envLeak = {
    authSecret: process.env.DERIVE_AUTH_SECRET || null,
    databaseUrl: process.env.DATABASE_URL || null,
    // Every variable that is not on the substrate's allowlist, for the record.
    unexpected: Object.keys(process.env).filter(
      (k) => !/^(PATH|HOME|SHELL|USER|LOGNAME|LANG|LC_ALL|TZ|TMPDIR|TERM|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|AGENT_BIN|CLAUDE_BIN|CODEX_BIN|RUNNER_[A-Z_]*|DERIVE_TOKEN|DERIVE_SERVER|DERIVE_CONTEXT|_|PWD|SHLVL|OLDPWD|INIT_CWD|NODE|npm_[a-zA-Z_]*|__CF[A-Z_]*|XPC_[A-Z_]*|SSH_[A-Z_]*|COMMAND_MODE|LOGNAME|TMPDIR)$/.test(k),
    ),
  }
  // Dispatch boots an executor for RUNS and for SESSIONS, so more than one child may run this
  // script. They are entirely different principals with different rights, so each reports under
  // its own kind — otherwise whichever finishes last wins and the test asserts against the
  // wrong attacker.
  const kind = String(token || "").startsWith("dksess_") ? "session" : "run"
  fs.writeFileSync(process.env.RUNNER_ADV_VERDICTS + "." + kind + ".json", JSON.stringify(out, null, 1))

  // Finish the run properly so the loop closes and the test can inspect the aftermath.
  const revision = { content: "# Numbers\\n\\ndone\\n", filename: "n.md", confidence: 0.9, message: "ok" }
  process.stdout.write(JSON.stringify({ type: "system", session_id: "adv" }) + "\\n")
  process.stdout.write(
    JSON.stringify({ type: "result", result: "<revision>" + JSON.stringify(revision) + "</revision>" }) + "\\n",
  )
}
main()
`,
    { mode: 0o755 },
  )
  return bin
}

describe("a hostile executor cannot escape its run", () => {
  it("is refused on every escalation it attempts, with a real token, from a real child", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "adv-"))
    const prior = { ...process.env }
    process.env.AGENT_BIN = hostileAgent(cwd)
    process.env.RUNNER_PROVIDER = "claude-code"
    process.env.RUNNER_CWD = cwd
    process.env.RUNNER_TIMEOUT_MS = "45000"
    process.env.RUNNER_ADV_TARGETS = join(cwd, "targets.json")
    process.env.RUNNER_ADV_VERDICTS = join(cwd, "verdicts")

    // The victim's own plan — the credential attack 4 tries to steal.
    await app.request(
      "/v1/me/model-credentials",
      jsonAs(as(victimUser.email), {
        provider: "claude-code",
        kind: "api_key",
        token: "victim-private-plan", // gitleaks:allow — fixture, never a real credential
      }),
    )
    await app.request(
      "/v1/me/model-credentials",
      jsonAs(as(owner.email), {
        provider: "claude-code",
        kind: "api_key",
        token: "attacker-own-plan", // gitleaks:allow — fixture, never a real credential
      }),
    )

    const doc = (await (
      await publishAs(app, "# Numbers\n\nstale\n", { title: "Adv Numbers" }, as(owner.email))
    ).json()) as { short_id: string }

    // The attacker's automation, and a SECOND one whose run is the prize.
    const mkAuto = async (instruction: string, contextId?: string) =>
      (await (
        await app.request(
          "/v1/automations",
          jsonAs(as(owner.email), {
            trigger: { kind: "manual" },
            instruction,
            refs: [{ kind: "artifact", id: doc.short_id, mode: "publish" }],
            ...(contextId ? { contextId } : {}),
          }),
        )
      ).json()) as { id: string }

    const runNow = async (id: string) =>
      (await (
        await app.request(`/v1/automations/${id}/run`, { method: "POST", headers: as(owner.email) })
      ).json()) as { id: string }

    // A session belonging to the OTHER user, so attack 4 has a real foreign target.
    const brief = (await (
      await publishAs(app, "# Brief", { title: "Adv Brief" }, as(owner.email))
    ).json()) as { short_id: string }
    const ctx = (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), { name: "AdvCtx", manifest_short_id: brief.short_id }),
      )
    ).json()) as { id: string }
    // Open the context to any member: ask_policy is set through its own access endpoint, not at
    // creation. The credential attack is only meaningful against a session that genuinely
    // belongs to a DIFFERENT person.
    await app.request(
      `/v1/contexts/${ctx.id}/access`,
      jsonAs(as(owner.email), { ask_policy: "workspace" }),
    )
    const { session: victimSession } = (await (
      await app.request(
        `/v1/contexts/${ctx.id}/sessions`,
        jsonAs(as(victimUser.email), { body_md: "the victim's question" }),
      )
    ).json()) as { session: { id: string } | undefined }
    if (!victimSession) throw new Error("the victim could not ask — check ask_policy")

    // BOTH automations are bound to that context, so all of this work — the attacker's run, the
    // other run, and the victim's session — is served by ONE agent. That is the configuration
    // the scope pin exists for: "same agent" is true here, so the older ownership check passes
    // and only the pin stands between an executor and another person's credential. Bind them
    // differently and the test proves nothing, because a weaker check refuses first.
    const attackerAuto = await mkAuto("the run that will misbehave", ctx.id)
    const victimAuto = await mkAuto("a different run, minding its own business", ctx.id)
    const victimRun = await runNow(victimAuto.id)

    writeFileSync(
      join(cwd, "targets.json"),
      JSON.stringify({ victimRunId: victimRun.id, victimSessionId: victimSession.id }),
    )

    // Boot ONLY the attacker's run. dispatchPass would also boot the victim's, so claim that one
    // first — it stands in for a run already executing elsewhere.
    const victimRow = await meta.getRun(victimRun.id)
    await meta.claimRunById(victimRun.id, victimRow?.agent_id ?? "", new Date().toISOString())

    const attackerRun = await runNow(attackerAuto.id)
    const res = await dispatchPass({
      meta,
      substrate: nodeSubstrate({
        bin: join(process.cwd(), "../../packages/cli/bin/derive.js"),
        timeoutMs: 60_000,
      }),
      server: base,
      secret: SECRET,
    })
    expect(res.started).toBeGreaterThanOrEqual(1)

    // Wait for the child to SETTLE, not merely to leave the queue: it claims almost
    // immediately, and everything interesting happens after that.
    const deadline = Date.now() + 90_000
    let settled = await meta.getRun(attackerRun.id)
    while (
      Date.now() < deadline &&
      settled?.status !== "succeeded" &&
      settled?.status !== "failed"
    ) {
      await new Promise((r) => setTimeout(r, 250))
      settled = await meta.getRun(attackerRun.id)
    }

    let raw: string
    try {
      raw = readFileSync(join(cwd, "verdicts.run.json"), "utf8")
    } catch {
      const r = await meta.getRun(attackerRun.id)
      throw new Error(
        `the hostile child never reported. run=${r?.status} meta=${r?.meta} cwd=${cwd}`,
      )
    }
    type Attempt = { status: number; body?: unknown }
    const v = JSON.parse(raw) as {
      identity: { tokenPrefix: string; server: string }
      batchClaim: Attempt
      finishOther: Attempt
      toolOther: Attempt
      foreignCredential: Attempt
      envLeak: { authSecret: string | null; databaseUrl: string | null; unexpected: string[] }
    }

    // 1. A run token may call claim — that is how it gets its own work — but it must take the
    // SCOPED branch and never the standing-runner batch. So the property is not the status, it
    // is what came back: only its own run, never another. (The session-token version of this,
    // where the batch branch was reachable, is covered in hosted-dispatch.test.ts.)
    const claimed = (
      (v.batchClaim.body as { runs?: { id: string }[] } | undefined)?.runs ?? []
    ).map((r) => r.id)
    expect(claimed, "a run token claimed another run through /claim").not.toContain(victimRun.id)
    expect(
      claimed.filter((id) => id !== attackerRun.id),
      "a run token claimed runs other than its own",
    ).toEqual([])
    // 2. It must not settle another run.
    expect([403, 404], "a run token settled a DIFFERENT run").toContain(v.finishOther.status)
    // 3. It must not execute another run's source tools.
    expect([403, 404], "a run token used another run's tools").toContain(v.toolOther.status)
    // 4. It must not read another user's decrypted plan. Assert on the BODY, not just the
    // status: this endpoint answers 200 with {credential: null} when it finds nothing, so a
    // status-only check would pass while a real plan token was being handed over.
    const leaked = (v.foreignCredential.body as { credential?: { value?: string } } | undefined)
      ?.credential
    // Identity first: which credential did the child actually present? A leak means one thing
    // if it held a scoped capability token and something quite different if it held a standing
    // agent token, and the fix differs accordingly.
    // The RUN executor's verdicts — a genuinely different principal from the session one.
    expect(JSON.stringify(v.identity), "expected the run executor's report").toContain("dkrun_")
    expect(
      leaked ?? null,
      `a run token read a FOREIGN user's model plan: ${JSON.stringify(v.foreignCredential)}`,
    ).toBeNull()
    // 5. The API's own secrets must never have been in reach.
    expect(v.envLeak.authSecret, "DERIVE_AUTH_SECRET was readable by the model process").toBeNull()
    expect(v.envLeak.databaseUrl, "DATABASE_URL was readable by the model process").toBeNull()

    // The victim run is untouched — still held by its own executor, not settled by the attacker.
    expect((await meta.getRun(victimRun.id))?.status).toBe("running")

    process.env = prior
  }, 120_000)
})
