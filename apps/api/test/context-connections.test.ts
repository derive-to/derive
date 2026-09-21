import {
  CONTEXT_ENVIRONMENT_LIMIT as SERVER_LIMIT,
  contextEnvironmentNameError as serverError,
} from "@derive/core"
import { describe, expect, it } from "vitest"
import {
  CONTEXT_ENVIRONMENT_LIMIT,
  contextEnvironmentNameError,
} from "../../web/src/lib/context-environment"
import { encryptSecret } from "../src/lib/crypto"
import { dispatchPass, type Substrate } from "../src/lib/dispatch"
import { signWorkToken } from "../src/lib/run-token"
import { runtimeDispatchPass } from "../src/lib/runtime-dispatch"
import { materializeRuntimeSchedules, nextRuntimeOccurrence } from "../src/lib/runtime-schedule"
import { materializeAllDueRuns } from "../src/lib/schedule"
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
  const config = { apiUrl: "https://ortam.test/v1", runnerPath: "/opt/derive/bin/derive.js" }
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
  const peer: typeof fetch = async (url, init) => {
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
  const { app, meta, ctx } = makeAuthedApp("runtime-lifecycle", [owner, member], "editor", {
    deps: { encryptionKey: SECRET, runtime: config, runtimeFetch: peer },
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
    await Promise.all([0, 1, 2].map(() => materializeRuntimeSchedules(meta, now)))
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
    await materializeRuntimeSchedules(meta, now)
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

  it("rejects a launched but unclaimed task after pause and still shuts down", async () => {
    const f = await scheduled()
    for (let i = 0; i < 3; i++) await pass()
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
    await pass()
    await pass()
    await pass()
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
