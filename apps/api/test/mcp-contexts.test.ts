import {
  newId,
  publish as publishVersion,
  tarSync,
  WorkflowAttemptStateConflictError,
} from "@derive/core"
import { gzipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import { createInProcessBackplane } from "../src/bus"
import { runImportTick } from "../src/imports"
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
): Promise<any> => {
  const result = await callRaw(app, token, name, args)
  if (result.isError) throw new Error(result.text)
  return JSON.parse(result.text)
}

// find's browse/search rows are typed; the askable contexts come back as
// {type:"context"} rows — the former list_contexts payload, one per context, each
// carrying its own your_open_sessions. Pull just those out of a find result.
const contextsOf = (
  r: { results?: { type?: string }[] },
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
): any[] => (r.results ?? []).filter((x) => x.type === "context")

const setup = async (
  name: string,
  deps?: Record<string, unknown>,
  ownerRole: "commenter" | "editor" = "commenter",
) => {
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
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot", role: ownerRole }))
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
    ctx: made.ctx,
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

const fanInWorkflowHtml = (contextRef: string) => {
  const routes = [
    { from: "research", to: "left", when: "always" },
    { from: "research", to: "right", when: "always" },
    { from: "left", to: "join", when: "join" },
    { from: "right", to: "join", when: "join" },
    { from: "left", to: "stop", when: "stop" },
    { from: "right", to: "stop", when: "stop" },
  ]
  const manifest = {
    schema: "derive.linked-bundle/v1",
    purpose: "Join two reviews",
    members: [],
    diagrams: [
      {
        id: "fan-in",
        title: "Join reviews",
        type: "graph",
        nodes: ["research", "left", "right", "join", "stop"].map((id) => ({
          id,
          label: id,
          note: id,
        })),
        edges: routes.map(({ from, to, when }) => ({ from, to, label: when })),
      },
    ],
  }
  const definition = {
    schema: "derive.workflow/v1",
    purpose: "Join two reviews",
    diagrams: [
      {
        id: "fan-in",
        entry: "research",
        routes,
        nodes: [
          {
            id: "research",
            kind: "context",
            context_ref: contextRef,
            instruction: "Produce research",
            result: "Evidence",
            routing: "all",
          },
          ...["left", "right"].map((id) => ({
            id,
            kind: "human",
            decision: "Join the reviews",
            options: ["join", "stop"],
            resume: "Record this review",
          })),
          { id: "join", kind: "terminal", result: "Both reviews", terminal: true },
          { id: "stop", kind: "terminal", result: "Stopped", terminal: true },
        ],
        scenarios: [
          {
            id: "left-human",
            kind: "human",
            path: ["research", "left", "join"],
            outcome: "Left review joins",
          },
          {
            id: "expected",
            kind: "expected",
            path: ["research", "left", "join"],
            outcome: "Reviews join",
          },
          {
            id: "human",
            kind: "human",
            path: ["research", "right", "join"],
            outcome: "A person reviews",
          },
          { id: "failure", kind: "failure", path: ["research"], outcome: "Failure is visible" },
        ],
      },
    ],
  }
  return `<!doctype html><html><body><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script><script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(definition)}</script></body></html>`
}

const repeatedWorkflowHtml = (contextRef: string) => {
  const routes = [
    { from: "research", to: "review", when: "always" },
    { from: "review", to: "research", when: "again" },
    { from: "review", to: "done", when: "done" },
  ]
  const manifest = {
    schema: "derive.linked-bundle/v1",
    purpose: "Verify ten rounds",
    members: [],
    diagrams: [
      {
        id: "ten-rounds",
        title: "Ten rounds",
        type: "graph",
        nodes: ["research", "review", "done"].map((id) => ({ id, label: id, note: id })),
        edges: routes.map(({ from, to, when }) => ({ from, to, label: when })),
      },
    ],
  }
  const definition = {
    schema: "derive.workflow/v1",
    purpose: "Verify ten rounds",
    diagrams: [
      {
        id: "ten-rounds",
        entry: "research",
        nodes: [
          {
            id: "research",
            kind: "context",
            context_ref: contextRef,
            instruction: "Produce round evidence",
            result: "Evidence",
          },
          {
            id: "review",
            kind: "human",
            decision: "Continue or finish",
            options: ["again", "done"],
            resume: "Record the review decision",
          },
          { id: "done", kind: "terminal", result: "Ten verified rounds", terminal: true },
        ],
        routes,
        loops: [
          {
            id: "rounds",
            nodes: ["research", "review"],
            goal: "Complete ten rounds",
            evaluate: "Inspect each result",
            stop: {
              max_attempts: 10,
              stagnation_limit: 10,
              max_minutes: 60,
              human_stop: "Stop on request",
            },
          },
        ],
        scenarios: [
          {
            id: "human",
            kind: "human",
            path: ["research", "review", "research", "review", "done"],
            outcome: "Review requests another round",
          },
          {
            id: "expected",
            kind: "expected",
            path: ["research", "review", "done"],
            outcome: "Complete",
          },
          {
            id: "failure",
            kind: "failure",
            path: ["research"],
            outcome: "Failure remains visible",
          },
        ],
      },
    ],
  }
  return `<!doctype html><html><body><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script><script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(definition)}</script></body></html>`
}

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

  it("includes a route that settles during guarded fan-in creation", async () => {
    const { app, meta, cx, ownerToken, answeringToken } = await setup("mcx-fan-in-race")
    await app.request(
      `/v1/contexts/${cx.id}/access`,
      jsonAs(as(dev.email), { ask_policy: "workspace" }),
    )
    const workflow = await (
      await publishAs(
        app,
        fanInWorkflowHtml(cx.id),
        { title: "Fan-in", contentType: "text/html" },
        as(owner.email),
      )
    ).json()
    const started = await call(app, ownerToken, "use", {
      workflow_run: {
        action: "start",
        short_id: workflow.short_id,
        diagram_id: "fan-in",
        dedupe_key: "fan-in-race",
      },
    })
    const runId = started.workflow_run.id
    const research = { run_id: runId, node_id: "research", attempt: 1 }
    const opened = await call(app, ownerToken, "use", {
      context: cx.id,
      instruction: "Research",
      workflow: research,
      wait: 0,
    })
    expect(
      (
        await answerAs(app, answeringToken, opened.session_id, {
          body_md: "Done",
          state: "answered",
        })
      ).status,
    ).toBe(201)
    await call(app, ownerToken, "use", {
      workflow: { ...research, status: "succeeded", selected_routes: ["left", "right"] },
    })
    const review = (node_id: string) => ({
      run_id: runId,
      node_id,
      attempt: 1,
      status: "succeeded",
      decision: "join",
      selected_routes: ["join"],
    })
    await call(app, ownerToken, "use", { workflow: review("left") })
    const run = await meta.getWorkflowRunById(runId)
    if (!run) throw new Error("Missing run")
    const before = await meta.listWorkflowStepAttempts(runId, run.org_id)
    const left = before.find((item) => item.node_id === "left")
    if (!left) throw new Error("Missing left review")
    const originalCreate = meta.createWorkflowStepAttempt.bind(meta)
    const captured: string[][] = []
    const spy = vi
      .spyOn(meta, "createWorkflowStepAttempt")
      .mockImplementation(async (orgId, input, state) => {
        if (input.node_id === "join") {
          captured.push(JSON.parse(input.route_sources ?? "null"))
          if (captured.length === 1) {
            expect(captured[0]).toEqual([left.id])
            // A real receipt changes the store after the target snapshots its routes.
            // The original guarded insert must reject it; no synthetic conflict is thrown.
            await call(app, ownerToken, "use", { workflow: review("right") })
          }
        }
        return originalCreate(orgId, input, state)
      })
    try {
      const result = await call(app, ownerToken, "use", {
        workflow: {
          run_id: runId,
          node_id: "join",
          attempt: 1,
          status: "succeeded",
          finish_run: "succeeded",
        },
      })
      expect(result.run_status).toBe("succeeded")
      const attempts = await meta.listWorkflowStepAttempts(runId, run.org_id)
      const right = attempts.find((item) => item.node_id === "right")
      if (!right) throw new Error("Missing right review")
      const sources = [left.id, right.id].sort()
      expect(captured).toEqual([[left.id], sources])
      expect(attempts).toHaveLength(4)
      expect(
        JSON.parse(attempts.find((item) => item.node_id === "join")?.route_sources ?? "null"),
      ).toEqual(sources)
    } finally {
      spy.mockRestore()
    }
  })

  it("recovers a lost publish response without creating another artifact or version", async () => {
    const { app, meta, cx, ownerToken, ctx } = await setup(
      "mcx-publish-recovery",
      undefined,
      "editor",
    )
    const workflow = await (
      await publishAs(
        app,
        repeatedWorkflowHtml(cx.id),
        { title: "Publication recovery", contentType: "text/html" },
        as(owner.email),
      )
    ).json()
    const started = await call(app, ownerToken, "use", {
      workflow_run: {
        action: "start",
        short_id: workflow.short_id,
        diagram_id: "ten-rounds",
        dedupe_key: "publish-recovery",
      },
    })
    const runId = started.workflow_run.id
    const ref = { run_id: runId, node_id: "research", attempt: 1, role: "output" }
    const request = {
      title: "Recovered output",
      content: "# First output",
      workspace_access: "none",
      link_role: "none",
      listed: "none",
      workflow: { ...ref, dedupe_key: "first-output" },
    }
    const originalPublish = meta.publishWorkflowVersion.bind(meta)
    const spy = vi.spyOn(meta, "publishWorkflowVersion").mockImplementationOnce(async (input) => {
      await originalPublish(input)
      throw new Error("Simulated response loss after metadata commit")
    })
    const lost = await callRaw(app, ownerToken, "publish", request)
    spy.mockRestore()
    expect(lost.isError).toBe(true)
    const recovered = await call(app, ownerToken, "publish", request)
    expect(recovered).toMatchObject({
      version: 1,
      workflow_publish: { replayed: true, dedupe_key: "first-output" },
      workflow_activity: { status: "recorded", completion: "unconfirmed" },
    })
    expect(recovered.version_url).toMatch(/@v1$/)
    const artifact = await meta.getByShortId(recovered.short_id)
    if (!artifact) throw new Error("Missing recovered artifact")
    expect(await meta.listArtifactMembers(artifact.id)).toMatchObject([{ role: "owner" }])
    expect(await meta.listVersions(artifact.id)).toHaveLength(1)
    const conflict = await callRaw(app, ownerToken, "publish", {
      ...request,
      content: "# Different request",
    })
    expect(conflict.isError).toBe(true)
    expect(conflict.text).toContain("different request")
    const roleConflict = await callRaw(app, ownerToken, "publish", {
      ...request,
      workflow: { ...request.workflow, role: "evidence" },
    })
    expect(roleConflict.isError).toBe(true)

    // Without an explicit key, identical requests still deduplicate opportunistically.
    const revision = { short_id: artifact.short_id, content: "# Second output", workflow: ref }
    const revisions = await Promise.all([
      call(app, ownerToken, "publish", revision),
      call(app, ownerToken, "publish", revision),
    ])
    expect(revisions.map((item) => item.version)).toEqual([2, 2])
    expect(revisions.some((item) => item.workflow_publish.replayed)).toBe(true)
    expect((await call(app, ownerToken, "publish", request)).version).toBe(1)
    expect(await meta.listVersions(artifact.id)).toHaveLength(2)

    const edit = {
      short_id: artifact.short_id,
      base_version: 2,
      edits: [{ old_str: "# Second output", new_str: "# Final output" }],
      workflow: { ...ref, dedupe_key: "final-edit" },
    }
    expect((await call(app, ownerToken, "publish", edit)).version).toBe(3)
    // The original text and base version are stale now. Replay must happen before
    // materialization, not apply the edit again or turn success into a conflict.
    expect(await call(app, ownerToken, "publish", edit)).toMatchObject({
      version: 3,
      workflow_publish: { replayed: true },
    })
    expect(await meta.listVersions(artifact.id)).toHaveLength(3)
    const activity = await meta.listWorkflowArtifactActivity(runId, artifact.org_id)
    expect(activity.map((item) => item.artifact_version).sort()).toEqual([1, 2, 3])
    expect(new Set(activity.map((item) => item.artifact_short_id))).toEqual(
      new Set([artifact.short_id]),
    )
    expect(await meta.listWorkflowStepAttempts(runId, artifact.org_id)).toHaveLength(0)
    const linkedHead = await meta.getVersion(artifact.id, 3)
    if (!linkedHead) throw new Error("Missing linked version")
    const edited = await publishVersion(
      meta,
      ctx.blobs,
      {
        bytes: new TextEncoder().encode("# Later edit"),
        filename: "index.md",
        isBundle: false,
        orgId: artifact.org_id,
        replaceCurrent: { n: 3, blobKey: linkedHead.blob_key },
      },
      artifact.short_id,
    )
    expect(edited.version.n).toBe(4)
    expect((await meta.getVersion(artifact.id, 3))?.blob_key).toBe(linkedHead.blob_key)
    expect((await call(app, ownerToken, "publish", edit)).version).toBe(3)
  })

  it("recovers ten loop rounds without reusing an earlier route or losing exact outputs", async () => {
    const { app, meta, cx, ownerToken, answeringToken } = await setup(
      "mcx-ten-rounds",
      undefined,
      "editor",
    )
    await app.request(
      `/v1/contexts/${cx.id}/access`,
      jsonAs(as(dev.email), { ask_policy: "workspace" }),
    )
    const workflow = await (
      await publishAs(
        app,
        repeatedWorkflowHtml(cx.id),
        { title: "Ten rounds", contentType: "text/html" },
        as(owner.email),
      )
    ).json()
    const start = {
      action: "start",
      short_id: workflow.short_id,
      diagram_id: "ten-rounds",
      dedupe_key: "ten-rounds-recovery",
    }
    const first = await call(app, ownerToken, "use", { workflow_run: start })
    const runId = first.workflow_run.id
    expect((await call(app, ownerToken, "use", { workflow_run: start })).workflow_run.id).toBe(
      runId,
    )
    // Force a database conflict at each kind of attempt creation. Both calls must
    // reload and retry without duplicating a Context session or losing the receipt.
    const originalCreate = meta.createWorkflowStepAttempt.bind(meta)
    const conflicted = new Set<string>()
    const createSpy = vi
      .spyOn(meta, "createWorkflowStepAttempt")
      .mockImplementation(async (orgId, input, state) => {
        if (input.attempt === 2 && !conflicted.has(input.kind)) {
          conflicted.add(input.kind)
          throw new WorkflowAttemptStateConflictError()
        }
        return originalCreate(orgId, input, state)
      })
    let evidenceId: string | undefined
    for (let round = 1; round <= 10; round++) {
      const ref = { run_id: runId, node_id: "research", attempt: round }
      const request = { context: cx.id, instruction: `Round ${round}`, workflow: ref, wait: 0 }
      const opens = await Promise.all(
        Array.from({ length: round === 5 ? 2 : 1 }, () => call(app, ownerToken, "use", request)),
      )
      const opened = opens[0]
      expect(opened.session_id).toBeTruthy()
      expect(new Set(opens.map((result) => result.session_id)).size).toBe(1)
      // A lost response is recovered by replaying the same workflow reference.
      if (round === 1 || round === 5)
        expect((await call(app, ownerToken, "use", request)).session_id).toBe(opened.session_id)
      const published = await call(app, ownerToken, "publish", {
        ...(evidenceId ? { short_id: evidenceId } : { title: "Round evidence" }),
        content: `# Round ${round}`,
        workflow: { ...ref, role: "output" },
      })
      evidenceId = published.short_id
      expect(published.version).toBe(round)
      expect(published.workflow_activity.completion).toBe("unconfirmed")
      expect(
        (
          await answerAs(app, answeringToken, opened.session_id, {
            body_md: `Round ${round} complete`,
            state: "answered",
            result_artifact_id: evidenceId,
          })
        ).status,
      ).toBe(201)
      const receipt = {
        ...ref,
        status: "succeeded",
        selected_routes: ["review"],
        output: { round },
      }
      expect((await call(app, ownerToken, "use", { workflow: receipt })).attempt_status).toBe(
        "succeeded",
      )
      expect((await call(app, ownerToken, "use", { workflow: receipt })).attempt_status).toBe(
        "succeeded",
      )
      const conflict = await callRaw(app, ownerToken, "use", {
        workflow: { ...receipt, output: { round: 999 } },
      })
      expect(conflict.isError).toBe(true)
      if (round === 2) {
        const premature = await callRaw(app, ownerToken, "use", {
          ...request,
          workflow: { ...ref, attempt: 3 },
        })
        expect(premature.isError).toBe(true)
      }
      if (round === 5) {
        const updated = await publishAs(
          app,
          workflowHtml(cx.id),
          { contentType: "text/html" },
          as(owner.email),
          workflow.short_id,
        )
        expect(updated.status).toBe(201)
        expect((await call(app, ownerToken, "use", { workflow_run: start })).workflow_run.id).toBe(
          runId,
        )
      }
      if (round === 10) {
        const exhausted = await callRaw(app, ownerToken, "use", {
          workflow: {
            run_id: runId,
            node_id: "review",
            attempt: round,
            status: "succeeded",
            decision: "again",
            selected_routes: ["research"],
          },
        })
        expect(exhausted.isError).toBe(true)
        expect(exhausted.text).toContain("10-attempt limit")
      }
      expect(
        (
          await call(app, ownerToken, "use", {
            workflow: {
              run_id: runId,
              node_id: "review",
              attempt: round,
              status: "succeeded",
              decision: round === 10 ? "done" : "again",
              selected_routes: [round === 10 ? "done" : "research"],
            },
          })
        ).attempt_status,
      ).toBe("succeeded")
    }
    const impossible = await callRaw(app, ownerToken, "publish", {
      short_id: evidenceId,
      content: "# Impossible round",
      workflow: { run_id: runId, node_id: "research", attempt: 11, role: "output" },
    })
    expect(impossible.isError).toBe(true)
    expect(impossible.text).toContain("limited to 10 attempts")
    expect((await meta.getByShortId(evidenceId ?? ""))?.current_version).toBe(10)
    const final = {
      run_id: runId,
      node_id: "done",
      attempt: 1,
      status: "succeeded",
      finish_run: "succeeded",
    }
    expect((await call(app, ownerToken, "use", { workflow: final })).run_status).toBe("succeeded")
    expect((await call(app, ownerToken, "use", { workflow: final })).run_status).toBe("succeeded")
    const run = await meta.getWorkflowRunById(runId)
    if (!run) throw new Error("Missing run")
    expect(run.workflow_version).toBe(1)
    const attempts = await meta.listWorkflowStepAttempts(runId, run.org_id)
    expect(attempts).toHaveLength(21)
    expect(await meta.listSessions(cx.id)).toHaveLength(10)
    for (let round = 2; round <= 10; round++) {
      const current = attempts.find((item) => item.node_id === "research" && item.attempt === round)
      const priorReview = attempts.find(
        (item) => item.node_id === "review" && item.attempt === round - 1,
      )
      expect(JSON.parse(current?.route_sources ?? "null")).toEqual([priorReview?.id])
    }
    const inspected = await call(app, ownerToken, "use", {
      workflow_run: { action: "inspect", run_id: runId },
    })
    expect(inspected.attempts).toHaveLength(21)
    const secondResearch = inspected.attempts.find(
      (item: { node_id: string; attempt: number }) =>
        item.node_id === "research" && item.attempt === 2,
    )
    expect(secondResearch.route_sources).toEqual([
      attempts.find((item) => item.node_id === "review" && item.attempt === 1)?.id,
    ])
    expect([...conflicted].sort()).toEqual(["context", "human"])
    expect(createSpy.mock.calls.every(([, , state]) => state !== undefined)).toBe(true)
    createSpy.mockRestore()
    const activity = await meta.listWorkflowArtifactActivity(runId, run.org_id)
    expect(activity).toHaveLength(10)
    expect(
      activity
        .map((item) => [item.attempt, item.artifact_version] as const)
        .sort((a, b) => a[0] - b[0]),
    ).toEqual(Array.from({ length: 10 }, (_, i) => [i + 1, i + 1]))
  })

  it.each([
    "failed",
    "cancelled",
  ] as const)("seals a %s Context receipt with its details exactly once", async (status) => {
    const { app, meta, cx, ownerToken, answeringToken } = await setup(`mcx-receipt-${status}`)
    await app.request(
      `/v1/contexts/${cx.id}/access`,
      jsonAs(as(dev.email), { ask_policy: "workspace" }),
    )
    const workflow = await (
      await publishAs(
        app,
        workflowHtml(cx.id),
        { title: "Failure receipt", contentType: "text/html" },
        as(owner.email),
      )
    ).json()
    const start = await call(app, ownerToken, "use", {
      workflow_run: {
        action: "start",
        short_id: workflow.short_id,
        diagram_id: "research-once",
        dedupe_key: "failure",
      },
    })
    const ref = { run_id: start.workflow_run.id, node_id: "research", attempt: 1 }
    const opened = await call(app, ownerToken, "use", {
      context: cx.id,
      instruction: "Attempt research",
      workflow: ref,
      wait: 0,
    })
    if (status === "failed")
      expect(
        (
          await answerAs(app, answeringToken, opened.session_id, {
            body_md: "Provider failed",
            state: "failed",
          })
        ).status,
      ).toBe(201)
    else
      expect(
        (
          await app.request(
            `/v1/sessions/${opened.session_id}`,
            jsonAs(as(owner.email), { state: "closed" }, "PATCH"),
          )
        ).status,
      ).toBe(200)
    await call(app, ownerToken, "use", { session_id: opened.session_id, wait: 0 })
    const orgId = (await meta.getWorkflowRunById(ref.run_id))?.org_id ?? ""
    const observed = await meta.getWorkflowStepAttemptBySession(opened.session_id, orgId)
    expect(observed?.status).toBe(status)
    const receipt = {
      ...ref,
      status,
      selected_routes: [],
      error: "Provider did not return a result",
      output: { round: 1 },
      route_basis: "Stop after failure",
      finish_run: status,
    }
    expect((await call(app, ownerToken, "use", { workflow: receipt })).run_status).toBe(status)
    expect((await call(app, ownerToken, "use", { workflow: receipt })).run_status).toBe(status)
    const final = await meta.getWorkflowStepAttemptBySession(opened.session_id, orgId)
    expect(final).toMatchObject({
      error: receipt.error,
      output: JSON.stringify(receipt.output),
      route_basis: receipt.route_basis,
      finished_at: observed?.finished_at,
    })
    const conflict = await callRaw(app, ownerToken, "use", {
      workflow: { ...receipt, error: "Changed history" },
    })
    expect(conflict.isError).toBe(true)
    expect((await meta.getWorkflowStepAttemptBySession(opened.session_id, orgId))?.error).toBe(
      receipt.error,
    )
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
    expect(denied.text).toMatch(/No Context/i)

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

describe("imported papers over MCP — read-only, cited, never run", () => {
  it("find shows the import, read loads the pointer and the citation, use refuses", async () => {
    const ID = "2405.00001"
    const tex =
      "\\documentclass{article}\n\\begin{document}\n\\begin{abstract}\nAn abstract.\n\\end{abstract}\n\\section{Intro}\nHello.\n\\end{document}\n"
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/${ID}v1</id><published>2024-05-01T00:00:00Z</published><title>Reading Papers</title><summary>An abstract.</summary><author><name>Ada Lovelace</name></author><arxiv:primary_category term="cs.DL"/></entry></feed>`
    const bibtex = `@misc{lovelace2024reading,\n  title={Reading Papers},\n  author={Ada Lovelace},\n  year={2024},\n  eprint={${ID}},\n  archivePrefix={arXiv}\n}`
    const stub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const u = new URL(url)
      if (u.hostname === "export.arxiv.org") return new Response(atom)
      if (u.pathname.startsWith("/src/"))
        return new Response(gzipSync(tarSync({ "main.tex": tex })), { status: 200 })
      if (u.pathname.startsWith("/bibtex/")) return new Response(bibtex)
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch
    const made = makeAuthedApp("mcx-import", [owner, dev], "editor", { deps: { fetch: stub } })
    const { app, meta, ctx } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const ownerBot = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
    ).json()
    const queued = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(dev.email), { url: `https://arxiv.org/abs/${ID}` }),
      )
    ).json()
    // While it is on its way, find already lists it as an import (no online flag: nothing
    // will ever poll it), and read says so.
    const pending = contextsOf(await call(app, ownerBot.token, "find", {}))
    expect(pending).toMatchObject([
      { id: queued.id, import: { source: "arxiv", ref: ID, status: "pending" } },
    ])
    expect(pending[0].online).toBeUndefined()

    let t = Date.parse("2030-06-01T00:00:00.000Z")
    expect(
      await runImportTick({
        meta,
        blobs: ctx.blobs,
        bus: ctx.bus,
        notify: ctx.notify,
        background: ctx.background,
        baseUrl: "http://derive.test",
        fetch: stub,
        now: () => t,
        sleep: async (ms) => {
          t += ms
        },
        caps: {
          compressedBytes: 1024 * 1024,
          inflatedBytes: 4 * 1024 * 1024,
          bundleBytes: 4 * 1024 * 1024,
          files: 200,
        },
      }),
    ).toBe(1)

    const rows = contextsOf(await call(app, ownerBot.token, "find", {}))
    expect(rows).toMatchObject([
      { id: queued.id, name: "Reading Papers", import: { status: "ready", error: null } },
    ])
    expect(rows[0].note).toContain("takes no runs")

    const pkg = await call(app, ownerBot.token, "read", { short_id: queued.id })
    expect(pkg.import).toMatchObject({ source: "arxiv", ref: ID, status: "ready", version: 1 })
    // One artifact: the Context's own, named as its paper.
    expect(pkg.documents).toEqual([
      {
        short_id: queued.manifest_short_id,
        title: "Reading Papers",
        kind: "bundle",
        role: "paper",
      },
    ])
    // The summary is computed from the paper, never stored beside it.
    expect(pkg.manifest.content).toContain("# Reading Papers")
    expect(pkg.manifest.content).toContain("Ada Lovelace · arXiv:2405.00001v1")
    expect(pkg.manifest.content).toContain("## Abstract\n\nAn abstract.")
    expect(pkg.manifest.content).toContain("```bibtex\n@misc{lovelace2024reading")
    expect(pkg.manifest.content).not.toContain("\\documentclass")
    expect(pkg.how).toContain("takes no runs")

    const paper = await call(app, ownerBot.token, "read", { short_id: pkg.documents[0].short_id })
    expect(paper.entry).toBe("main.tex")
    expect(paper.citation).toEqual({ key: "lovelace2024reading", bibtex })
    expect(paper.next).toContain("\\cite{lovelace2024reading}")
    // The whole point of the source being kept: an agent asked about the method reads the
    // paper's own LaTeX, macros and all, not the prose projection a person sees.
    const body = await callRaw(app, ownerBot.token, "read", {
      short_id: pkg.documents[0].short_id,
      section: "main.tex",
    })
    expect(body.text).toContain("format: latex (source)")
    expect(body.text).toContain("\\documentclass{article}")
    expect(body.text).toContain("\\begin{abstract}")
    expect(body.text).toContain("Hello.")

    const refused = await callRaw(app, ownerBot.token, "use", {
      context: queued.id,
      instruction: "summarize",
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("imported paper")
    expect(refused.text).toContain("takes no runs")
  })

  it("reads the implementation beside the paper, summarised rather than listed", async () => {
    const ID = "2405.00002"
    const tex =
      "\\documentclass{article}\n\\begin{document}\n\\section{Method}\nSee the code.\n\\end{document}\n"
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/${ID}v1</id><published>2024-05-01T00:00:00Z</published><title>Splatting</title><summary>An abstract.</summary><author><name>Ada Lovelace</name></author><arxiv:primary_category term="cs.CV"/></entry></feed>`
    // A repository with more files than any outline should ever print.
    const repo: Record<string, string> = {
      "r-abc/train.py": "def train():\n    return 42\n",
      "r-abc/README.md": "# Splatting\n",
    }
    for (let i = 0; i < 140; i++) repo[`r-abc/scene/part${i}/mod.py`] = `# module ${i}\n`
    const stub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const u = new URL(url)
      if (u.hostname === "export.arxiv.org") return new Response(atom)
      if (u.pathname.startsWith("/src/"))
        return new Response(gzipSync(tarSync({ "main.tex": tex })), { status: 200 })
      if (u.pathname.startsWith("/bibtex/")) return new Response("not bibtex", { status: 404 })
      if (u.pathname.startsWith("/o/r/tar.gz/"))
        return new Response(gzipSync(tarSync(repo)), { status: 200 })
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch
    const made = makeAuthedApp("mcx-import-code", [owner, dev], "editor", { deps: { fetch: stub } })
    const { app, meta, ctx } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const ownerBot = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
    ).json()
    const queued = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(dev.email), {
          url: `https://arxiv.org/abs/${ID}`,
          code_url: "https://github.com/o/r",
        }),
      )
    ).json()
    let t = Date.parse("2030-06-01T00:00:00.000Z")
    const caps = {
      compressedBytes: 1024 * 1024,
      inflatedBytes: 4 * 1024 * 1024,
      bundleBytes: 4 * 1024 * 1024,
      files: 400,
    }
    expect(
      await runImportTick({
        meta,
        blobs: ctx.blobs,
        bus: ctx.bus,
        notify: ctx.notify,
        background: ctx.background,
        baseUrl: "http://derive.test",
        fetch: stub,
        now: () => t,
        sleep: async (ms) => {
          t += ms
        },
        caps,
        repoCaps: {
          compressedBytes: 1024 * 1024,
          inflatedBytes: 4 * 1024 * 1024,
          totalBytes: 4 * 1024 * 1024,
          files: 400,
          depth: 3,
          repos: 5,
        },
      }),
    ).toBe(1)

    const pkg = await call(app, ownerBot.token, "read", { short_id: queued.id })
    const paper = await call(app, ownerBot.token, "read", { short_id: pkg.documents[0].short_id })
    // The paper's own pages stay the pages: 142 repository files do not bury them.
    expect(paper.entry).toBe("main.tex")
    expect(paper.pages.map((p: { path: string }) => p.path)).toEqual(["main.tex", "CITATION.bib"])
    // The implementation is a map with a count, not a listing.
    expect(paper.code).toMatchObject({ root: "code/", files: 142, more: 42 })
    expect(paper.code.paths).toHaveLength(100)
    expect(paper.code.paths).toContain("code/train.py")
    expect(paper.next).toContain("code/")

    // Any path in the repository reads, listed in that sample or not.
    const listed = await callRaw(app, ownerBot.token, "read", {
      short_id: pkg.documents[0].short_id,
      section: "code/train.py",
    })
    expect(listed.text).toContain("def train():")
    const unlisted = await callRaw(app, ownerBot.token, "read", {
      short_id: pkg.documents[0].short_id,
      section: "code/scene/part139/mod.py",
    })
    expect(unlisted.text).toContain("# module 139")

    // A path that is in neither: the error names the paper's pages and says the code is
    // there, without printing 142 paths back.
    const missing = await callRaw(app, ownerBot.token, "read", {
      short_id: pkg.documents[0].short_id,
      section: "code/nope.py",
    })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain("142 files under `code/`")
    expect(missing.text.length).toBeLessThan(500)
  })
})
