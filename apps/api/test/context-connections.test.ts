import {
  CONTEXT_ENVIRONMENT_LIMIT as SERVER_LIMIT,
  contextEnvironmentNameError as serverError,
} from "@derive/core"
import { describe, expect, it, vi } from "vitest"
import {
  CONTEXT_ENVIRONMENT_LIMIT,
  contextEnvironmentNameError,
} from "../../web/src/lib/context-environment"
import { encryptSecret } from "../src/lib/crypto"
import { dispatchPass, type Substrate } from "../src/lib/dispatch"
import { OrtamClient } from "../src/lib/ortam-client"
import { signWorkToken } from "../src/lib/run-token"
import { runtimeDispatchPass } from "../src/lib/runtime-dispatch"
import {
  materializeRuntimeSchedules,
  nextRuntimeOccurrence,
  runtimeScheduleAllows,
} from "../src/lib/runtime-schedule"
import { SETUP_RUNNER_PATH } from "../src/lib/runtime-setup"
import { materializeAllDueRuns } from "../src/lib/schedule"
import { log } from "../src/log"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// P3.5 — a context's connections are its hands in EVERY lane. Before this, connection ids
// lived only on an automation, so credentials attached to a scheduled job and an ask could
// not use a connection at all. The load-bearing property is that both lanes resolve the
// SAME least-privilege list from the same place: a context reaches exactly the same things
// whether a schedule fired it or a person asked it a question.
const SECRET = "test-secret-at-least-16-chars"

describe("context connections (the ask lane gets hands)", () => {
  const owner: TestUser = { id: "u_cc_own", email: "ccown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_cc_mem", email: "ccmem@derive.test", name: "Member" }
  const { app, meta } = makeAuthedApp("context-connections", [owner, member], "editor", {
    deps: { encryptionKey: SECRET },
  })

  const makeConnection = async (body: Record<string, unknown>) =>
    (await (await app.request("/v1/connections", jsonAs(as(owner.email), body))).json()) as {
      id: string
    }

  // Boot every queued session through a fake substrate and hand back the capability token
  // dispatch minted for one of them — the executor's real entry into the ask lane.
  const tokenFor = async (sessionId: string) => {
    const started: { runId: string; token: string; server: string }[] = []
    const substrate: Substrate = {
      name: "fake",
      async start(input) {
        started.push(input)
      },
    }
    await dispatchPass({ meta, substrate, server: "https://derive.test", secret: SECRET })
    return started.find((s) => s.runId === sessionId)?.token ?? ""
  }

  const makeContext = async (name: string, connectionIds?: string[]) => {
    const manifest = await publishAs(app, "# How to answer", { title: name }, as(owner.email))
    const { short_id } = (await manifest.json()) as { short_id: string }
    return (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name,
          manifest_short_id: short_id,
          ...(connectionIds ? { connection_ids: connectionIds } : {}),
        }),
      )
    ).json()) as { id: string; agent_token: string; connection_ids: string[] }
  }

  it("binds at create, reports them back, and replaces the whole list on set", async () => {
    const stripe = await makeConnection({ toolkit: "stripe" })
    const gmail = await makeConnection({ toolkit: "gmail" })
    const ctx = await makeContext("Support", [stripe.id])
    expect(ctx.connection_ids).toEqual([stripe.id])

    const set = await app.request(
      `/v1/contexts/${ctx.id}/connections`,
      jsonAs(as(owner.email), { connection_ids: [gmail.id] }),
    )
    expect(set.status).toBe(200)
    // Whole-list replace: stripe is gone, not merged.
    expect((await set.json()).connection_ids).toEqual([gmail.id])
    const read = await (
      await app.request(`/v1/contexts/${ctx.id}`, { headers: as(owner.email) })
    ).json()
    expect(read.connection_ids).toEqual([gmail.id])
  })

  it("enforces the same bind policy as an automation: someone else's personal connection is refused", async () => {
    const theirs = (await (
      await app.request("/v1/connections", jsonAs(as(member.email), { toolkit: "notion" }))
    ).json()) as { id: string }
    const manifest = await publishAs(app, "# m", { title: "Bind" }, as(owner.email))
    const { short_id } = (await manifest.json()) as { short_id: string }
    const res = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), {
        name: "Nosy",
        manifest_short_id: short_id,
        connection_ids: [theirs.id],
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/owner/i)
  })

  it("a session claim carries the context's tools, and nothing behind them", async () => {
    const secretValue = "fixture-bearer-context-lane"
    const conn = await makeConnection({
      toolkit: "game",
      kind: "secret",
      secret: secretValue,
      base_url: "https://api.game.test",
      scope: "workspace",
    })
    const ctx = await makeContext("Steward", [conn.id])
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "Anything odd today?" }),
    )
    const { session } = (await ask.json()) as { session: { id: string } }

    // Dispatch mints the session capability token the executor claims with.
    const token = await tokenFor(session.id)
    expect(token).toBeTruthy()

    const claim = await app.request("/v1/agent/sessions/claim", jsonAs(bearer(token), {}))
    const text = await claim.text()
    // The executor learns the tool NAMES and nothing else — no credential, and none of
    // RunTool's routing fields, exactly as the run lane's claim behaves.
    expect(text).not.toContain(secretValue)
    expect(text).not.toContain("secret_enc")
    expect(text).not.toContain("connectionId")
    const claimed = JSON.parse(text)
    expect(claimed.tools.map((t: { def: { name: string } }) => t.def.name).sort()).toEqual([
      "game.get",
      "game.post",
    ])

    // And the proxy executes for that session, server-side, with the credential attached
    // here rather than anywhere near the executor.
    const calls: { url: string; auth: string | null }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
      return new Response(JSON.stringify({ flagged: 2 }), { status: 200 })
    }) as typeof fetch
    try {
      const call = await app.request(
        `/v1/agent/sessions/${session.id}/tool`,
        jsonAs(bearer(token), { tool: "game.get", args: { path: "/report" } }),
      )
      expect(call.status).toBe(200)
      expect((await call.json()).result).toEqual({ status: 200, body: { flagged: 2 } })
      expect(calls[0]).toMatchObject({
        url: "https://api.game.test/report",
        auth: `Bearer ${secretValue}`,
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("a BYO polling runner gets the same tools, and may spend them with its standing bearer", async () => {
    const secretValue = "fixture-bearer-byo-lane"
    const conn = await makeConnection({
      toolkit: "ops",
      kind: "secret",
      secret: secretValue,
      base_url: "https://api.ops.test",
      scope: "workspace",
    })
    const ctx = await makeContext("BYO", [conn.id])
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "status?" }),
    )
    const { session } = (await ask.json()) as { session: { id: string } }

    // The queue is the BYO runner's door, and it carries the same list the hosted claim does.
    const queue = await app.request(`/v1/contexts/${ctx.id}/queue`, {
      headers: bearer(ctx.agent_token),
    })
    const q = await queue.json()
    expect(q.tools.map((t: { def: { name: string } }) => t.def.name).sort()).toEqual([
      "ops.get",
      "ops.post",
    ])

    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as typeof fetch
    try {
      // A standing agent bearer spends them for its OWN context's session — the same
      // latitude the run lane gives a standing bearer for its own runs.
      const mine = await app.request(
        `/v1/agent/sessions/${session.id}/tool`,
        jsonAs(bearer(ctx.agent_token), { tool: "ops.get", args: { path: "/health" } }),
      )
      expect(mine.status).toBe(200)

      // Another context's agent gets nothing, standing bearer or not.
      const other = await makeContext("Other")
      const stolen = await app.request(
        `/v1/agent/sessions/${session.id}/tool`,
        jsonAs(bearer(other.agent_token), { tool: "ops.get", args: { path: "/health" } }),
      )
      expect(stolen.status).toBe(404)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("a base_url-less secret contributes NO tools — there is nothing to call it against", async () => {
    // base_url is optional now (nobody types a host), but the machineless lane resolves a
    // path against it and confines to it. A connection without one can only be SPENT by
    // delivery into a run, so advertising `own.get`/`own.post` here would hand the model two
    // tools that throw on every call. Better to expose none and say why.
    const withHost = await makeConnection({
      toolkit: "hosted",
      kind: "secret",
      secret: "fixture-with-a-host",
      base_url: "https://api.hosted.test",
      scope: "workspace",
    })
    const noHost = await makeConnection({
      toolkit: "delivered",
      kind: "secret",
      secret: "fixture-delivery-only",
      scope: "workspace",
    })
    const ctx = await makeContext("Mixed", [withHost.id, noHost.id])
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "?" }),
    )
    const { session } = (await ask.json()) as { session: { id: string } }
    const claim = await (
      await app.request("/v1/agent/sessions/claim", jsonAs(bearer(await tokenFor(session.id)), {}))
    ).json()
    // Only the one with a host. The delivery-only connection stays bound and invisible here.
    expect(claim.tools.map((t: { def: { name: string } }) => t.def.name).sort()).toEqual([
      "hosted.get",
      "hosted.post",
    ])
    // And the proxy refuses the tool it never advertised.
    const call = await app.request(
      `/v1/agent/sessions/${session.id}/tool`,
      jsonAs(bearer(await tokenFor(session.id)), {
        tool: "delivered.get",
        args: { path: "/x" },
      }),
    )
    expect(call.status).toBe(403)
  })

  it("a session token reaches only its OWN session's tools", async () => {
    const conn = await makeConnection({ toolkit: "stripe" })
    const mine = await makeContext("Mine", [conn.id])
    const theirs = await makeContext("Theirs", [conn.id])
    const ask = async (id: string) =>
      (
        (await (
          await app.request(
            `/v1/contexts/${id}/sessions`,
            jsonAs(as(owner.email), { body_md: "?" }),
          )
        ).json()) as { session: { id: string } }
      ).session.id
    const mineSession = await ask(mine.id)
    const theirsSession = await ask(theirs.id)

    const mineToken = await tokenFor(mineSession)
    // Aiming this session's token at the other session's tool endpoint is refused before
    // any tool is resolved — the mirror of the run lane's kind check.
    const cross = await app.request(
      `/v1/agent/sessions/${theirsSession}/tool`,
      jsonAs(bearer(mineToken), { tool: "stripe.read", args: {} }),
    )
    expect(cross.status).toBe(403)
  })

  it("a context with no connections exposes no tools and refuses the proxy", async () => {
    const ctx = await makeContext("Bare")
    expect(ctx.connection_ids).toEqual([])
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "hello" }),
    )
    const { session } = (await ask.json()) as { session: { id: string } }
    const token = await tokenFor(session.id)
    const claim = await (
      await app.request("/v1/agent/sessions/claim", jsonAs(bearer(token), {}))
    ).json()
    expect(claim.tools).toEqual([])
    const call = await app.request(
      `/v1/agent/sessions/${session.id}/tool`,
      jsonAs(bearer(token), { tool: "anything.get", args: {} }),
    )
    expect(call.status).toBe(403)
  })
  it("keeps the settings form validation in sync with the API policy", () => {
    expect(CONTEXT_ENVIRONMENT_LIMIT).toBe(SERVER_LIMIT)
    const names = [
      "DATABASE_URL",
      "A",
      "A".repeat(64),
      "A".repeat(65),
      "",
      "lowercase",
      "A-B",
      "1_NAME",
      "PATH",
      "HOME",
      "SHELL",
      "USER",
      "LOGNAME",
      "PWD",
      "OLDPWD",
      "ENV",
      "IFS",
      "TMPDIR",
      "TMP",
      "TEMP",
      ...[
        "DERIVE",
        "CODEX",
        "CLAUDE",
        "ANTHROPIC",
        "OPENAI",
        "GIT",
        "LD",
        "DYLD",
        "NODE",
        "NPM",
        "PYTHON",
        "BASH",
        "ZSH",
        "SSH",
      ].flatMap((prefix) => [prefix, `${prefix}_TOKEN`, `${prefix}PATH`]),
    ]
    for (const name of names)
      expect(contextEnvironmentNameError(name), name).toBe(serverError(name))
  })

  const setEnvironment = (
    id: string,
    bindings: Record<string, string>,
    headers: Record<string, string> = as(owner.email),
  ) =>
    app.request(`/v1/contexts/${id}/environment`, {
      ...jsonAs(headers, { bindings }),
      method: "PUT",
    })

  const activeSession = async (contextId: string) => {
    const context = await meta.getContext(contextId)
    if (!context) throw new Error("missing context")
    const response = await app.request(
      `/v1/contexts/${contextId}/sessions`,
      jsonAs(as(owner.email), { body_md: "check" }),
    )
    const { session } = await response.json()
    const token = await signWorkToken(
      "session",
      SECRET,
      session.id,
      context.agent_id,
      context.org_id,
      Date.now() + 60_000,
    )
    const claim = await app.request("/v1/agent/sessions/claim", jsonAs(bearer(token), {}))
    expect(claim.status).toBe(200)
    return { id: session.id as string, token }
  }

  it("delivers selected environment secrets only to the active session, never on normal reads", async () => {
    const secret = "environment-fixture-value"
    const conn = await makeConnection({ toolkit: "database", kind: "secret", secret })
    const ctx = await makeContext("Environment")
    expect((await setEnvironment(ctx.id, { DATABASE_URL: conn.id })).status).toBe(200)
    const session = await activeSession(ctx.id)
    const response = await app.request(`/v1/agent/environment?session=${session.id}`, {
      headers: bearer(session.token),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ environment: { DATABASE_URL: secret } })
    expect((await meta.getConnection(conn.id))?.secret_enc).not.toContain(secret)
    for (const path of [
      `/v1/contexts/${ctx.id}`,
      `/v1/contexts/${ctx.id}/environment`,
      "/v1/connections",
    ]) {
      const read = await app.request(path, { headers: as(owner.email) })
      expect(read.status).toBe(200)
      expect(await read.text()).not.toContain(secret)
    }
    expect(
      (
        await app.request(`/v1/agent/environment?session=${session.id}`, {
          headers: as(owner.email),
        })
      ).status,
    ).toBe(401)
    expect((await setEnvironment(ctx.id, {}, bearer(session.token))).status).toBe(401)
    await meta.setConnectionStatus(
      conn.id,
      (await meta.getContext(ctx.id))?.org_id ?? "",
      "revoked",
    )
    const revoked = await app.request(`/v1/agent/environment?session=${session.id}`, {
      headers: bearer(session.token),
    })
    expect(revoked.status).toBe(409)
    expect(await revoked.text()).not.toContain(secret)
    await setEnvironment(ctx.id, {})
    const empty = await app.request(`/v1/agent/environment?session=${session.id}`, {
      headers: bearer(session.token),
    })
    expect(await empty.json()).toEqual({ environment: {} })
  })

  it("rechecks credentials and membership at retrieval, and never returns a partial environment", async () => {
    const ctx = await makeContext("Live environment access")
    const context = await meta.getContext(ctx.id)
    if (!context) throw new Error("missing context")
    const first = await makeConnection({
      toolkit: "first",
      kind: "secret",
      secret: "first-fixture",
    })
    const second = await makeConnection({
      toolkit: "second",
      kind: "secret",
      secret: "second-fixture",
    })
    await setEnvironment(ctx.id, { FIRST: first.id, SECOND: second.id })
    const session = await activeSession(ctx.id)
    const read = () =>
      app.request(`/v1/agent/environment?session=${session.id}`, {
        headers: bearer(session.token),
      })
    await meta.updateConnectionCredential(second.id, context.org_id, {
      secret_enc: encryptSecret("rotated-fixture", SECRET),
    })
    expect(await (await read()).json()).toEqual({
      environment: { FIRST: "first-fixture", SECOND: "rotated-fixture" },
    })
    await meta.updateConnectionCredential(second.id, context.org_id, {
      secret_enc: encryptSecret("unreadable-fixture", "different-encryption-key"),
    })
    const broken = await read()
    expect(broken.status).toBe(503)
    expect(await broken.json()).not.toHaveProperty("environment")
    const membership = await meta.getMembership(context.org_id, owner.id)
    if (!membership) throw new Error("missing membership")
    await meta.removeMembership(context.org_id, owner.id)
    try {
      const offboarded = await read()
      expect(offboarded.status).toBe(409)
      expect(await offboarded.json()).not.toHaveProperty("environment")
    } finally {
      await meta.setMembership(membership)
    }
  })

  it("refuses foreign secrets, invalid names, non-secret connections and unauthorized managers", async () => {
    const theirs = await (
      await app.request(
        "/v1/connections",
        jsonAs(as(member.email), { toolkit: "private", kind: "secret", secret: "foreign-fixture" }),
      )
    ).json()
    const own = await makeConnection({ toolkit: "env", kind: "secret", secret: "own-fixture" })
    const oauth = await makeConnection({ toolkit: "stripe" })
    const ctx = await makeContext("Environment guards")
    expect((await setEnvironment(ctx.id, { DATABASE_URL: theirs.id })).status).toBe(400)
    expect((await setEnvironment(ctx.id, { DATABASE_URL: oauth.id })).status).toBe(400)
    for (const name of [
      "HOME",
      "PATH",
      "DERIVE_TOKEN",
      "OPENAI_API_KEY",
      "NODE_OPTIONS",
      "GIT_CONFIG",
      "bad-name",
    ]) {
      expect((await setEnvironment(ctx.id, { [name]: own.id })).status).toBe(400)
    }
    expect((await setEnvironment(ctx.id, { DATABASE_URL: own.id }, as(member.email))).status).toBe(
      403,
    )
    const otherOrg = await makeConnection({
      toolkit: "other",
      kind: "secret",
      secret: "other-fixture",
    })
    // Missing IDs and unsupported grants cannot turn into a partial environment.
    expect(
      (await setEnvironment(ctx.id, { DATABASE_URL: "conn_missing", OTHER: otherOrg.id })).status,
    ).toBe(400)
    expect(
      (await app.request(`/v1/contexts/${ctx.id}/environment`, { headers: as(member.email) }))
        .status,
    ).toBe(403)
  })

  it("confines session tokens to one work item and stops delivery after completion", async () => {
    const ctx = await makeContext("Environment token scope")
    const mine = await activeSession(ctx.id)
    const other = await activeSession(ctx.id)
    expect(
      (
        await app.request(`/v1/agent/environment?session=${other.id}`, {
          headers: bearer(mine.token),
        })
      ).status,
    ).toBe(403)
    expect(
      (await app.request(`/v1/agent/environment?run=anything`, { headers: bearer(mine.token) }))
        .status,
    ).toBe(403)
    const outsider = await makeContext("Environment outsider")
    expect(
      (
        await app.request(`/v1/agent/environment?session=${mine.id}`, {
          headers: bearer(outsider.agent_token),
        })
      ).status,
    ).toBe(404)
    // Use the store transition rather than depend on the answer presentation contract.
    await meta.setSessionState(mine.id, "answered")
    expect(
      (
        await app.request(`/v1/agent/environment?session=${mine.id}`, {
          headers: bearer(ctx.agent_token),
        })
      ).status,
    ).toBe(409)
  })

  it("delivers the same Context environment to scheduled runs and refuses another run", async () => {
    const ctx = await makeContext("Scheduled environment")
    const context = await meta.getContext(ctx.id)
    if (!context) throw new Error("missing context")
    const conn = await makeConnection({
      toolkit: "scheduled",
      kind: "secret",
      secret: "scheduled-fixture",
    })
    await setEnvironment(ctx.id, { DATABASE_URL: conn.id })
    const automation = await meta.createAutomation({
      id: "auto_env",
      org_id: context.org_id,
      agent_id: context.agent_id,
      context_id: ctx.id,
      trigger: JSON.stringify({ kind: "manual" }),
      instruction: "check",
    })
    const run = await meta.createRun({
      id: "run_env",
      org_id: context.org_id,
      agent_id: context.agent_id,
      automation_id: automation.id,
      reason: "manual",
      status: "running",
    })
    const token = await signWorkToken(
      "run",
      SECRET,
      run.id,
      context.agent_id,
      context.org_id,
      Date.now() + 60_000,
    )
    const response = await app.request(`/v1/agent/environment?run=${run.id}`, {
      headers: bearer(token),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ environment: { DATABASE_URL: "scheduled-fixture" } })
    expect(
      (await app.request("/v1/agent/environment?run=other", { headers: bearer(token) })).status,
    ).toBe(403)
    // Reassigning the automation while an executor is running must not silently turn
    // its required environment into an empty one.
    const replacement = await makeContext("Replacement runner")
    const replacementContext = await meta.getContext(replacement.id)
    if (!replacementContext) throw new Error("missing replacement context")
    await meta.updateAutomation(automation.id, context.org_id, {
      agent_id: replacementContext.agent_id,
      context_id: null,
    })
    expect(
      (
        await app.request(`/v1/agent/environment?run=${run.id}`, {
          headers: bearer(token),
        })
      ).status,
    ).toBe(409)
  })
})

