import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { createInProcessBackplane } from "../src/bus"
import { sha256 } from "../src/lib/crypto"
import { inMemoryRateLimiters } from "../src/lib/rate-limit"
import { bindWorkflowContextSession } from "../src/lib/workflow-coordination"
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
    ownerAgentId: ownerBot.id as string,
    ownerToken: ownerBot.token as string,
  }
}

const workflowHtml = (contextRef: string) => `<!doctype html><html><body>
<a href="#research">Research</a>
<script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify({
  schema: "derive.linked-bundle/v1",
  purpose: "Run one research context",
  members: [],
  diagrams: [
    {
      id: "research-once",
      title: "Research once",
      type: "graph",
      nodes: [{ id: "research", label: "Research", note: "Produce the requested research" }],
      edges: [],
    },
  ],
})}</script>
<script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify({
  schema: "derive.workflow/v1",
  purpose: "Run one research context",
  diagrams: [
    {
      id: "research-once",
      entry: "research",
      nodes: [
        {
          id: "research",
          kind: "context",
          context_ref: contextRef,
          instruction: "Produce the requested research.",
          result: "A research result",
          terminal: true,
        },
      ],
      routes: [],
      scenarios: [
        {
          id: "expected",
          kind: "expected",
          path: ["research"],
          outcome: "Research completes",
        },
        {
          id: "failure",
          kind: "failure",
          path: ["research"],
          outcome: "The failed session is visible",
        },
      ],
    },
  ],
})}</script></body></html>`

const fanOutWorkflowHtml = (contextRef: string) => `<!doctype html><html><body>
<a href="#research">Research</a><a href="#publish">Publish</a><a href="#archive">Archive</a>
<script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify({
  schema: "derive.linked-bundle/v1",
  purpose: "Research, then publish and archive",
  members: [],
  diagrams: [
    {
      id: "research-fan-out",
      title: "Research fan-out",
      type: "graph",
      nodes: [
        { id: "research", label: "Research", note: "Produce the research" },
        { id: "publish", label: "Publish", note: "Publish the result" },
        { id: "archive", label: "Archive", note: "Archive the result" },
      ],
      edges: [
        { from: "research", to: "publish", label: "always" },
        { from: "research", to: "archive", label: "always" },
      ],
    },
  ],
})}</script>
<script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify({
  schema: "derive.workflow/v1",
  purpose: "Research, then publish and archive",
  diagrams: [
    {
      id: "research-fan-out",
      entry: "research",
      nodes: [
        {
          id: "research",
          kind: "context",
          context_ref: contextRef,
          instruction: "Produce the research.",
          result: "A research result",
          routing: "all",
        },
        { id: "publish", kind: "terminal", result: "Published result" },
        { id: "archive", kind: "terminal", result: "Archived result" },
      ],
      routes: [
        { from: "research", to: "publish", when: "always" },
        { from: "research", to: "archive", when: "always" },
      ],
      scenarios: [
        {
          id: "expected",
          kind: "expected",
          path: ["research", "publish"],
          outcome: "The result is published and archived",
        },
        {
          id: "failure",
          kind: "failure",
          path: ["research"],
          outcome: "The failed session is visible",
        },
      ],
    },
  ],
})}</script></body></html>`