describe("Ortam runtime lifecycle", () => {
  const owner: TestUser = { id: "u_runtime", email: "runtime@derive.test", name: "Runtime owner" }
  const member: TestUser = {
    id: "u_runtime_member",
    email: "runtime-member@derive.test",
    name: "Member",
  }
  const config = {
    apiUrl: "https://ortam.test/v1",
    runnerPath: "/opt/derive/bin/derive.js",
    pilotWorkspaceIds: new Set(["default"]),
  }
  const sandboxes = new Map<
    string,
    {
      state: string
      starts: number
      token?: string
      attempt?: string
      loseLaunch?: boolean
      stopFails?: boolean
    }
  >()
  const operations = new Map<
    string,
    { id: string; sandbox_id: string; kind: string; state: string }
  >()
  let counter = 0
  const peer: typeof fetch = async function (this: unknown, url, init) {
    // Cloudflare's global fetch rejects a client instance as its receiver. Node's
    // fetch accepts it, so make the HTTP peer enforce the production contract.
    expect(this).toBeUndefined()
    expect(init?.redirect).toBe("manual")
    const path = new URL(String(url)).pathname.replace("/v1", "")
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    if (path === "/auth/token")
      return json({
        token: `header.${Buffer.from(JSON.stringify({ sub: "ortam-owner", organization_id: "ortam-org" })).toString("base64url")}.signature`,
      })
    if (path.startsWith("/operations/")) return json(operations.get(path.split("/")[2] ?? ""))
    const id = path.split("/")[2] ?? ""
    const sandbox = sandboxes.get(id)
    if (!sandbox) return json({}, 404)
    if (path.endsWith("/resume") || path.endsWith("/stop")) {
      const kind = path.endsWith("/resume") ? "resume" : "stop"
      const key = new Headers(init?.headers).get("Idempotency-Key") ?? ""
      if (operations.has(key)) return json(operations.get(key))
      if (kind === "stop" && sandbox.stopFails) return json({}, 503)
      const op = { id: `op_${++counter}`, sandbox_id: id, kind, state: "succeeded" }
      operations.set(key, op)
      operations.set(op.id, op)
      sandbox.state = kind === "resume" ? "ready" : "stopped"
      return json(op)
    }
    if (path.endsWith("/processes")) {
      sandbox.starts++
      const body = JSON.parse(String(init?.body))
      expect(body.argv).toEqual([
        "node",
        config.runnerPath,
        "runner",
        "run",
        "--model-auth",
        "ortam",
        "--cwd",
        "/home/ortam/work",
      ])
      expect(body.env.ORTAM_API_KEY).toBeUndefined()
      expect(body.argv.join(" ")).not.toContain(body.env.DERIVE_TOKEN)
      sandbox.token = body.env.DERIVE_TOKEN
      sandbox.attempt = body.env.DERIVE_ATTEMPT_ID
      if (sandbox.loseLaunch) throw new Error("lost response")
      return json({ id: `prc_${counter}`, status: "running" })
    }
    if (path.includes("/processes/")) return json({ id: `prc_${counter}`, status: "running" })
    return json({
      id,
      state: sandbox.state,
      current_operation_id: null,
      auto_stop_after_seconds: 1200,
      agent_connections: { user_id: "ortam-owner" },
    })
  }
  const pokeRuntime = vi.fn()
  const { app, meta, ctx } = makeAuthedApp("runtime-lifecycle", [owner, member], "editor", {
    operatorIds: [owner.id],
    deps: { encryptionKey: SECRET, runtime: config, runtimeFetch: peer, pokeRuntime },
  })
  let now = new Date()
  const pass = () =>
    runtimeDispatchPass({
      meta,
      blobs: ctx.blobs,
      secret: SECRET,
      server: "http://derive.test",
      config,
      fetcher: peer,
      now: () => now,
      pokeRuntime,
    })
  async function setup(withEnvironment = false) {
    now = new Date()
    const settings = await meta.getOrgSettings("default")
    await meta.setOrgSettings("default", {
      ...settings,
      hostedAgentsEnabled: true,
      agentWrites: true,
    })
    const manifest = await publishAs(
      app,
      "# Run methodology",
      { title: `Runtime ${++counter}` },
      as(owner.email),
    )
    const { short_id } = await manifest.json()
    const response = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), { name: `Runtime ${counter}`, manifest_short_id: short_id }),
    )
    expect(response.status).toBe(201)
    const context = await response.json()
    const connection = await meta.createConnection({
      id: `cn_runtime_${counter}`,
      org_id: "default",
      user_id: owner.id,
      kind: "secret",
      broker: "none",
      toolkit: "ortam",
      broker_ref: `runtime_${counter}`,
      status: "active",
      secret_enc: encryptSecret("Ortam test credential", SECRET),
    })
    const sandboxId = `sbx_${String(counter).padStart(26, "0")}`
    sandboxes.set(sandboxId, { state: "stopped", starts: 0 })
    const bind = await app.request(
      `/v1/contexts/${context.id}/runtime`,
      jsonAs(as(owner.email), { connection_id: connection.id, sandbox_id: sandboxId }),
    )
    expect(bind.status).toBe(201)
    if (withEnvironment) {
      const secret = await meta.createConnection({
        id: `env_runtime_${counter}`,
        org_id: "default",
        user_id: owner.id,
        kind: "secret",
        broker: "none",
        toolkit: "environment",
        broker_ref: `env_${counter}`,
        status: "active",
        secret_enc: encryptSecret("runtime environment fixture", SECRET),
      })
      await meta.setContextEnvironment(context.id, JSON.stringify({ APP_INPUT: secret.id }))
    }
    const queued = await app.request(
      `/v1/contexts/${context.id}/runtime/runs`,
      jsonAs(as(owner.email), { instruction: "Check yesterday's games", provider: "codex" }),
    )
    expect(queued.status).toBe(201)
    const { run } = await queued.json()
    const sandbox = sandboxes.get(sandboxId)
    if (!sandbox) throw new Error("Missing sandbox")
    return { context, run, sandbox, connection }
  }
  async function launched() {
    const f = await setup()
    await pass()
    await pass()
    await pass()
    expect(f.sandbox.starts).toBe(1)
    return f
  }
  const attemptRequest = (
    sandbox: { token?: string; attempt?: string },
    action: string,
    body: unknown = {},
  ) =>
    app.request(
      `/v1/runtime-attempts/${sandbox.attempt}/${action}`,
      jsonAs({ Authorization: `Bearer ${sandbox.token}` }, body),
    )
  const result = {
    version: 1,
    outcome: "completed",
    summary: "# Daily report\n\nChecked the games; no suspicious activity.",
    outputs: [],
  }

  const dailyTask = {
    instruction: "Run the anti-cheat script and explain suspicious games",
    provider: "codex",
    cron: "0 * * * *",
    timezone: "America/New_York",
    enabled: true,
    revision: null,
  }
  const saveSchedule = (contextId: string, body: object, email = owner.email) =>
    app.request(`/v1/contexts/${contextId}/runtime/schedule`, {
      ...jsonAs(as(email), body),
      method: "PUT",
    })
  async function scheduled() {
    const f = await setup()
    await meta.cancelQueuedRuntimeRun(f.run.id, "default", now.toISOString())
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      automateBeta: true,
    })
    const saved = await saveSchedule(f.context.id, dailyTask)
    expect(saved.status).toBe(200)
    const { schedule } = await saved.json()
    now = new Date(nextRuntimeOccurrence(dailyTask.cron, dailyTask.timezone, now))
    return { ...f, schedule }
  }

  it("rejects an upstream redirect without forwarding controller credentials", async () => {
    const redirect = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: "https://other.test/token" } }),
      )
    const client = new OrtamClient(config.apiUrl, "controller-fixture", redirect)
    await expect(client.authenticate()).rejects.toThrow("Ortam returned HTTP 302")
    expect(redirect).toHaveBeenCalledExactlyOnceWith(
      `${config.apiUrl}/auth/token`,
      expect.objectContaining({ redirect: "manual" }),
    )
  })

  it("keeps pilot setup and runtime details behind operator and workspace access", async () => {
    const f = await setup()
    await meta.cancelQueuedRuntimeRun(f.run.id, "default", now.toISOString())
    const runtimePath = `/v1/contexts/${f.context.id}/runtime`
    const original = await meta.getContextRuntimeForContext(f.context.id, "default")
    const assertDenied = async (email: string) => {
      const state = await app.request(runtimePath, { headers: as(email) })
      expect(state.status).toBe(200)
      expect(await state.json()).toEqual({
        enabled: false,
        runtime: null,
        schedule: null,
        next_run_at: null,
        runs: [],
      })
      for (const [suffix, method] of [
        ["", "POST"],
        ["/runs", "POST"],
        ["/schedule", "PUT"],
        ["/disable", "POST"],
      ]) {
        const response = await app.request(`${runtimePath}${suffix}`, {
          ...jsonAs(as(email), {}),
          method,
        })
        expect(response.status).toBe(403)
      }
      expect(await meta.getContextRuntimeForContext(f.context.id, "default")).toEqual(original)
      expect(
        (await meta.listRuns("default", 100)).filter((r) => r.runtime_id === original?.id),
      ).toHaveLength(1)
    }
    // Even workspace administration does not grant machine setup rights.
    await meta.setMembership({
      id: "runtime-member-seat",
      org_id: "default",
      user_id: member.id,
      role: "owner",
    })
    try {
      await assertDenied(member.email)
    } finally {
      await meta.setMembership({
        id: "runtime-member-seat",
        org_id: "default",
        user_id: member.id,
        role: "editor",
      })
    }
    // Being the Context's creator is also insufficient, even in an allowed workspace.
    const manifest = await publishAs(
      app,
      "# Member task",
      { title: "Member pilot" },
      as(member.email),
    )
    const created = await app.request(
      "/v1/contexts",
      jsonAs(as(member.email), {
        name: "Member pilot",
        manifest_short_id: (await manifest.json()).short_id,
      }),
    )
    expect(created.status).toBe(201)
    const memberPath = `/v1/contexts/${(await created.json()).id}/runtime`
    expect(
      await (await app.request(memberPath, { headers: as(member.email) })).json(),
    ).toMatchObject({ enabled: false, runtime: null })
    expect((await app.request(memberPath, jsonAs(as(member.email), {}))).status).toBe(403)
    // The instance operator must also stay inside the explicit rollout boundary.
    config.pilotWorkspaceIds.clear()
    try {
      await assertDenied(owner.email)
    } finally {
      config.pilotWorkspaceIds.add("default")
    }
    const state = await app.request(runtimePath, { headers: as(owner.email) })
    expect(await state.json()).toMatchObject({ enabled: true, runtime: { id: original?.id } })
  })

  it("uses the same rollout boundary for background admission and still confirms shutdown", async () => {
    const f = await scheduled()
    config.pilotWorkspaceIds.clear()
    try {
      await pass()
      expect(await meta.latestRunForAutomation(f.schedule.id, "schedule")).toBeNull()
      expect(f.sandbox.starts).toBe(0)
      config.pilotWorkspaceIds.add("default")
      for (let i = 0; i < 4; i++) await pass()
      const run = await meta.latestRunForAutomation(f.schedule.id, "schedule")
      if (!run) throw new Error("Scheduled run missing")
      expect((await attemptRequest(f.sandbox, "claim")).status).toBe(200)
      expect((await attemptRequest(f.sandbox, "result", result)).status).toBe(200)
      config.pilotWorkspaceIds.clear()
      for (let i = 0; i < 5; i++) await pass()
      expect((await meta.getRun(run.id))?.status).toBe("succeeded")
      expect(await meta.getLatestRunAttempt(run.id, "default")).toMatchObject({
        phase: "released",
        save_status: "saved",
      })
      expect(f.sandbox.state).toBe("stopped")
    } finally {
      config.pilotWorkspaceIds.add("default")
      await saveSchedule(f.context.id, { ...dailyTask, enabled: false, revision: 0 })
    }
  })

  it("does not execute existing manual or scheduled work owned by a non-operator", async () => {
    const f = await setup()
    await meta.cancelQueuedRuntimeRun(f.run.id, "default", now.toISOString())
    await meta.setMembership({
      id: "runtime-member-seat",
      org_id: "default",
      user_id: member.id,
      role: "owner",
    })
    try {
      // Seed records admitted before operator-only access was enforced.
      const schedule = await meta.saveRuntimeSchedule({
        ...dailyTask,
        provider: "codex",
        id: `legacy_schedule_${counter}`,
        runtimeId: f.run.runtime_id,
        orgId: "default",
        ownerId: member.id,
        at: now.toISOString(),
      })
      if (!schedule) throw new Error("Legacy schedule missing")
      const legacy = await meta.createRun({
        id: `legacy_run_${counter}`,
        org_id: "default",
        agent_id: f.run.agent_id,
        runtime_id: f.run.runtime_id,
        initiated_by: member.id,
        reason: "manual:runtime",
        input_snapshot: f.run.input_snapshot,
      })
      now = new Date(nextRuntimeOccurrence(dailyTask.cron, dailyTask.timezone, now))
      await pass()
      expect(await meta.latestRunForAutomation(schedule.id, "schedule")).toBeNull()
      expect(await meta.getLatestRunAttempt(legacy.id, "default")).toBeNull()
      expect((await meta.getRun(legacy.id))?.status).toBe("failed")
      expect(f.sandbox.starts).toBe(0)
      await meta.deleteAutomation(schedule.id, "default")
    } finally {
      await meta.setMembership({
        id: "runtime-member-seat",
        org_id: "default",
        user_id: member.id,
        role: "editor",
      })
    }
  })

  it("cancels queued work when pilot access is removed without reviving it on restoration", async () => {
    const f = await setup()
    config.pilotWorkspaceIds.clear()
    try {
      await pass()
      expect((await meta.getRun(f.run.id))?.status).toBe("failed")
      expect(await meta.getLatestRunAttempt(f.run.id, "default")).toBeNull()
    } finally {
      config.pilotWorkspaceIds.add("default")
    }
    await pass()
    expect(f.sandbox.starts).toBe(0)
  })

  it("refuses a guest claim after pilot access is removed and cleans up its machine", async () => {
    const f = await launched()
    config.pilotWorkspaceIds.clear()
    try {
      expect((await attemptRequest(f.sandbox, "claim")).status).toBe(403)
      expect((await meta.getLatestRunAttempt(f.run.id, "default"))?.runner_claimed_at).toBeNull()
      for (let i = 0; i < 5; i++) await pass()
      expect(f.sandbox.state).toBe("stopped")
      expect((await meta.getRun(f.run.id))?.status).toBe("failed")
    } finally {
      config.pilotWorkspaceIds.add("default")
    }
  })

  it.each([
    "rollout",
    "controller",
  ])("revokes claimed tool access after %s withdrawal but accepts results and saves", async (withdrawal) => {
    const f = await launched()
    expect((await attemptRequest(f.sandbox, "claim")).status).toBe(200)
    // An unknown tool reaches the grant check, then the tool allowlist.
    expect((await attemptRequest(f.sandbox, "tool", { tool: "anything" })).status).toBe(403)
    if (withdrawal === "rollout") config.pilotWorkspaceIds.clear()
    else await meta.setConnectionStatus(f.connection.id, "default", "revoked")
    try {
      expect((await attemptRequest(f.sandbox, "claim")).status).toBe(403)
      const denied = await attemptRequest(f.sandbox, "tool", { tool: "anything" })
      expect(denied.status).toBe(403)
      expect(await denied.text()).toContain("Runtime access has been revoked")
      expect((await attemptRequest(f.sandbox, "result", result)).status).toBe(200)
      for (let i = 0; i < 5; i++) await pass()
      expect(f.sandbox.state).toBe("stopped")
      expect((await meta.getRun(f.run.id))?.status).toBe("succeeded")
    } finally {
      config.pilotWorkspaceIds.add("default")
    }
  })

  it("validates schedule permissions, timezone, and concurrent edits", async () => {
    const f = await scheduled()
    expect(
      (await saveSchedule(f.context.id, { ...dailyTask, revision: 0 }, member.email)).status,
    ).toBe(403)
    expect(
      (await saveSchedule(f.context.id, { ...dailyTask, revision: 0, cron: "* * * * * *" })).status,
    ).toBe(400)
    expect(
      (await saveSchedule(f.context.id, { ...dailyTask, revision: 0, timezone: "Nowhere/Invalid" }))
        .status,
    ).toBe(400)
    const responses = await Promise.all(
      [0, 1].map(() => saveSchedule(f.context.id, { ...dailyTask, revision: 0, enabled: false })),
    )
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect((await meta.getAutomation(f.schedule.id))?.revision).toBe(1)
    expect(
      nextRuntimeOccurrence("0 9 * * *", "America/New_York", new Date("2026-03-07T15:00:00Z")),
    ).toBe("2026-03-08T13:00:00.000Z")
    await meta.setMembership({
      id: "runtime-owner-seat",
      org_id: "default",
      user_id: owner.id,
      role: "owner",
    })
    expect(
      (
        await app.request(`/v1/automations/${f.schedule.id}`, {
          ...jsonAs(as(owner.email), { enabled: false }),
          method: "PATCH",
        })
      ).status,
    ).toBe(404)
    await meta.setMembership({
      id: "runtime-owner-seat",
      org_id: "default",
      user_id: owner.id,
      role: "editor",
    })
  })

  it("coalesces missed times and concurrent ticks, and cancels old queued work on edit", async () => {
    const f = await scheduled()
    await materializeAllDueRuns(meta, now, true)
    expect(await meta.latestRunForAutomation(f.schedule.id, "schedule")).toBeNull()
    now = new Date(now.getTime() + 3 * 3600_000)
    await Promise.all(
      [0, 1, 2].map(() => materializeRuntimeSchedules(meta, now, config.pilotWorkspaceIds)),
    )
    const first = await meta.latestRunForAutomation(f.schedule.id, "schedule")
    expect(first).toMatchObject({
      runtime_id: f.schedule.runtime_id,
      initiated_by: owner.id,
      scheduled_for: now.toISOString(),
    })
    expect(JSON.parse(first?.input_snapshot ?? "null")).toMatchObject({
      instruction: dailyTask.instruction,
      schedule_revision: 0,
    })
    now = new Date(now.getTime() + 3600_000)
    await materializeRuntimeSchedules(meta, now, config.pilotWorkspaceIds)
    expect((await meta.latestRunForAutomation(f.schedule.id, "schedule"))?.id).toBe(first?.id)
    expect(
      (
        await saveSchedule(f.context.id, {
          ...dailyTask,
          instruction: "Updated task",
          revision: 0,
          enabled: false,
        })
      ).status,
    ).toBe(200)
    await pass()
    expect(f.sandbox.starts).toBe(0)
    expect(first && (await meta.getRun(first.id))?.status).toBe("failed")
    expect((await meta.getAutomation(f.schedule.id))?.instruction).toBe("Updated task")
  })

  it("explains gated and failed schedule admission without logging task or driver contents", async () => {
    const f = await scheduled()
    const info = vi.spyOn(log, "info").mockImplementation(() => {})
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    const privateError = "private task and database parameter contents"
    try {
      const settings = await meta.getOrgSettings("default")
      await meta.setOrgSettings("default", { ...settings, automateBeta: false })
      await materializeRuntimeSchedules(meta, now, config.pilotWorkspaceIds)
      expect(await meta.latestRunForAutomation(f.schedule.id, "schedule")).toBeNull()
      expect(info).toHaveBeenCalledWith(
        "runtime schedule skipped",
        expect.objectContaining({ automation: f.schedule.id, reason: "automations_disabled" }),
      )
      await meta.setOrgSettings("default", settings)
      const create = vi.spyOn(meta, "createRun").mockImplementationOnce(async () => {
        throw new Error(privateError, {
          cause: Object.assign(new Error(privateError), { code: "42P01" }),
        })
      })
      // Keep this failure on the selected schedule even if another test left a definition.
      const list = vi.spyOn(meta, "listRuntimeSchedules").mockResolvedValue([f.schedule])
      try {
        await materializeRuntimeSchedules(meta, now, config.pilotWorkspaceIds)
        expect(await meta.latestRunForAutomation(f.schedule.id, "schedule")).toBeNull()
        expect(warn).toHaveBeenCalledWith(
          "runtime schedule admission deferred",
          expect.objectContaining({ automation: f.schedule.id, stage: "insert", reason: "schema" }),
        )
        const recovered = await materializeRuntimeSchedules(meta, now, config.pilotWorkspaceIds)
        expect(recovered).toEqual({ schedules: 1, admitted: 1, skipped: {} })
        expect(await meta.latestRunForAutomation(f.schedule.id, "schedule")).toMatchObject({
          status: "queued",
          scheduled_for: now.toISOString(),
        })
        expect(await materializeRuntimeSchedules(meta, now, config.pilotWorkspaceIds)).toEqual({
          schedules: 1,
          admitted: 0,
          skipped: { already_admitted: 1 },
        })
        const recorded = JSON.stringify([info.mock.calls, warn.mock.calls])
        expect(recorded).not.toContain(privateError)
        expect(recorded).not.toContain(dailyTask.instruction)
        expect(recorded).not.toContain(f.connection.secret_enc)
      } finally {
        create.mockRestore()
        list.mockRestore()
      }
    } finally {
      info.mockRestore()
      warn.mockRestore()
      await saveSchedule(f.context.id, { ...dailyTask, revision: 0, enabled: false })
    }
  })

  it("rejects a launched but unclaimed task after pause and still shuts down", async () => {
    const f = await scheduled()
    for (let i = 0; i < 4; i++) await pass()
    expect(f.sandbox.starts).toBe(1)
    expect(
      (await saveSchedule(f.context.id, { ...dailyTask, revision: 0, enabled: false })).status,
    ).toBe(200)
    expect((await attemptRequest(f.sandbox, "claim")).status).toBe(403)
    for (let i = 0; i < 5; i++) await pass()
    expect(f.sandbox.state).toBe("stopped")
    expect((await meta.latestRunForAutomation(f.schedule.id, "schedule"))?.status).toBe("failed")
  })

  it("allows a claimed scheduled job to report and save after the schedule is paused", async () => {
    const f = await scheduled()
    for (let i = 0; i < 4; i++) await pass()
    expect(f.sandbox.starts).toBe(1)
    expect((await attemptRequest(f.sandbox, "claim")).status).toBe(200)
    expect(
      (await saveSchedule(f.context.id, { ...dailyTask, revision: 0, enabled: false })).status,
    ).toBe(200)
    expect((await attemptRequest(f.sandbox, "result", result)).status).toBe(200)
    for (let i = 0; i < 5; i++) await pass()
    const run = await meta.latestRunForAutomation(f.schedule.id, "schedule")
    expect(run?.status).toBe("succeeded")
    expect(f.sandbox.state).toBe("stopped")
    expect(run && (await meta.getLatestRunAttempt(run.id, "default"))?.save_status).toBe("saved")
    now = new Date(now.getTime() + 24 * 3600_000)
    await pass()
    expect(f.sandbox.starts).toBe(1)
  })

  it("repairs shutdown before schedule scanning, even when that scan fails", async () => {
    const f = await launched()
    await attemptRequest(f.sandbox, "claim")
    await attemptRequest(f.sandbox, "result", result)
    await pass() // Enter stopping.
    let stateAtScan: string | undefined
    const scan = vi.spyOn(meta, "listRuntimeSchedules").mockImplementationOnce(async () => {
      stateAtScan = f.sandbox.state
      throw new Error("Schedule query unavailable")
    })
    try {
      await expect(pass()).rejects.toThrow("Schedule query unavailable")
      expect(stateAtScan).toBe("stopped")
    } finally {
      scan.mockRestore()
    }
    for (let i = 0; i < 5; i++) await pass()
    expect((await meta.getRun(f.run.id))?.status).toBe("succeeded")
  })

  it("runs once, receives a private report, confirms shutdown, and reuses the same sandbox", async () => {
    const f = await launched()
    const claim = await attemptRequest(f.sandbox, "claim")
    expect(claim.status).toBe(200)
    expect((await claim.json()).claimed).toBe(true)
    expect((await (await attemptRequest(f.sandbox, "claim")).json()).claimed).toBe(false)
    expect(
      (
        await app.request(
          "/v1/contexts",
          jsonAs({ Authorization: `Bearer ${f.sandbox.token}` }, { name: "must not manage" }),
        )
      ).status,
    ).toBe(403)
    expect((await attemptRequest(f.sandbox, "result", result)).status).toBe(200)
    expect(
      (await attemptRequest(f.sandbox, "result", { ...result, summary: "conflicting" })).status,
    ).toBe(409)
    for (let i = 0; i < 5; i++) await pass()
    const settled = await meta.getRun(f.run.id)
    expect(settled?.status).toBe("succeeded")
    const reportId = JSON.parse(settled?.meta ?? "{}").runtime.report_short_id
    const artifact = await meta.getByShortId(reportId)
    expect(artifact).toMatchObject({
      workspace_access: "none",
      link_role: "none",
      current_version: 1,
    })
    expect(artifact && (await meta.getArtifactMember(artifact.id, owner.id))).toMatchObject({
      role: "owner",
    })
    expect(f.sandbox.state).toBe("stopped")
    expect((await meta.getLatestRunAttempt(f.run.id, "default"))?.save_status).toBe("saved")
    expect((await attemptRequest(f.sandbox, "result", result)).status).toBe(200)
    expect((await attemptRequest(f.sandbox, "tool", { tool: "anything" })).status).toBe(409)
    const next = await app.request(
      `/v1/contexts/${f.context.id}/runtime/runs`,
      jsonAs(as(owner.email), { instruction: "Check the next day", provider: "codex" }),
    )
    expect(next.status).toBe(201)
    await pass()
    await pass()
    await pass()
    expect(f.sandbox.starts).toBe(2)
    // End this second run so the shared fixture never contributes an active owner to later tests.
    await attemptRequest(f.sandbox, "claim")
    await attemptRequest(f.sandbox, "result", result)
    for (let i = 0; i < 5; i++) await pass()
  })

  it("launches ready work and settles a saved result without waiting for another timer tick", async () => {
    pokeRuntime.mockClear()
    const f = await setup()
    expect(pokeRuntime).toHaveBeenCalledTimes(1)
    await Promise.all([pass(), pass()])
    expect(f.sandbox.starts).toBe(1)
    expect((await attemptRequest(f.sandbox, "claim")).status).toBe(200)
    pokeRuntime.mockClear()
    expect((await attemptRequest(f.sandbox, "result", result)).status).toBe(200)
    expect(pokeRuntime).toHaveBeenCalledTimes(1)
    await pass()
    expect(await meta.getRun(f.run.id)).toMatchObject({ status: "succeeded" })
    expect(await meta.getLatestRunAttempt(f.run.id, "default")).toMatchObject({
      phase: "released",
      save_status: "saved",
    })
    expect(f.sandbox.state).toBe("stopped")
  })

  it("does not launch twice under concurrent controller passes or a lost launch response", async () => {
    const f = await setup()
    f.sandbox.loseLaunch = true
    await pass()
    await pass()
    await Promise.all([pass(), pass(), pass()])
    expect(f.sandbox.starts).toBe(1)
    await pass()
    expect(f.sandbox.starts).toBe(1)
    now = new Date(now.getTime() + 16 * 60_000)
    for (let i = 0; i < 5; i++) await pass()
    expect(f.sandbox.starts).toBe(1)
    expect(f.sandbox.state).toBe("stopped")
    expect((await meta.getRun(f.run.id))?.status).toBe("failed")
  })

  it("keeps a received report and ownership while shutdown is unavailable", async () => {
    const f = await launched()
    await attemptRequest(f.sandbox, "claim")
    await attemptRequest(f.sandbox, "result", result)
    f.sandbox.stopFails = true
    await pass()
    await pass()
    expect(await meta.getLatestRunAttempt(f.run.id, "default")).toMatchObject({
      phase: "stopping",
      released_at: null,
      result_json: JSON.stringify(result),
    })
    expect((await meta.getRun(f.run.id))?.status).toBe("running")
    f.sandbox.stopFails = false
    for (let i = 0; i < 4; i++) await pass()
    expect((await meta.getRun(f.run.id))?.status).toBe("succeeded")
  })

  it("does not deliver a removed secret or newly added grants to a queued run", async () => {
    const f = await setup(true)
    await meta.setContextEnvironment(f.context.id, null)
    await pass()
    await pass()
    await pass()
    expect((await attemptRequest(f.sandbox, "claim")).status).toBe(409)
    expect((await meta.getLatestRunAttempt(f.run.id, "default"))?.runner_claimed_at).toBeNull()
    await app.request(`/v1/contexts/${f.context.id}/runtime/disable`, jsonAs(as(owner.email), {}))
    for (let i = 0; i < 5; i++) await pass()
  })

  it("honors disable and keeps attempt tokens out of other runs", async () => {
    const f = await setup()
    const denied = await app.request(`/v1/contexts/${f.context.id}/runtime`, {
      headers: as(member.email),
    })
    expect(denied.status).toBe(403)
    await pass()
    await pass()
    await pass()
    expect(
      (
        await app.request(
          "/v1/runtime-attempts/someone_else/claim",
          jsonAs({ Authorization: `Bearer ${f.sandbox.token}` }, {}),
        )
      ).status,
    ).toBe(401)
    await app.request(`/v1/contexts/${f.context.id}/runtime/disable`, jsonAs(as(owner.email), {}))
    expect((await attemptRequest(f.sandbox, "claim")).status).toBe(403)
    for (let i = 0; i < 5; i++) await pass()
    expect(f.sandbox.state).toBe("stopped")
  })
})

describe("runtime provisioning and shared model accounts", () => {
  const owner: TestUser = { id: "setup-owner", email: "setup@derive.test", name: "Operator" }
  const member: TestUser = { id: "setup-member", email: "setup-member@derive.test", name: "Member" }
  const config = {
    apiUrl: "https://ortam.test/v1",
    runnerPath: SETUP_RUNNER_PATH,
    pilotWorkspaceIds: new Set(["default"]),
    managed: { apiKey: "service integration fixture", workspaceIds: new Set<string>() },
  }
  let count = 0
  let now = new Date()
  let loseCreate = false
  let loseDelete = false
  let failSetup = false
  let pendingSetup = false
  let failDelete = false
  let authStatus = 200
  let sandboxStatus = 200
  let modelActive = true
  let loseAttachment = false
  const disconnectedSubjects = new Set<string | null>()
  const launched = new Map<string, { token: string; attempt: string }>()
  const creates = new Map<
    string,
    {
      body: string
      sandbox: {
        id: string
        state: string
        version: number
        current_operation_id: null
        auto_stop_after_seconds: number
        agent_connections: { user_id: string } | null
      }
      operation: { id: string; sandbox_id: string; kind: string; state: string }
    }
  >()
  const operations = new Map<
    string,
    { id: string; sandbox_id: string; kind: string; state: string }
  >()
  const peer: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/v1", "")
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? ""
    if (path === "/auth/token") {
      if (authStatus !== 200) return new Response(null, { status: authStatus })
      return json({
        token: `header.${Buffer.from(JSON.stringify({ sub: "ortam-owner", organization_id: "ortam-org" })).toString("base64url")}.signature`,
      })
    }
    const subject = new Headers(init?.headers).get("X-Ortam-Integration-Subject")
    if (path === "/integration") {
      expect(subject).toMatch(/^[a-f0-9]{64}$/)
      return json({ organization_id: "ortam-org", user_id: `integration:${subject}` })
    }
    if (path === "/agents")
      return json({
        items:
          modelActive && !disconnectedSubjects.has(subject)
            ? [{ harness: "codex", status: "active", identity: { email: "model@example.test" } }]
            : [],
      })
    if (path === "/agents/codex/sign-in")
      return json({
        id: "attempt-fixture",
        state: "pending",
        user_code: "ABCD-1234",
        verification_url: "https://auth.openai.com/codex/device",
        authorize_url: null,
        expires_at: new Date(Date.now() + 600000).toISOString(),
      })
    if (path === "/agents/codex" && init?.method === "DELETE") {
      disconnectedSubjects.add(subject)
      return new Response(null, { status: 204 })
    }
    if (path === "/sandboxes" && init?.method === "POST") {
      let saved = creates.get(key)
      if (!saved) {
        const id = `sbx_${String(++count).padStart(26, "0")}`
        const body = JSON.parse(String(init.body))
        expect(body).toMatchObject({ size: "small", auto_stop_after_seconds: 1200 })
        expect(body.name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/)
        expect(body.setup_script).toContain("--save-exact @derive-to/cli@0.7.0")
        expect(body.agent_connections).toBe(subject ? true : undefined)
        saved = {
          body: String(init.body),
          sandbox: {
            id,
            state: "ready",
            version: 1,
            current_operation_id: null,
            auto_stop_after_seconds: 1200,
            agent_connections: subject ? { user_id: `integration:${subject}` } : null,
          },
          operation: {
            id: `create-${id}`,
            sandbox_id: id,
            kind: "create",
            state: failSetup ? "failed" : pendingSetup ? "running" : "succeeded",
          },
        }
        creates.set(key, saved)
        operations.set(saved.operation.id, saved.operation)
      }
      expect(String(init.body)).toBe(saved.body)
      if (loseCreate) {
        loseCreate = false
        throw new Error("lost accepted response")
      }
      return json(saved)
    }
    if (path.startsWith("/operations/")) return json(operations.get(path.split("/")[2] ?? ""))
    const saved = [...creates.values()].find((x) => x.sandbox.id === path.split("/")[2])
    if (!saved) throw new Error("Unexpected sandbox request")
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body))
      if (body.expected_version !== saved.sandbox.version || saved.sandbox.state !== "stopped")
        return new Response(null, { status: 409 })
      const userId = `integration:${subject}`
      if (saved.sandbox.agent_connections && saved.sandbox.agent_connections.user_id !== userId)
        return new Response(null, { status: 403 })
      saved.sandbox.agent_connections = body.agent_connections ? { user_id: userId } : null
      saved.sandbox.version++
      if (loseAttachment) {
        loseAttachment = false
        throw new Error("lost accepted attachment response")
      }
      return json(saved.sandbox)
    }
    if (path.endsWith("/processes")) {
      if (subject) expect(saved.sandbox.agent_connections?.user_id).toBe(`integration:${subject}`)
      const body = JSON.parse(String(init?.body))
      expect(JSON.stringify(body)).not.toContain(config.managed.apiKey)
      launched.set(saved.sandbox.id, {
        token: body.env.DERIVE_TOKEN,
        attempt: body.env.DERIVE_ATTEMPT_ID,
      })
      return json({ id: `process-${saved.sandbox.id}`, status: "running" })
    }
    if (path.includes("/processes/"))
      return json({ id: `process-${saved.sandbox.id}`, status: "running" })
    if (path.endsWith("/resume") || path.endsWith("/stop") || init?.method === "DELETE") {
      const kind =
        init?.method === "DELETE" ? "delete" : path.endsWith("/resume") ? "resume" : "stop"
      if (kind === "delete")
        expect(new Headers(init?.headers).get("X-Ortam-Confirm-Delete")).toBe(saved.sandbox.id)
      let op = operations.get(key)
      if (!op) {
        op = {
          id: `${kind}-${saved.sandbox.id}`,
          sandbox_id: saved.sandbox.id,
          kind,
          state: kind === "delete" && failDelete ? "failed" : "succeeded",
        }
        operations.set(key, op)
        operations.set(op.id, op)
        if (op.state === "succeeded") {
          saved.sandbox.state =
            kind === "delete" ? "deleted" : kind === "resume" ? "ready" : "stopped"
          saved.sandbox.version++
        }
      }
      if (kind === "delete" && loseDelete) {
        loseDelete = false
        throw new Error("lost delete response")
      }
      return json(op)
    }
    if (sandboxStatus !== 200) return new Response(null, { status: sandboxStatus })
    if (saved.sandbox.state === "deleted") return new Response(null, { status: 404 })
    return json(saved.sandbox)
  }
  const pokeRuntime = vi.fn()
  const { app, meta, ctx } = makeAuthedApp("runtime-provisioning", [owner, member], "editor", {
    operatorIds: [owner.id],
    deps: { encryptionKey: SECRET, runtime: config, runtimeFetch: peer, pokeRuntime },
  })
  const pass = () =>
    runtimeDispatchPass({
      meta,
      blobs: ctx.blobs,
      secret: SECRET,
      server: "http://derive.test",
      config,
      fetcher: peer,
      now: () => now,
      pokeRuntime,
    })
  async function fixture() {
    now = new Date()
    config.managed.workspaceIds.clear()
    modelActive = true
    loseAttachment = false
    loseCreate = false
    loseDelete = false
    failSetup = false
    pendingSetup = false
    failDelete = false
    authStatus = 200
    sandboxStatus = 200
    config.pilotWorkspaceIds.add("default")
    const settings = await meta.getOrgSettings("default")
    await meta.setOrgSettings("default", {
      ...settings,
      hostedAgentsEnabled: true,
      agentWrites: true,
    })
    const manifest = await (
      await publishAs(app, "# Setup", { title: `Setup ${++count}` }, as(owner.email))
    ).json()
    const context = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), { name: `Setup ${count}`, manifest_short_id: manifest.short_id }),
      )
    ).json()
    const connection = await meta.createConnection({
      id: `setup-connection-${count}`,
      org_id: "default",
      user_id: owner.id,
      kind: "secret",
      broker: "none",
      toolkit: "ortam",
      broker_ref: `setup-${count}`,
      status: "active",
      secret_enc: encryptSecret("setup controller fixture", SECRET),
    })
    const path = `/v1/contexts/${context.id}/runtime`
    const submit = () =>
      app.request(`${path}/setup`, jsonAs(as(owner.email), { connection_id: connection.id }))
    const state = () => meta.getRuntimeSetup(context.id, "default")
    const cancel = () => app.request(`${path}/setup/cancel`, jsonAs(as(owner.email), {}))
    return { context, connection, path, submit, state, cancel }
  }
  it("replays lost creation, stops before binding, and waits for the operator's model consent", async () => {
    const f = await fixture()
    const before = creates.size
    expect((await f.submit()).status).toBe(202)
    expect((await f.submit()).status).toBe(200)
    loseCreate = true
    await pass() // accepted, response lost
    expect((await f.state())?.phase).toBe("creating")
    await pass() // same request/key recovers receipt
    expect(creates.size).toBe(before + 1)
    await pass()
    await pass()
    await pass()
    expect((await f.state())?.phase).toBe("awaiting_connection")
    await pass()
    expect(await meta.getContextRuntimeForContext(f.context.id, "default")).toBeNull()
    const saved = creates.get(`derive-${(await f.state())?.id}-create`)
    if (!saved) throw new Error("Missing created sandbox")
    expect(saved.sandbox.state).toBe("stopped")
    saved.sandbox.agent_connections = { user_id: "another-user" }
    await pass()
    expect(await meta.getContextRuntimeForContext(f.context.id, "default")).toBeNull()
    saved.sandbox.agent_connections = { user_id: "ortam-owner" }
    await pass()
    await pass()
    await pass()
    expect((await f.state())?.phase).toBe("ready")
    expect(await meta.getContextRuntimeForContext(f.context.id, "default")).toMatchObject({
      sandbox_id: saved.sandbox.id,
      connection_id: f.connection.id,
    })
    expect((await f.cancel()).status).toBe(409)
    await pass()
    expect(saved.sandbox.state).toBe("stopped")
  })
  it("denies setup to nonoperators and prevents a manual binding from overtaking setup", async () => {
    const f = await fixture()
    expect(
      (
        await app.request(
          `${f.path}/setup`,
          jsonAs(as(member.email), { connection_id: f.connection.id }),
        )
      ).status,
    ).toBe(403)
    await f.submit()
    const state = await (await app.request(f.path, { headers: as(member.email) })).json()
    expect(state.setup).toBeUndefined()
    await pass()
    await pass()
    const setup = await f.state()
    expect(
      await meta.createContextRuntime(
        {
          id: "steal-setup",
          org_id: "default",
          context_id: f.context.id,
          agent_id: f.context.agent_id,
          api_url: config.apiUrl,
          ortam_org_id: "ortam-org",
          ortam_user_id: "ortam-owner",
          sandbox_id: setup?.sandbox_id ?? "",
          connection_id: f.connection.id,
        },
        now.toISOString(),
      ),
    ).toBeNull()
    await f.cancel()
    for (let i = 0; i < 4; i++) await pass()
    expect((await f.state())?.phase).toBe("failed")
  })
  it("cancels before submission without creating compute", async () => {
    const f = await fixture()
    await f.submit()
    await f.cancel()
    const before = creates.size
    await pass()
    expect(creates.size).toBe(before)
    expect((await f.state())?.phase).toBe("failed")
  })
  it("resolves an ambiguous create and cleans up after cancellation and rollout removal", async () => {
    const f = await fixture()
    await f.submit()
    loseCreate = true
    await pass()
    await f.cancel()
    config.pilotWorkspaceIds.clear()
    await meta.setConnectionStatus(f.connection.id, "default", "revoked")
    loseDelete = true
    await pass()
    expect((await f.state())?.phase).toBe("deleting")
    await pass()
    await pass()
    expect((await f.state())?.phase).toBe("failed")
    expect(await meta.getContextRuntimeForContext(f.context.id, "default")).toBeNull()
  })
  it("deletes a failed installation and retains ownership when deletion fails", async () => {
    const f = await fixture()
    await f.submit()
    failSetup = true
    failDelete = true
    await pass()
    await pass()
    await pass()
    await pass()
    expect((await f.state())?.phase).toBe("deleting")
    const opId = (await f.state())?.delete_operation_id
    const op = operations.get(opId ?? "")
    if (!op) throw new Error("Missing deletion operation")
    expect(op.state).toBe("failed")
    // Neither an auth 404 nor a sandbox permission/server failure proves deletion.
    authStatus = 404
    await pass()
    expect((await f.state())?.phase).toBe("deleting")
    authStatus = 200
    for (const status of [403, 503]) {
      sandboxStatus = status
      await pass()
      expect((await f.state())?.phase).toBe("deleting")
    }
    sandboxStatus = 200
    const saved = creates.get(`derive-${(await f.state())?.id}-create`)
    if (!saved) throw new Error("Missing created sandbox")
    saved.sandbox.state = "deleted" // Ortam's reconciler finishes cleanup; operation stays failed.
    await pass()
    expect(op.state).toBe("failed")
    expect((await f.state())?.phase).toBe("failed")
  })
  it("recognizes an operator deletion before submitting its own delete request", async () => {
    const f = await fixture()
    await f.submit()
    for (let i = 0; i < 6; i++) await pass()
    expect((await f.state())?.phase).toBe("awaiting_connection")
    const saved = creates.get(`derive-${(await f.state())?.id}-create`)
    if (!saved) throw new Error("Missing created sandbox")
    saved.sandbox.state = "deleted"
    await f.cancel()
    await pass()
    await pass()
    expect(await f.state()).toMatchObject({ phase: "failed", delete_operation_id: null })
    expect(await meta.getContextRuntimeForContext(f.context.id, "default")).toBeNull()
  })
  it("expires unclaimed setup and still cleans up after the Context is deleted", async () => {
    const f = await fixture()
    await f.submit()
    for (let i = 0; i < 6; i++) await pass()
    expect((await f.state())?.phase).toBe("awaiting_connection")
    now = new Date(Date.parse((await f.state())?.deadline_at ?? "") + 1000)
    loseDelete = true
    await pass()
    expect((await f.state())?.phase).toBe("deleting")
    await meta.deleteContext(f.context.id, "default")
    await pass()
    await pass()
    expect((await f.state())?.phase).toBe("failed")
  })
  const modelAccount = async (contextId: string, existingId?: string) => {
    config.managed.workspaceIds.add("default")
    const created = existingId
      ? null
      : await app.request(
          "/v1/runtime-model-connections",
          jsonAs(as(owner.email), { name: "Shared work account", provider: "codex" }),
        )
    if (created) expect(created.status).toBe(201)
    const model = existingId ? { id: existingId } : await created?.json()
    const selection = await app.request(`/v1/contexts/${contextId}/runtime/model-connection`, {
      ...jsonAs(as(owner.email), { connection_id: model.id, revision: null }),
      method: "PUT",
    })
    expect(selection.status).toBe(200)
    return model as { id: string }
  }
  async function managedJob(existingId?: string) {
    const f = await fixture()
    const model = await modelAccount(f.context.id, existingId)
    const settings = await meta.getOrgSettings("default")
    await meta.setOrgSettings("default", { ...settings, automateBeta: true })
    expect((await app.request(`${f.path}/setup`, jsonAs(as(owner.email), {}))).status).toBe(202)
    for (let i = 0; i < 9; i++) await pass()
    const runtime = await meta.getContextRuntimeForContext(f.context.id, "default")
    const saved = creates.get(`derive-${(await f.state())?.id}-create`)
    if (!runtime || !saved) throw new Error("Managed fixture was not provisioned")
    expect(
      (
        await app.request(`${f.path}/schedule`, {
          ...jsonAs(as(owner.email), {
            instruction: "Check saved files",
            provider: "codex",
            cron: "0 9 * * *",
            timezone: "UTC",
            enabled: true,
            revision: null,
          }),
          method: "PUT",
        })
      ).status,
    ).toBe(200)
    const select = (connectionId: string | null, revision: number | null) =>
      app.request(`${f.path}/model-connection`, {
        ...jsonAs(as(owner.email), { connection_id: connectionId, revision }),
        method: "PUT",
      })
    const fire = async () => {
      const response = await app.request(`${f.path}/runs`, jsonAs(as(owner.email), {}))
      expect(response.status).toBe(201)
      return (await response.json()).run as { id: string; input_snapshot: string }
    }
    return { ...f, model, runtime, sandbox: saved.sandbox, select, fire }
  }

  it("creates a private cloud workflow from Workflows with a saved account and no runner token", async () => {
    const f = await fixture()
    const model = await modelAccount(f.context.id)
    const response = await app.request(
      "/v1/workflow-runtimes",
      jsonAs(as(owner.email), { name: `Workflow ${count}`, model_connection_id: model.id }),
    )
    expect(response.status).toBe(201)
    const created = await response.json()
    expect(Object.keys(created)).toEqual(["id"])
    const context = await meta.getContext(created.id)
    expect(context).toMatchObject({ created_by: owner.id, ask_policy: "invited" })
    expect(await meta.getRuntimeModelBinding(created.id, "default")).toMatchObject({
      model_connection_id: model.id,
    })
    expect(await meta.getRuntimeSetup(created.id, "default")).toBeNull()
    if (!context) throw new Error("Workflow Context was not saved")
    const manifest = await meta.getArtifactById(context.manifest_artifact_id)
    expect(manifest).toMatchObject({ workspace_access: "none", link_role: "none", listed: "none" })
    const ownList = await (
      await app.request("/v1/workflow-runtimes", { headers: as(owner.email) })
    ).json()
    expect(ownList.items).toContainEqual(expect.objectContaining({ id: created.id, ready: false }))
    const otherList = await (
      await app.request("/v1/workflow-runtimes", { headers: as(member.email) })
    ).json()
    expect(otherList.items.some((item: { id: string }) => item.id === created.id)).toBe(false)
    expect(
      (
        await app.request(
          "/v1/workflow-runtimes",
          jsonAs(as(member.email), { name: "Stolen account", model_connection_id: model.id }),
        )
      ).status,
    ).toBe(400)
    config.managed.workspaceIds.clear()
    expect(
      (
        await app.request(
          "/v1/workflow-runtimes",
          jsonAs(as(owner.email), { name: "Outside pilot", model_connection_id: model.id }),
        )
      ).status,
    ).toBe(403)
  })

  it("runs a saved cloud workflow on demand with automation disabled and after pausing its schedule", async () => {
    for (const cron of [null, "0 9 * * *"]) {
      const f = await managedJob()
      await meta.setOrgSettings("default", {
        ...(await meta.getOrgSettings("default")),
        automateBeta: false,
      })
      const saved = await app.request(`${f.path}/schedule`, {
        ...jsonAs(as(owner.email), {
          instruction: "Check saved files",
          provider: "codex",
          cron,
          timezone: "UTC",
          enabled: cron === null,
          revision: 0,
        }),
        method: "PUT",
      })
      expect(saved.status).toBe(200)
      const definition = await saved.json()
      expect(JSON.parse(definition.schedule.trigger).kind).toBe(cron ? "schedule" : "manual")
      expect(definition.schedule.enabled).toBe(0)
      expect(definition.next_run_at).toBeNull()
      const run = await f.fire()
      const stored = await meta.getRun(run.id)
      expect(stored).not.toBeNull()
      if (!stored) throw new Error("Manual run was not saved")
      expect(await runtimeScheduleAllows(meta, stored)).toBe(true)
      await pass()
      const task = launched.get(f.sandbox.id)
      if (!task) throw new Error("Manual workflow did not launch")
      const claim = await app.request(
        `/v1/runtime-attempts/${task.attempt}/claim`,
        jsonAs({ Authorization: `Bearer ${task.token}` }, {}),
      )
      expect(claim.status).toBe(200)
      expect(await claim.json()).toMatchObject({ input: { instruction: "Check saved files" } })
      // The selected account's access still governs a manual run.
      expect((await f.select(null, 0)).status).toBe(200)
      await pass()
      expect((await meta.getRun(run.id))?.status).toBe("failed")
    }
  })

  it("links private cloud reports only for their readers, including in workspace history", async () => {
    const f = await managedJob()
    const run = await f.fire()
    await pass()
    const task = launched.get(f.sandbox.id)
    if (!task) throw new Error("Workflow did not launch")
    const auth = { Authorization: `Bearer ${task.token}` }
    expect(
      (await app.request(`/v1/runtime-attempts/${task.attempt}/claim`, jsonAs(auth, {}))).status,
    ).toBe(200)
    expect(
      (
        await app.request(
          `/v1/runtime-attempts/${task.attempt}/result`,
          jsonAs(auth, {
            version: 1,
            outcome: "completed",
            summary: "Private workflow findings",
            outputs: [],
          }),
        )
      ).status,
    ).toBe(200)
    for (let i = 0; i < 5; i++) await pass()
    const saved = await meta.getRun(run.id)
    if (!saved) throw new Error("Run was not saved")
    const reportId = JSON.parse(saved?.meta ?? "{}").runtime.report_short_id
    expect(reportId).toBeTruthy()
    await app.request(
      `/v1/contexts/${f.context.id}/access`,
      jsonAs(as(owner.email), { ask_policy: "workspace" }),
    )
    const ownerState = await (await app.request(f.path, { headers: as(owner.email) })).json()
    const ownRun = ownerState.runs.find((r: { id: string }) => r.id === run.id)
    expect(JSON.parse(ownRun.meta).runtime.report_short_id).toBe(reportId)
    const memberState = await (await app.request(f.path, { headers: as(member.email) })).json()
    const otherRun = memberState.runs.find((r: { id: string }) => r.id === run.id)
    expect(otherRun.attempt.result_json).toBeNull()
    expect(JSON.parse(otherRun.meta).runtime.report_short_id).toBeNull()
    expect(otherRun.input_snapshot).toBeNull()
    const seat = await meta.getMembership("default", member.id)
    if (!seat) throw new Error("Member seat missing")
    await meta.setMembership({ ...seat, role: "owner" })
    try {
      const history = await (
        await app.request("/v1/workspace/runs", { headers: as(member.email) })
      ).json()
      const listed = history.runs.find((r: { id: string }) => r.id === run.id)
      expect(listed.workflow_name).toBe(f.context.name)
      expect(JSON.parse(listed.meta).runtime.report_short_id).toBeNull()
      expect(JSON.stringify(listed)).not.toContain("Private workflow findings")
      // Legacy or malformed metadata must never fall back to exposing its arbitrary fields.
      const reads = vi.spyOn(meta, "listRuns")
      try {
        for (const receipt of [
          { summary: "Private workflow findings" },
          { runtime: "invalid", summary: "Private workflow findings" },
          { runtime: { outcome: { summary: "Private workflow findings" } } },
        ]) {
          reads.mockResolvedValue([{ ...saved, meta: JSON.stringify(receipt) }])
          const history = await app.request("/v1/workspace/runs", { headers: as(member.email) })
          expect(history.status).toBe(200)
          expect(await history.text()).not.toContain("Private workflow findings")
        }
      } finally {
        reads.mockRestore()
      }
    } finally {
      await meta.setMembership(seat)
    }
  })

  it("prepares a ready managed job in one pass while another installation is still pending", async () => {
    const waiting = await fixture()
    await modelAccount(waiting.context.id)
    pendingSetup = true
    pokeRuntime.mockClear()
    expect((await app.request(`${waiting.path}/setup`, jsonAs(as(owner.email), {}))).status).toBe(
      202,
    )
    expect(pokeRuntime).toHaveBeenCalledTimes(1)
    await pass()
    expect((await waiting.state())?.phase).toBe("provisioning")
    const ready = await fixture()
    await modelAccount(ready.context.id)
    expect((await app.request(`${ready.path}/setup`, jsonAs(as(owner.email), {}))).status).toBe(202)
    await pass()
    expect((await waiting.state())?.phase).toBe("provisioning")
    expect((await ready.state())?.phase).toBe("ready")
    expect(await meta.getContextRuntimeForContext(ready.context.id, "default")).toMatchObject({
      disabled_at: null,
    })
    const pending = creates.get(`derive-${(await waiting.state())?.id}-create`)
    if (!pending) throw new Error("Missing pending installation")
    pending.operation.state = "succeeded"
    await pass()
    expect((await waiting.state())?.phase).toBe("ready")
  })

  it("shares one account across isolated jobs, and removes one grant without revoking the other", async () => {
    const first = await managedJob()
    const second = await managedJob(first.model.id)
    expect(first.runtime.sandbox_id).not.toBe(second.runtime.sandbox_id)
    expect(first.runtime.ortam_user_id).toBe(second.runtime.ortam_user_id)
    const stale = await first.fire()
    expect(JSON.parse(stale.input_snapshot).model_connection).toEqual({
      id: first.model.id,
      revision: 0,
    })
    expect((await first.select(null, 0)).status).toBe(200)
    expect((await first.select(first.model.id, 1)).status).toBe(200)
    await pass()
    expect(await meta.getLatestRunAttempt(stale.id, "default")).toBeNull()
    expect(await meta.getRun(stale.id)).toMatchObject({ status: "failed" })
    expect((await first.select(null, 2)).status).toBe(200)
    expect((await app.request(`${first.path}/runs`, jsonAs(as(owner.email), {}))).status).toBe(409)
    expect(await meta.getRuntimeModelConnection(first.model.id, "default")).toMatchObject({
      revoked_at: null,
    })
    const run = await second.fire()
    for (let i = 0; i < 5; i++) await pass()
    const task = launched.get(second.sandbox.id)
    if (!task) throw new Error("Shared account did not launch")
    const headers = { Authorization: `Bearer ${task.token}`, "Content-Type": "application/json" }
    expect(
      (await app.request(`/v1/runtime-attempts/${task.attempt}/claim`, { method: "POST", headers }))
        .status,
    ).toBe(200)
    expect(
      (
        await app.request(`/v1/runtime-model-connections/${first.model.id}`, {
          method: "DELETE",
          headers: as(owner.email),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`/v1/runtime-attempts/${task.attempt}/tool`, {
          method: "POST",
          headers,
          body: JSON.stringify({ tool: "anything" }),
        })
      ).status,
    ).toBe(403)
    for (let i = 0; i < 5; i++) await pass()
    expect(second.sandbox.state).toBe("stopped")
    expect(await meta.getLatestRunAttempt(run.id, "default")).toMatchObject({
      phase: "released",
      save_status: "saved",
    })
  })

  it("switches a stopped machine without losing files or repeating a lost attachment response", async () => {
    const f = await managedJob()
    const created = await app.request(
      "/v1/runtime-model-connections",
      jsonAs(as(owner.email), { name: "Replacement account", provider: "codex" }),
    )
    const target = await created.json()
    expect((await f.select(target.id, 0)).status).toBe(200)
    const run = await f.fire()
    const originalId = f.sandbox.id
    const originalVersion = f.sandbox.version
    loseAttachment = true
    await pass() // detach committed, response lost
    expect(f.sandbox.agent_connections).toBeNull()
    expect(f.sandbox.state).toBe("stopped")
    loseAttachment = true
    await pass() // attach committed, response lost
    const account = await meta.getRuntimeModelConnection(target.id, "default")
    expect(f.sandbox.agent_connections?.user_id).toBe(account?.ortam_user_id)
    expect(f.sandbox.state).toBe("stopped")
    expect(f.sandbox.version).toBe(originalVersion + 2)
    await Promise.all([pass(), pass()])
    for (let i = 0; i < 4; i++) await pass()
    expect(f.sandbox.id).toBe(originalId)
    expect(await meta.getContextRuntime(f.runtime.id, "default")).toMatchObject({
      model_connection_id: target.id,
      ortam_user_id: account?.ortam_user_id,
    })
    const task = launched.get(f.sandbox.id)
    if (!task) throw new Error("Replacement account did not launch")
    const headers = { Authorization: `Bearer ${task.token}`, "Content-Type": "application/json" }
    // A changed grant cannot be claimed by a process launched under the previous selection.
    expect((await f.select(null, 1)).status).toBe(200)
    expect(
      (await app.request(`/v1/runtime-attempts/${task.attempt}/claim`, { method: "POST", headers }))
        .status,
    ).toBe(403)
    for (let i = 0; i < 5; i++) await pass()
    expect(f.sandbox.state).toBe("stopped")
    expect(await meta.getLatestRunAttempt(run.id, "default")).toMatchObject({ phase: "released" })
  })

  it("finishes ambiguous attachment cleanup without launching after the grant is withdrawn", async () => {
    const f = await managedJob()
    const target = await (
      await app.request(
        "/v1/runtime-model-connections",
        jsonAs(as(owner.email), { name: "Next account", provider: "codex" }),
      )
    ).json()
    await f.select(target.id, 0)
    const run = await f.fire()
    loseAttachment = true
    await pass()
    expect(f.sandbox.agent_connections).toBeNull()
    await f.select(null, 1)
    await meta.revokeRuntimeModelConnection(target.id, "default", now.toISOString())
    for (let i = 0; i < 6; i++) await pass()
    expect(launched.has(f.sandbox.id)).toBe(false)
    expect(f.sandbox.state).toBe("stopped")
    expect(await meta.getLatestRunAttempt(run.id, "default")).toMatchObject({ phase: "released" })
    expect(await meta.getContextRuntime(f.runtime.id, "default")).toMatchObject({
      model_connection_id: target.id,
    })
  })

  it("requires the account owner's grant even for a workspace administrator and rejects stale selection edits", async () => {
    const f = await managedJob()
    await meta.setMembership({
      id: "setup-member-seat",
      org_id: "default",
      user_id: member.id,
      role: "owner",
    })
    try {
      const before = await meta.getRuntimeModelBinding(f.context.id, "default")
      expect(
        (
          await app.request(`${f.path}/model-connection`, {
            ...jsonAs(as(member.email), { connection_id: f.model.id, revision: 0 }),
            method: "PUT",
          })
        ).status,
      ).toBe(404)
      expect(await meta.getRuntimeModelBinding(f.context.id, "default")).toEqual(before)
      expect((await f.select(f.model.id, null)).status).toBe(409)
      expect((await f.select(null, 0)).status).toBe(200)
      expect((await f.select(f.model.id, 0)).status).toBe(409)
      expect((await f.select(f.model.id, 1)).status).toBe(200)
      const run = await f.fire()
      await meta.setMembership({
        id: "setup-owner-seat",
        org_id: "default",
        user_id: owner.id,
        role: "viewer",
      })
      await pass()
      expect(await meta.getLatestRunAttempt(run.id, "default")).toBeNull()
    } finally {
      await meta.setMembership({
        id: "setup-owner-seat",
        org_id: "default",
        user_id: owner.id,
        role: "editor",
      })
      await meta.setMembership({
        id: "setup-member-seat",
        org_id: "default",
        user_id: member.id,
        role: "editor",
      })
    }
  })

  it("cleans up a withdrawn setup grant and disables a handover whose grant changed before projection", async () => {
    for (const committed of [false, true]) {
      const f = await fixture()
      await modelAccount(f.context.id)
      expect((await app.request(`${f.path}/setup`, jsonAs(as(owner.email), {}))).status).toBe(202)
      // Withdraw between two durable steps in the SAME pass, not between timer ticks.
      const transition = meta.transitionRuntimeSetup.bind(meta)
      let withdrawn = false
      const intercept = vi
        .spyOn(meta, "transitionRuntimeSetup")
        .mockImplementation(async (...args) => {
          const next = await transition(...args)
          if (
            next &&
            next.context_id === f.context.id &&
            next.phase === (committed ? "binding" : "awaiting_connection")
          ) {
            expect(
              (
                await app.request(`${f.path}/model-connection`, {
                  ...jsonAs(as(owner.email), { connection_id: null, revision: 0 }),
                  method: "PUT",
                })
              ).status,
            ).toBe(200)
            withdrawn = true
          }
          return next
        })
      try {
        await pass()
      } finally {
        intercept.mockRestore()
      }
      expect(withdrawn).toBe(true)
      const runtime = await meta.getContextRuntimeForContext(f.context.id, "default")
      if (committed) {
        expect(runtime?.disabled_at).toBeTruthy()
        expect((await f.state())?.phase).toBe("ready")
      } else {
        expect(runtime).toBeNull()
        expect((await f.state())?.phase).toBe("failed")
      }
    }
  })

  it("shares the configured job with authorized members without exposing its controller or allowing edits", async () => {
    const f = await fixture()
    config.managed.workspaceIds.add("default")
    config.pilotWorkspaceIds.clear()
    const settings = await meta.getOrgSettings("default")
    await meta.setOrgSettings("default", { ...settings, automateBeta: true })
    const model = await modelAccount(f.context.id)
    expect(
      (
        await app.request(
          `/v1/runtime-model-connections/${model.id}/sign-in`,
          jsonAs(as(member.email), {}),
        )
      ).status,
    ).toBe(404)
    const login = await app.request(
      `/v1/runtime-model-connections/${model.id}/sign-in`,
      jsonAs(as(owner.email), {}),
    )
    expect(login.status).toBe(202)
    expect(login.headers.get("Cache-Control")).toBe("no-store")
    expect(await login.json()).toMatchObject({ user_code: "ABCD-1234" })
    const started = await app.request(`${f.path}/setup`, jsonAs(as(owner.email), {}))
    expect(started.status).toBe(202)
    expect(JSON.stringify(await started.json())).not.toContain("ortam")
    for (let i = 0; i < 9; i++) await pass()
    const runtime = await meta.getContextRuntimeForContext(f.context.id, "default")
    expect(runtime).toMatchObject({ connection_id: null, disabled_at: null })
    expect((await app.request(`${f.path}/runs`, jsonAs(as(member.email), {}))).status).toBe(403)
    expect(
      (
        await app.request(`/v1/contexts/${f.context.id}/access`, {
          ...jsonAs(as(owner.email), { ask_policy: "workspace" }),
        })
      ).status,
    ).toBe(200)
    const status = await app.request(f.path, { headers: as(member.email) })
    expect(status.status).toBe(200)
    const state = await status.json()
    expect(state).toMatchObject({ managed: true, can_edit: false, runtime: { id: runtime?.id } })
    expect(state.runtime).not.toHaveProperty("sandbox_id")
    expect(state.setup).not.toHaveProperty("request_json")
    const definition = {
      instruction: "Use this job's tools and saved files",
      provider: "codex",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      revision: null,
    }
    expect(
      (
        await app.request(`${f.path}/schedule`, {
          ...jsonAs(as(member.email), definition),
          method: "PUT",
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(`${f.path}/schedule`, {
          ...jsonAs(as(owner.email), definition),
          method: "PUT",
        })
      ).status,
    ).toBe(200)
    const fired = await app.request(
      `${f.path}/runs`,
      jsonAs(as(member.email), { instruction: "Ignore the saved job", provider: "claude-code" }),
    )
    expect(fired.status).toBe(201)
    const { run } = await fired.json()
    expect(run.initiated_by).toBe(member.id)
    expect(run.automation_id).toBeTruthy()
    expect(JSON.parse(run.input_snapshot)).toMatchObject({
      instruction: definition.instruction,
      provider: "codex",
      schedule_revision: 0,
    })
    expect(await runtimeScheduleAllows(meta, run)).toBe(true)
    for (let i = 0; i < 6; i++) await pass()
    const task = launched.get(runtime?.sandbox_id ?? "")
    if (!task) throw new Error("Managed job was not launched")
    const headers = { Authorization: `Bearer ${task.token}`, "Content-Type": "application/json" }
    const claim = await app.request(`/v1/runtime-attempts/${task.attempt}/claim`, {
      method: "POST",
      headers,
    })
    expect(claim.status).toBe(200)
    expect(await claim.json()).toMatchObject({
      claimed: true,
      input: { provider: "codex", instruction: definition.instruction },
    })
    const callManagedTool = () =>
      app.request(`/v1/runtime-attempts/${task.attempt}/tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tool: "anything" }),
      })
    await app.request(
      `/v1/contexts/${f.context.id}/access`,
      jsonAs(as(owner.email), { ask_policy: "invited" }),
    )
    const restricted = await callManagedTool()
    expect(restricted.status).toBe(403)
    expect(await restricted.text()).toContain("Runtime access has been revoked")
    await app.request(
      `/v1/contexts/${f.context.id}/access`,
      jsonAs(as(owner.email), { ask_policy: "workspace" }),
    )
    await meta.setMembership({
      id: "setup-member-seat",
      org_id: "default",
      user_id: member.id,
      role: "viewer",
    })
    const demoted = await callManagedTool()
    expect(demoted.status).toBe(403)
    expect(await demoted.text()).toContain("Runtime access has been revoked")
    await meta.setMembership({
      id: "setup-member-seat",
      org_id: "default",
      user_id: member.id,
      role: "editor",
    })
    // Keeping operator rollout enabled must never reopen a revoked managed job.
    config.managed.workspaceIds.clear()
    config.pilotWorkspaceIds.add("default")
    const deniedState = await app.request(f.path, { headers: as(owner.email) })
    expect(await deniedState.json()).toMatchObject({ enabled: false, runtime: null })
    expect((await app.request(`${f.path}/runs`, jsonAs(as(owner.email), {}))).status).toBe(403)
    expect(
      (
        await app.request(`${f.path}/schedule`, {
          ...jsonAs(as(owner.email), { ...definition, revision: 0 }),
          method: "PUT",
        })
      ).status,
    ).toBe(403)
    const deniedTool = await app.request(`/v1/runtime-attempts/${task.attempt}/tool`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "anything" }),
    })
    expect(deniedTool.status).toBe(403)
    expect(await deniedTool.text()).toContain("Runtime access has been revoked")
    const result = await app.request(`/v1/runtime-attempts/${task.attempt}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 1,
        outcome: "completed",
        summary: "Managed job completed",
        outputs: [],
      }),
    })
    expect(result.status).toBe(200)
    for (let i = 0; i < 6; i++) await pass()
    expect(await meta.getRun(run.id)).toMatchObject({ status: "succeeded" })
    expect(await meta.getLatestRunAttempt(run.id, "default")).toMatchObject({
      save_status: "saved",
      phase: "released",
    })

    config.managed.workspaceIds.add("default")
    const updated = await app.request(`${f.path}/schedule`, {
      ...jsonAs(as(owner.email), { ...definition, instruction: "Updated job", revision: 0 }),
      method: "PUT",
    })
    expect(updated.status).toBe(200)
    expect(await runtimeScheduleAllows(meta, run)).toBe(false)
    expect(
      (
        await app.request(`/v1/runtime-model-connections/${model.id}`, {
          headers: as(owner.email),
          method: "DELETE",
        })
      ).status,
    ).toBe(200)
    expect((await app.request(`${f.path}/runs`, jsonAs(as(member.email), {}))).status).toBe(409)
    expect((await app.request(`${f.path}/disable`, jsonAs(as(member.email), {}))).status).toBe(403)
  })

  it("does not convert pending operator setup into managed authority when the rollout changes", async () => {
    const f = await fixture()
    expect((await f.submit()).status).toBe(202)
    const initial = await f.state()
    config.managed.workspaceIds.add("default")
    const visible = await app.request(f.path, { headers: as(owner.email) })
    expect(await visible.json()).toMatchObject({
      managed: false,
      setup: { connection_id: f.connection.id },
    })
    await meta.setMembership({
      id: "setup-member-seat",
      org_id: "default",
      user_id: member.id,
      role: "owner",
    })
    try {
      expect(
        (await app.request(`${f.path}/setup/cancel`, jsonAs(as(member.email), {}))).status,
      ).toBe(403)
      expect(await f.state()).toEqual(initial)
      config.pilotWorkspaceIds.clear()
      expect((await f.cancel()).status).toBe(403)
      expect(await (await app.request(f.path, { headers: as(owner.email) })).json()).toMatchObject({
        enabled: false,
      })
      expect(await f.state()).toEqual(initial)
    } finally {
      await meta.setMembership({
        id: "setup-member-seat",
        org_id: "default",
        user_id: member.id,
        role: "editor",
      })
    }
  })

  it("keeps managed cleanup working after rollout is revoked", async () => {
    const f = await fixture()
    config.managed.workspaceIds.add("default")
    config.pilotWorkspaceIds.clear()
    await modelAccount(f.context.id)
    expect((await app.request(`${f.path}/setup`, jsonAs(as(owner.email), {}))).status).toBe(202)
    loseCreate = true
    await pass() // A remote create exists, but its response was lost before binding.
    config.managed.workspaceIds.clear()
    for (let i = 0; i < 6; i++) await pass()
    expect((await f.state())?.phase).toBe("failed")
    expect(await meta.getContextRuntimeForContext(f.context.id, "default")).toBeNull()
  })
})