const gatedEffectWorkflowHtml = (
  contextRef: string,
  idempotent: boolean,
) => `<!doctype html><html><body>
<a href="#review">Review</a><a href="#publish">Publish</a><a href="#stop">Stop</a>
<script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify({
  schema: "derive.linked-bundle/v1",
  purpose: "Approve one external publish",
  members: [],
  diagrams: [
    {
      id: "approved-publish",
      title: "Approved publish",
      type: "graph",
      nodes: [
        { id: "review", label: "Review", note: "Approve or stop the publish" },
        { id: "publish", label: "Publish", note: "Publish after approval" },
        { id: "stop", label: "Stop", note: "Stop without publishing" },
      ],
      edges: [
        { from: "review", to: "publish", label: "approve" },
        { from: "review", to: "stop", label: "stop" },
      ],
    },
  ],
})}</script>
<script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify({
  schema: "derive.workflow/v1",
  purpose: "Approve one external publish",
  diagrams: [
    {
      id: "approved-publish",
      entry: "review",
      nodes: [
        {
          id: "review",
          kind: "human",
          decision: "Approve or stop the publish",
          options: ["approve", "stop"],
          resume: "The reviewer chooses",
        },
        {
          id: "publish",
          kind: "context",
          context_ref: contextRef,
          instruction: "Publish the approved content outside Derive.",
          result: "The approved content is published",
          terminal: true,
          effects: [
            {
              kind: "write",
              description: "Publish outside Derive",
              gate: "human",
              approval_ref: "review",
              ...(idempotent ? { idempotency: "One external publish per workflow run" } : {}),
            },
          ],
        },
        { id: "stop", kind: "terminal", result: "Stopped without publishing" },
      ],
      routes: [
        { from: "review", to: "publish", when: "approve" },
        { from: "review", to: "stop", when: "stop" },
      ],
      scenarios: [
        {
          id: "expected",
          kind: "expected",
          path: ["review", "publish"],
          outcome: "The approved content is published",
        },
        {
          id: "human",
          kind: "human",
          path: ["review", "stop"],
          outcome: "The reviewer stops the publish",
        },
        {
          id: "failure",
          kind: "failure",
          path: ["review", "publish"],
          outcome: "The failed publish attempt remains visible",
        },
      ],
    },
  ],
})}</script></body></html>`

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
  it("binds an assigned agent's context session to a pinned workflow attempt and receipt", async () => {
    const { app, meta, cx, ownerAgentId, ownerToken, answeringToken } =
      await setup("mcx-workflow-run")
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    const workflow = await (
      await publishAs(
        app,
        workflowHtml(cx.id),
        { title: "Research workflow", contentType: "text/html" },
        as(owner.email),
      )
    ).json()
    const startedResponse = await app.request(
      `/v1/artifacts/${workflow.short_id}/workflow-run`,
      jsonAs(as(owner.email), { agentId: ownerAgentId, diagramId: "research-once" }),
    )
    expect(startedResponse.status).toBe(201)
    const started = (await startedResponse.json()) as { runId: string }

    const invalidNode = await callRaw(app, ownerToken, "use", {
      context: cx.id,
      instruction: "This must not create a session.",
      workflow: { run_id: started.runId, node_id: "missing", attempt: 1 },
      wait: 0,
    })
    expect(invalidNode.isError).toBe(true)
    expect(await meta.listSessions(cx.id)).toHaveLength(0)

    const opened = await call(app, ownerToken, "use", {
      context: cx.id,
      instruction: "Research Acme.",
      workflow: { run_id: started.runId, node_id: "research", attempt: 1 },
      wait: 0,
    })
    expect(opened.workflow).toMatchObject({
      run_id: started.runId,
      node_id: "research",
      attempt: 1,
      status: "waiting",
    })
    const joined = await call(app, ownerToken, "use", {
      context: cx.id,
      instruction: "Research Acme.",
      workflow: { run_id: started.runId, node_id: "research", attempt: 1 },
      wait: 0,
    })
    expect(joined.session_id).toBe(opened.session_id)
    expect(
      (
        await answerAs(app, answeringToken, opened.session_id, {
          body_md: "Acme research complete.",
          state: "answered",
          result_artifact_id: workflow.short_id,
        })
      ).status,
    ).toBe(201)
    const mismatchedFinal = await callRaw(app, ownerToken, "use", {
      workflow: {
        run_id: started.runId,
        node_id: "research",
        attempt: 1,
        status: "succeeded",
        selected_routes: [],
        finish_run: "failed",
      },
    })
    expect(mismatchedFinal.isError).toBe(true)
    expect(mismatchedFinal.text).toContain("must match")
    const finalReceipt = {
      run_id: started.runId,
      node_id: "research",
      attempt: 1,
      status: "succeeded" as const,
      selected_routes: [],
      route_basis: "Terminal context answered",
      finish_run: "succeeded" as const,
    }
    expect(await call(app, ownerToken, "use", { workflow: finalReceipt })).toMatchObject({
      run_status: "succeeded",
      attempt_status: "succeeded",
    })
    expect(await call(app, ownerToken, "use", { workflow: finalReceipt })).toMatchObject({
      run_status: "succeeded",
      attempt_status: "succeeded",
    })
    const conflictingRetry = await callRaw(app, ownerToken, "use", {
      workflow: { ...finalReceipt, route_basis: "A different receipt" },
    })
    expect(conflictingRetry.isError).toBe(true)
    expect(conflictingRetry.text).toContain("already succeeded")
    const orgId = (await meta.listWorkspaces(owner.id))[0]?.id ?? ""
    expect(await meta.getWorkflowRun(started.runId, orgId)).toMatchObject({
      assigned_agent_id: ownerAgentId,
      executor_id: ownerAgentId,
      actual_execution: "local",
      status: "succeeded",
    })
    expect(await meta.getWorkflowStepAttemptBySession(opened.session_id, orgId)).toMatchObject({
      node_id: "research",
      attempt: 1,
      result_artifact_id: workflow.short_id,
      status: "succeeded",
    })
  })

  it("pins the manifest version carried by the context session", async () => {
    const { app, meta, cx, manifestShortId, ownerAgentId } = await setup("mcx-workflow-pin")
    const workflow = await (
      await publishAs(
        app,
        workflowHtml(cx.id),
        { title: "Research workflow", contentType: "text/html" },
        as(owner.email),
      )
    ).json()
    const startedResponse = await app.request(
      `/v1/artifacts/${workflow.short_id}/workflow-run`,
      jsonAs(as(owner.email), { agentId: ownerAgentId, diagramId: "research-once" }),
    )
    expect(startedResponse.status).toBe(201)
    const started = (await startedResponse.json()) as { runId: string }
    const originalManifest = await meta.getByShortId(manifestShortId)
    if (!originalManifest) throw new Error("missing context manifest")
    const originalVersion = await meta.getVersion(
      originalManifest.id,
      originalManifest.current_version,
    )
    if (!originalVersion) throw new Error("missing context manifest version")
    const orgId = originalManifest.org_id
    const session = await meta.createSession({
      id: newId("ses"),
      context_id: cx.id,
      org_id: orgId,
      asker_id: owner.id,
      context_version: originalVersion.n,
    })
    expect(
      (
        await publishAs(
          app,
          "# Analytics manifest v2",
          { title: "Analytics manifest" },
          as(dev.email),
          manifestShortId,
        )
      ).status,
    ).toBe(201)
    const currentManifest = await meta.getByShortId(manifestShortId)
    if (!currentManifest) throw new Error("missing updated context manifest")
    const context = await meta.getContext(cx.id)
    if (!context) throw new Error("missing context")

    const bound = await bindWorkflowContextSession({
      meta,
      ref: { run_id: started.runId, node_id: "research", attempt: 1 },
      orgId,
      context,
      manifest: currentManifest,
      session,
      executorId: ownerAgentId,
      at: session.created_at,
    })
    if (typeof bound === "string") throw new Error(bound)
    expect(bound).toMatchObject({
      context_version: originalVersion.n,
      context_blob_key: originalVersion.blob_key,
    })
    expect(bound.context_version).not.toBe(currentManifest.current_version)
  })

  it("enforces entry, authored fan-out, and completion before succeeding a run", async () => {
    const { app, cx, ownerAgentId, ownerToken, answeringToken } =
      await setup("mcx-workflow-routing")
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    const workflow = await (
      await publishAs(
        app,
        fanOutWorkflowHtml(cx.id),
        { title: "Fan-out workflow", contentType: "text/html" },
        as(owner.email),
      )
    ).json()
    const startedResponse = await app.request(
      `/v1/artifacts/${workflow.short_id}/workflow-run`,
      jsonAs(as(owner.email), { agentId: ownerAgentId, diagramId: "research-fan-out" }),
    )
    expect(startedResponse.status).toBe(201)
    const started = (await startedResponse.json()) as { runId: string }

    const outOfOrder = await callRaw(app, ownerToken, "use", {
      workflow: {
        run_id: started.runId,
        node_id: "publish",
        attempt: 1,
        status: "succeeded",
        selected_routes: [],
        finish_run: "succeeded",
      },
    })
    expect(outOfOrder.isError).toBe(true)
    expect(outOfOrder.text).toContain('begin at entry node "research"')

    const opened = await call(app, ownerToken, "use", {
      context: cx.id,
      instruction: "Research Acme.",
      workflow: { run_id: started.runId, node_id: "research", attempt: 1 },
      wait: 0,
    })
    expect(
      (
        await answerAs(app, answeringToken, opened.session_id, {
          body_md: "Research complete.",
          state: "answered",
        })
      ).status,
    ).toBe(201)
    const incompleteFanOut = await callRaw(app, ownerToken, "use", {
      workflow: {
        run_id: started.runId,
        node_id: "research",
        attempt: 1,
        status: "succeeded",
        selected_routes: ["publish"],
      },
    })
    expect(incompleteFanOut.isError).toBe(true)
    expect(incompleteFanOut.text).toContain("select every authored route")
    expect(
      await call(app, ownerToken, "use", {
        workflow: {
          run_id: started.runId,
          node_id: "research",
          attempt: 1,
          status: "succeeded",
          selected_routes: ["publish", "archive"],
        },
      }),
    ).toMatchObject({ attempt_status: "succeeded", run_status: "running" })
    const prematureFinish = await callRaw(app, ownerToken, "use", {
      workflow: {
        run_id: started.runId,
        node_id: "publish",
        attempt: 1,
        status: "succeeded",
        selected_routes: [],
        finish_run: "succeeded",
      },
    })
    expect(prematureFinish.isError).toBe(true)
    expect(prematureFinish.text).toContain('Selected workflow node "archive" has not started')
    expect(
      await call(app, ownerToken, "use", {
        workflow: {
          run_id: started.runId,
          node_id: "archive",
          attempt: 1,
          status: "succeeded",
          selected_routes: [],
          finish_run: "succeeded",
        },
      }),
    ).toMatchObject({ attempt_status: "succeeded", run_status: "succeeded" })
  })

  it("requires idempotency before reusing approval for an effect retry", async () => {
    const { app, meta, cx, ownerAgentId, ownerToken, answeringToken } = await setup(
      "mcx-workflow-effect-gate",
    )
    expect(
      (
        await app.request(
          `/v1/contexts/${cx.id}/access`,
          jsonAs(as(dev.email), { ask_policy: "workspace" }),
        )
      ).status,
    ).toBe(200)
    const publishWorkflow = async (idempotent: boolean) => {
      const response = await publishAs(
        app,
        gatedEffectWorkflowHtml(cx.id, idempotent),
        { title: idempotent ? "Replay-safe publish" : "Single approved publish" },
        as(owner.email),
      )
      expect(response.status).toBe(201)
      return ((await response.json()) as { short_id: string }).short_id
    }
    const start = async (shortId: string) => {
      const response = await app.request(
        `/v1/artifacts/${shortId}/workflow-run`,
        jsonAs(as(owner.email), { agentId: ownerAgentId, diagramId: "approved-publish" }),
      )
      expect(response.status).toBe(201)
      return ((await response.json()) as { runId: string }).runId
    }
    const approve = (runId: string) =>
      call(app, ownerToken, "use", {
        workflow: {
          run_id: runId,
          node_id: "review",
          attempt: 1,
          status: "succeeded",
          decision: "approve",
          selected_routes: ["publish"],
        },
      })
    const failFirstPublish = async (runId: string) => {
      const opened = await call(app, ownerToken, "use", {
        context: cx.id,
        instruction: "Publish the approved content outside Derive.",
        workflow: { run_id: runId, node_id: "publish", attempt: 1 },
        wait: 0,
      })
      expect(
        (
          await answerAs(app, answeringToken, opened.session_id, {
            body_md: "The external publish failed.",
            state: "failed",
          })
        ).status,
      ).toBe(201)
      await call(app, ownerToken, "use", {
        workflow: {
          run_id: runId,
          node_id: "publish",
          attempt: 1,
          status: "failed",
          selected_routes: [],
        },
      })
    }

    const guardedRun = await start(await publishWorkflow(false))
    await approve(guardedRun)
    await failFirstPublish(guardedRun)
    const unsafeRetry = await callRaw(app, ownerToken, "use", {
      context: cx.id,
      instruction: "Retry the external publish.",
      workflow: { run_id: guardedRun, node_id: "publish", attempt: 2 },
      wait: 0,
    })
    expect(unsafeRetry.isError).toBe(true)
    expect(unsafeRetry.text).toContain('cannot reuse approval from "review"')
    expect(unsafeRetry.text).toContain("Start a new run for fresh approval")
    expect(await meta.listSessions(cx.id)).toHaveLength(1)

    const replaySafeRun = await start(await publishWorkflow(true))
    await approve(replaySafeRun)
    await failFirstPublish(replaySafeRun)
    const replayed = await call(app, ownerToken, "use", {
      context: cx.id,
      instruction: "Retry the external publish.",
      workflow: { run_id: replaySafeRun, node_id: "publish", attempt: 2 },
      wait: 0,
    })
    expect(replayed.workflow).toMatchObject({
      run_id: replaySafeRun,
      node_id: "publish",
      attempt: 2,
      status: "waiting",
    })
  })

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

  it("a body-only derive://skills mention pins nothing — and the response says so", async () => {
    const { createContext } = await setupOwnerBot("mcx-cc-prose")
    const r = await createContext("QA", "# QA manifest\nRead derive://skills/loop before acting.")
    expect(r.context_id).toBeTruthy()
    expect(r.skills_count).toBe(0)
    // The hint teaches the fix: pins live in frontmatter, one `- id:` per skill.
    expect(r.skills_hint).toContain("frontmatter")
    expect(r.skills_hint).toContain("- id:")
  })
})

// READING a context: a context is a PACKAGE (manifest + pinned skills + sources), and
// `read` loads it — the mode that had no way in. The surface previously described contexts
// as ask-only, and `find` went further and told callers a context row is "never
// read/opened", so the package was only assemblable by hand from its manifest short_id.
//
// The two properties worth pinning here are the ones that could go quietly wrong:
//   ACCESS  — reading is gated on canUserAskContext, the SAME grant `find` filters on, so
//             `read` can never open a package `find` would not have shown. A second access
//             path to workspace-scoped material is exactly the bug to avoid.
//   PARITY  — the skills a reader is told about are the skills a RUN would materialize,
//             staleness included, because both go through parseManifestSkillPins.
describe("read — a context opens as a package", () => {
  /** owner registers both agents (Admin-only); dev authors the manifest and creates the
   *  context, so dev is CREATOR and owner is a plain member — the interesting side of the
   *  ask gate, the same cast as the ask tests above. */
  const setupPackage = async (name: string, manifestBody: string) => {
    const made = makeAuthedApp(name, [owner, dev], "editor")
    const { app } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const answering = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
    ).json()
    const ownerBot = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
    ).json()
    const manifest = await (
      await publishAs(app, manifestBody, { title: "Analytics manifest" }, as(dev.email))
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
    const invite = async () =>
      app.request(`/v1/contexts/${cx.id}/askers`, jsonAs(as(dev.email), { email: owner.email }))
    return { app, cx, manifest, ownerToken: ownerBot.token as string, invite }
  }

  it("is gated on the ask grant: unreachable before the invite, the package after", async () => {
    const { app, cx, ownerToken, invite } = await setupPackage(
      "cxr-gate",
      "# Analytics manifest\n\nBody.",
    )

    // Default ask_policy is `invited` (creator + roster). owner is a plain member, so the
    // context is not askable — and must not be readable either, or `read` would be a second
    // way into material the ask gate withholds.
    const denied = await callRaw(app, ownerToken, "read", { short_id: cx.id })
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/No Agent/i)

    expect((await invite()).status).toBe(201)

    const pkg = await call(app, ownerToken, "read", { short_id: cx.id })
    expect(pkg.context.id).toBe(cx.id)
    expect(pkg.context.name).toBe("Analytics")
    // Reading never needs a runner — the context has never polled, and that is fine.
    expect(pkg.context.online).toBe(false)
    // PROGRESSIVE OPENING: the manifest is the eager layer, so its body is inline.
    expect(pkg.manifest.content).toContain("Analytics manifest")
    expect(pkg.how).toMatch(/use\(\{context, instruction\}\)/)
  })

  it("returns pinned skills as POINTERS, and says which pins have gone stale", async () => {
    // A skill the manifest pins at v1...
    const made = makeAuthedApp("cxr-pins", [owner, dev], "editor")
    const { app } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const skill = await (
      await publishAs(app, "# How to analyse", { title: "Analysis skill" }, as(dev.email))
    ).json()

    const answering = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
    ).json()
    const ownerBot = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
    ).json()
    const manifest = await (
      await publishAs(
        app,
        `---\nskills:\n  - id: ${skill.short_id}\n    version: 1\n---\n# Analytics\n\nBody.`,
        { title: "Analytics manifest" },
        as(dev.email),
      )
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
    await app.request(`/v1/contexts/${cx.id}/askers`, jsonAs(as(dev.email), { email: owner.email }))

    const before = await call(app, ownerBot.token, "read", { short_id: cx.id })
    expect(before.skills).toHaveLength(1)
    expect(before.skills[0].short_id).toBe(skill.short_id)
    expect(before.skills[0].pinned_version).toBe(1)
    // A POINTER, not the body — following it is a separate read, which is the whole point.
    expect(before.skills[0]).not.toHaveProperty("content")
    expect(before.skills[0].stale).toBe(false)

    // ...now the skill moves to v2 while the pin still says v1. A run would execute v1, so
    // the read has to say so — the one thing a pinned-skill model gets silently wrong.
    await publishAs(app, "# How to analyse, revised", {}, as(dev.email), skill.short_id)
    const after = await call(app, ownerBot.token, "read", { short_id: cx.id })
    expect(after.skills[0].pinned_version).toBe(1)
    expect(after.skills[0].current_version).toBe(2)
    expect(after.skills[0].stale).toBe(true)
  })

  it("resolves a context by NAME, but never shadows an artifact of that name", async () => {
    const { app, ownerToken, invite } = await setupPackage(
      "cxr-name",
      "# Analytics manifest\n\nBody.",
    )
    expect((await invite()).status).toBe(201)

    // By name: the package.
    const byName = await call(app, ownerToken, "read", { short_id: "Analytics" })
    expect(byName.context?.name).toBe("Analytics")

    // A DOCUMENT is still reached by its own short_id — the context branch only runs for a
    // ctx_ id, or as a fallback after the artifact lookup misses, so documents keep priority.
    const doc = await (
      await publishAs(app, "# A real document", { title: "Analytics" }, as(dev.email))
    ).json()
    // A document read comes back as a DOC response (text), not the package JSON — so the
    // absence of a context payload here is the assertion.
    const byShortId = await callRaw(app, ownerToken, "read", { short_id: doc.short_id })
    expect(byShortId.isError).toBe(false)
    expect(byShortId.text).toContain("A real document")
    expect(byShortId.text).not.toContain('"context"')
  })
})