describe("reusable runtime model accounts", () => {
  const owner: TestUser = { id: "model-owner", email: "model-owner@derive.test", name: "Owner" }
  const member: TestUser = { id: "model-member", email: "model-member@derive.test", name: "Member" }
  const path = "/v1/runtime-model-connections"
  const config = {
    apiUrl: "https://ortam.test/v1",
    runnerPath: SETUP_RUNNER_PATH,
    pilotWorkspaceIds: new Set<string>(),
    managed: { apiKey: "reusable integration fixture", workspaceIds: new Set(["default"]) },
  }
  const requests: { path: string; subject: string | null; method: string }[] = []
  const signInStates = new Map<string | null, string>()
  let failDisconnect = false
  let statusGate: Promise<void> | null = null
  let enteredStatus: (() => void) | null = null
  let completeGate: Promise<void> | null = null
  let enteredComplete: (() => void) | null = null
  const peer: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/v1", "")
    const subject = new Headers(init?.headers).get("X-Ortam-Integration-Subject")
    requests.push({ path, subject, method: init?.method ?? "GET" })
    const json = (value: unknown) => Response.json(value)
    if (path === "/auth/token")
      return json({
        token: `header.${Buffer.from(JSON.stringify({ sub: "service-owner", organization_id: "model-org" })).toString("base64url")}.signature`,
      })
    if (path === "/integration") {
      expect(subject).toMatch(/^[a-f0-9]{64}$/)
      return json({ organization_id: "model-org", user_id: `integration:${subject}` })
    }
    if (path === "/agents") {
      enteredStatus?.()
      if (statusGate) await statusGate
      return json({
        items: [
          {
            harness: "codex",
            status: "active",
            identity: { email: "codex@example.test" },
            private_token: "do not expose",
          },
          { harness: "claude_code", status: "active", identity: { email: "claude@example.test" } },
        ],
      })
    }
    if (init?.method === "DELETE") return new Response(null, { status: failDisconnect ? 503 : 204 })
    if (path.includes("sign-in")) {
      if (path.endsWith("/complete") && completeGate) {
        enteredComplete?.()
        await completeGate
      }
      if (path.endsWith("/complete")) {
        signInStates.set(subject, "complete")
        return json({
          id: "connection-fixture",
          harness: "claude_code",
          status: "active",
          identity: { email: "claude@example.test" },
        })
      }
      if (path.endsWith("/sign-in")) signInStates.set(subject, "pending")
      if (path.endsWith("/cancel") && signInStates.get(subject) === "pending")
        signInStates.set(subject, "cancelled")
      return json({
        id: "sign-in-fixture",
        state: signInStates.get(subject) ?? "pending",
        user_code: "ABCD-1234",
        verification_url: "https://auth.example.test/device",
        authorize_url: null,
        expires_at: "2026-09-24T00:00:00.000Z",
        secret: "do not expose",
      })
    }
    throw new Error(`Unexpected model request ${path}`)
  }
  const pokeRuntime = vi.fn()
  const { app, meta } = makeAuthedApp("reusable-runtime-models", [owner, member], "editor", {
    deps: { encryptionKey: SECRET, runtime: config, runtimeFetch: peer, pokeRuntime },
  })
  const create = async (provider = "codex") => {
    config.managed.workspaceIds.add("default")
    const response = await app.request(
      path,
      jsonAs(as(owner.email), { name: "  Work account  ", provider }),
    )
    expect(response.status).toBe(201)
    return (await response.json()) as { id: string; revision: number; name: string }
  }
  it("creates reusable identities without a Context and exposes only the owner's named accounts", async () => {
    const first = await create()
    const second = await create()
    expect(first.name).toBe("Work account")
    expect(first.id).not.toBe(second.id)
    const a = await meta.getRuntimeModelConnection(first.id, "default")
    const b = await meta.getRuntimeModelConnection(second.id, "default")
    expect(a?.ortam_user_id).not.toBe(b?.ortam_user_id)
    expect(a?.created_by).toBe(owner.id)
    const list = await (await app.request(path, { headers: as(owner.email) })).json()
    expect(list.items.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    )
    expect(JSON.stringify(list)).not.toMatch(/ortam|api_url|created_by|integration/)
    expect(await (await app.request(path, { headers: as(member.email) })).json()).toEqual({
      items: [],
    })
    const before = requests.length
    for (const suffix of ["", "/status", "/sign-in/sign-in-fixture"]) {
      expect(
        (await app.request(`${path}/${first.id}${suffix}`, { headers: as(member.email) })).status,
      ).toBe(404)
    }
    for (const suffix of [
      "/sign-in",
      "/sign-in/sign-in-fixture/complete",
      "/sign-in/sign-in-fixture/cancel",
    ]) {
      expect(
        (
          await app.request(
            `${path}/${first.id}${suffix}`,
            jsonAs(as(member.email), { code: "code" }),
          )
        ).status,
      ).toBe(404)
    }
    expect(
      (
        await app.request(`${path}/${first.id}`, {
          ...jsonAs(as(member.email), { name: "Stolen", revision: 0 }),
          method: "PATCH",
        })
      ).status,
    ).toBe(404)
    expect(
      (await app.request(`${path}/${first.id}`, { headers: as(member.email), method: "DELETE" }))
        .status,
    ).toBe(404)
    expect(requests).toHaveLength(before)
    expect((await app.request(path)).status).toBe(403)
  })
  it("keeps one provider identity through reconnect, sign-in and name edits", async () => {
    const connection = await create("claude-code")
    const base = `${path}/${connection.id}`
    const before = requests.length
    for (const suffix of ["/sign-in", "/sign-in"]) {
      const response = await app.request(base + suffix, jsonAs(as(owner.email), {}))
      expect(response.status).toBe(202)
      expect(response.headers.get("Cache-Control")).toBe("no-store")
      expect(await response.text()).not.toContain("do not expose")
    }
    const poll = await app.request(`${base}/sign-in/sign-in-fixture`, { headers: as(owner.email) })
    expect((await poll.json()).state).toBe("pending")
    const finish = await app.request(
      `${base}/sign-in/sign-in-fixture/complete`,
      jsonAs(as(owner.email), { code: "authorization fixture" }),
    )
    expect((await finish.json()).state).toBe("complete")
    const exchanges = requests.filter((r) => r.path.endsWith("/complete")).length
    const retry = await app.request(
      `${base}/sign-in/sign-in-fixture/complete`,
      jsonAs(as(owner.email), { code: "authorization fixture" }),
    )
    expect((await retry.json()).state).toBe("complete")
    expect(requests.filter((r) => r.path.endsWith("/complete"))).toHaveLength(exchanges)
    await app.request(`${base}/sign-in`, jsonAs(as(owner.email), {}))
    const cancel = await app.request(
      `${base}/sign-in/sign-in-fixture/cancel`,
      jsonAs(as(owner.email), {}),
    )
    expect((await cancel.json()).state).toBe("cancelled")
    const rename = await app.request(base, {
      ...jsonAs(as(owner.email), { name: "Shared work account", revision: 0 }),
      method: "PATCH",
    })
    expect((await rename.json()).revision).toBe(1)
    expect(
      (
        await app.request(base, {
          ...jsonAs(as(owner.email), { name: "Old edit", revision: 0 }),
          method: "PATCH",
        })
      ).status,
    ).toBe(409)
    const status = await (await app.request(`${base}/status`, { headers: as(owner.email) })).json()
    expect(status.account.harness).toBe("claude_code")
    expect(JSON.stringify(status)).not.toContain("do not expose")
    const calls = requests.slice(before).filter((r) => r.subject)
    expect(new Set(calls.map((r) => r.subject)).size).toBe(1)
    expect(calls.some((r) => r.path === "/agents/claude_code/sign-in")).toBe(true)
    expect(calls.some((r) => r.path === "/agents/codex/sign-in")).toBe(false)
  })
  it.each([
    "rollout",
    "publish",
  ])("allows the owner to inspect and cancel sign-in after %s access is withdrawn", async (withdrawal) => {
    const connection = await create("claude-code")
    const base = `${path}/${connection.id}`
    expect((await app.request(`${base}/sign-in`, jsonAs(as(owner.email), {}))).status).toBe(202)
    const membership = await meta.getMembership("default", owner.id)
    if (!membership) throw new Error("Missing owner membership")
    if (withdrawal === "rollout") config.managed.workspaceIds.clear()
    else await meta.setMembership({ ...membership, role: "viewer" })
    try {
      for (const suffix of ["/sign-in", "/sign-in/sign-in-fixture/complete"]) {
        const before = requests.length
        expect(
          (await app.request(base + suffix, jsonAs(as(owner.email), { code: "code" }))).status,
        ).toBe(withdrawal === "rollout" ? 404 : 403)
        expect(requests).toHaveLength(before)
      }
      const read = await app.request(`${base}/sign-in/sign-in-fixture`, {
        headers: as(owner.email),
      })
      expect(read.status).toBe(200)
      expect((await read.json()).state).toBe("pending")
      const cancel = await app.request(
        `${base}/sign-in/sign-in-fixture/cancel`,
        jsonAs(as(owner.email), {}),
      )
      expect(cancel.status).toBe(200)
      expect((await cancel.json()).state).toBe("cancelled")
      expect(
        (await meta.getRuntimeModelConnection(connection.id, "default"))?.revoked_at,
      ).toBeNull()
    } finally {
      config.managed.workspaceIds.add("default")
      await meta.setMembership(membership)
    }
  })
  it("does not report a stale active account when disconnect wins during a status request", async () => {
    const connection = await create()
    const base = `${path}/${connection.id}`
    let release: () => void = () => {}
    statusGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enteredStatus = resolve
    })
    const pending = app.request(`${base}/status`, { headers: as(owner.email) })
    try {
      await entered
      expect((await app.request(base, { headers: as(owner.email), method: "DELETE" })).status).toBe(
        200,
      )
      release()
      const response = await pending
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ account: null, revoked: true })
    } finally {
      release()
      statusGate = null
      enteredStatus = null
    }
  })
  it("revokes locally before remote disconnect, keeps cleanup possible after rollout withdrawal, and never revives the identity", async () => {
    const connection = await create()
    const base = `${path}/${connection.id}`
    const original = await meta.getRuntimeModelConnection(connection.id, "default")
    config.managed.workspaceIds.clear()
    expect(
      (await app.request(path, jsonAs(as(owner.email), { name: "Blocked", provider: "codex" })))
        .status,
    ).toBe(404)
    expect((await app.request(`${base}/sign-in`, jsonAs(as(owner.email), {}))).status).toBe(404)
    failDisconnect = true
    try {
      const response = await app.request(base, { headers: as(owner.email), method: "DELETE" })
      expect(response.status).toBe(502)
      expect(await response.text()).toContain("Connection revoked")
      expect(
        (await meta.getRuntimeModelConnection(connection.id, "default"))?.revoked_at,
      ).toBeTruthy()
    } finally {
      failDisconnect = false
    }
    const receipt = await meta.getRuntimeModelConnection(connection.id, "default")
    expect(receipt?.ortam_user_id).toBe(original?.ortam_user_id)
    expect((await app.request(base, { headers: as(owner.email), method: "DELETE" })).status).toBe(
      200,
    )
    expect(await meta.getRuntimeModelConnection(connection.id, "default")).toEqual(receipt)
    config.managed.workspaceIds.add("default")
    const before = requests.length
    expect((await app.request(`${base}/sign-in`, jsonAs(as(owner.email), {}))).status).toBe(409)
    expect(
      (
        await app.request(
          `${base}/sign-in/sign-in-fixture/complete`,
          jsonAs(as(owner.email), { code: "code" }),
        )
      ).status,
    ).toBe(409)
    expect(
      await (await app.request(`${base}/status`, { headers: as(owner.email) })).json(),
    ).toEqual({ account: null, revoked: true })
    expect(requests).toHaveLength(before)
    const list = await (await app.request(path, { headers: as(owner.email) })).json()
    expect(list.items.some((item: { id: string }) => item.id === connection.id)).toBe(false)
  })
  it("does not report successful sign-in when disconnect wins during provider completion", async () => {
    const connection = await create("claude-code")
    const base = `${path}/${connection.id}`
    await app.request(`${base}/sign-in`, jsonAs(as(owner.email), {}))
    let release: () => void = () => {}
    completeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enteredComplete = resolve
    })
    const pending = app.request(
      `${base}/sign-in/sign-in-fixture/complete`,
      jsonAs(as(owner.email), { code: "code" }),
    )
    try {
      await entered
      expect((await app.request(base, { headers: as(owner.email), method: "DELETE" })).status).toBe(
        200,
      )
      release()
      expect((await pending).status).toBe(409)
    } finally {
      release()
      completeGate = null
      enteredComplete = null
    }
  })
  it("rejects malformed connection creation before contacting the service", async () => {
    const before = requests.length
    for (const body of [
      { name: " ", provider: "codex" },
      { name: "No", provider: "arbitrary" },
      { name: "x".repeat(101), provider: "codex" },
    ]) {
      expect((await app.request(path, jsonAs(as(owner.email), body))).status).toBe(400)
    }
    expect(requests).toHaveLength(before)
  })
})
