import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import {
  previewWorkflow as previewCoreWorkflow,
  workflowRunInstruction,
} from "../../core/src/workflow"
import {
  factJson,
  formatWorkflowPreview,
  previewWorkflowSource,
  syncWorkflowSource,
} from "../src/workflow.js"
import {
  codexWorkflowArgs,
  exchangeWorkflowCapability,
  githubOidcRequest,
  requestGithubOidc,
  runGithubWorkflowHarness,
  workflowAgentEnv,
} from "../src/workflow-run.js"

const dirs = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-workflow-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const fakeChild = (code = 0, { stdout = null, stderr = null } = {}) => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  queueMicrotask(() => {
    child.stdout.write(
      stdout ?? `${JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call" } })}\n`,
    )
    if (stderr) child.stderr.write(stderr)
    child.emit("close", code, null)
  })
  return child
}

const workflowPage = () => {
  const linked = {
    schema: "derive.linked-bundle/v1",
    purpose: "Publish a weekly brief after product review",
    members: [],
    diagrams: [
      {
        id: "weekly-brief",
        title: "Weekly brief",
        type: "graph",
        nodes: [
          { id: "research", label: "Research signals" },
          { id: "review", label: "Product review" },
          { id: "publish", label: "Publish brief" },
        ],
        edges: [
          { from: "research", to: "review" },
          { from: "review", to: "research", label: "revise" },
          { from: "review", to: "publish", label: "approved" },
        ],
      },
    ],
  }
  const workflow = {
    schema: "derive.workflow/v1",
    purpose: "Publish a weekly brief after product review",
    forbidden: ["Publish without approval"],
    diagrams: [
      {
        id: "weekly-brief",
        entry: "research",
        nodes: [
          {
            id: "research",
            kind: "context",
            context_ref: "signal-researcher",
            instruction: "Produce this week's evidence-backed brief.",
            result: "A cited draft brief",
          },
          {
            id: "review",
            kind: "human",
            decision: "Approve or request one revision",
            options: ["approve", "revise"],
            resume: "The product lead chooses an option",
          },
          {
            id: "publish",
            kind: "context",
            context_ref: "brief-publisher",
            instruction: "Publish the approved brief.",
            result: "A published Derive artifact",
            terminal: true,
            effects: [
              {
                kind: "write",
                description: "Publish the approved brief",
                gate: "human",
                approval_ref: "review",
              },
            ],
          },
        ],
        routes: [
          { from: "research", to: "review", when: "always" },
          { from: "review", to: "research", when: "revise" },
          { from: "review", to: "publish", when: "approve" },
        ],
        loops: [
          {
            id: "brief-repair",
            nodes: ["research", "review"],
            goal: "Reach an approvable brief",
            evaluate: "Check evidence, clarity, and scope",
            stop: {
              max_attempts: 2,
              stagnation_limit: 1,
              max_minutes: 20,
              human_stop: "The product lead stops or changes the brief",
            },
          },
        ],
        scenarios: [
          {
            id: "expected",
            kind: "expected",
            path: ["research", "review", "publish"],
            outcome: "Approved brief is published",
          },
          {
            id: "failure",
            kind: "failure",
            path: ["research"],
            outcome: "Failed context session is visible and the run stops",
          },
          {
            id: "revision",
            kind: "human",
            path: ["research", "review", "research", "review", "publish"],
            outcome: "One revision lands before approval",
          },
        ],
      },
    ],
  }
  return `<!doctype html><html><body><script data-fact="bundle-manifest" type="application/derive-facts">${JSON.stringify(linked)}</script><script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(workflow)}</script></body></html>`
}

describe("workflow preview", () => {
  it("scaffolds a graph-first workflow and points cold start to Preview", () => {
    const dir = join(tmp(), "starter")
    const bin = join(import.meta.dirname, "..", "bin", "derive.js")
    const init = spawnSync(
      process.execPath,
      [bin, "init", dir, "--template", "workflow", "--title", "Weekly brief"],
      { encoding: "utf8" },
    )
    expect(init.status).toBe(0)
    expect(init.stdout).toContain("derive workflow sync workflow.html")

    const preview = spawnSync(process.execPath, [bin, "workflow", "preview", "workflow.html"], {
      cwd: dir,
      encoding: "utf8",
    })
    expect(preview.status).toBe(0)
    expect(preview.stdout).toContain("Preview only — no context session has started")
    expect(preview.stdout).toContain("Context sessions on explicit run")
    expect(preview.stdout).toContain("Run with my agent")
  })

  it("syncs visible topology from the runnable definition while preserving authored state", () => {
    const source = workflowPage()
    const bundle = factJson(source, "bundle-manifest").value
    bundle.diagrams[0].nodes = [
      { id: "research", label: "Evidence scan", state: "active", confidence: { level: "high" } },
      { id: "ghost", label: "Removed step", state: "blocked" },
    ]
    bundle.diagrams[0].edges = [{ from: "research", to: "ghost", label: "old" }]
    const drifted = source.replace(
      /(<script data-fact="bundle-manifest" type="application\/derive-facts">)[\s\S]*?(<\/script>)/,
      (_match, open, close) => `${open}${JSON.stringify(bundle)}${close}`,
    )
    expect(previewWorkflowSource(drifted).status).toBe("needs-changes")

    const synced = syncWorkflowSource(drifted)
    const visible = factJson(synced.source, "bundle-manifest").value.diagrams[0]
    expect(visible.nodes.map((node) => node.id)).toEqual(["research", "review", "publish"])
    expect(visible.nodes[0]).toMatchObject({
      label: "Evidence scan",
      state: "active",
      confidence: { level: "high" },
    })
    expect(visible.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      "research->review",
      "review->research",
      "review->publish",
    ])
    expect(previewWorkflowSource(synced.source).status).toBe("ready")
  })

  it("derive workflow sync writes the projection and runs the same Preview gate", () => {
    const dir = tmp()
    const file = join(dir, "workflow.html")
    writeFileSync(
      file,
      workflowPage().replace(
        '"id":"publish","label":"Publish brief"',
        '"id":"stale","label":"Stale"',
      ),
    )
    const bin = join(import.meta.dirname, "..", "bin", "derive.js")
    const result = spawnSync(process.execPath, [bin, "workflow", "sync", file], {
      cwd: dir,
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Visible graph synced")
    expect(result.stdout).toContain("Ready to run")
    expect(factJson(readFileSync(file, "utf8"), "bundle-manifest").value.diagrams[0].nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "publish" })]),
    )
  })

  it("does not write a projected graph until the full Preview is Ready", () => {
    const dir = tmp()
    const file = join(dir, "workflow.html")
    const broken = workflowPage()
      .replace('"id":"publish","label":"Publish brief"', '"id":"stale","label":"Stale"')
      .replace('"max_attempts":2', '"max_attempts":0')
    writeFileSync(file, broken)
    const bin = join(import.meta.dirname, "..", "bin", "derive.js")
    const result = spawnSync(process.execPath, [bin, "workflow", "sync", file], {
      cwd: dir,
      encoding: "utf8",
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Visible graph not written")
    expect(result.stdout).toContain("Needs changes")
    expect(readFileSync(file, "utf8")).toBe(broken)
  })

  it("extracts facts without executing HTML and matches core's ready preview", () => {
    const source = workflowPage()
    expect(factJson(source, "workflow-definition").error).toBeNull()
    const preview = previewWorkflowSource(source)
    expect(preview).toEqual(previewCoreWorkflow(source))
    expect(formatWorkflowPreview(preview)).toContain("✓ Ready to run")
    expect(formatWorkflowPreview(preview)).toContain("Will pause")
    expect(formatWorkflowPreview(preview)).toContain("Context sessions on explicit run")
    expect(formatWorkflowPreview(preview)).toContain("Research signals → signal-researcher")
    expect(formatWorkflowPreview(preview)).toContain("Cannot do")
  })

  it("returns one Needs changes result instead of a separate validation gate", () => {
    const source = workflowPage().replace('"gate":"human"', '"gate":"none"')
    const preview = previewWorkflowSource(source)
    expect(preview.status).toBe("needs-changes")
    expect(preview.errors).toEqual(expect.arrayContaining([expect.stringContaining("WF-05")]))
    expect(formatWorkflowPreview(preview)).toMatch(/^✗ Needs changes/)
  })

  it("blocks a missing entry and an approval that does not name a human node", () => {
    const source = workflowPage()
      .replace('"entry":"research"', '"entry":"missing"')
      .replace('"approval_ref":"review"', '"approval_ref":"publish"')
    const preview = previewWorkflowSource(source)
    expect(preview.status).toBe("needs-changes")
    expect(preview.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("requires an entry node"),
        expect.stringContaining("approval_ref must name a human node"),
      ]),
    )
  })

  it("does not route an unknown human response through approval as a fallback", () => {
    const source = workflowPage().replace(
      '"from":"review","to":"publish","when":"approve"',
      '"from":"review","to":"publish","when":"approve","fallback":true',
    )
    expect(previewWorkflowSource(source).errors).toContain(
      'WF-02 human node "review" routes must match its options exactly; fallback is not allowed',
    )
  })

  it("exposes the same result through derive workflow preview and --json", () => {
    const dir = tmp()
    const file = join(dir, "workflow.html")
    writeFileSync(file, workflowPage())
    const bin = join(import.meta.dirname, "..", "bin", "derive.js")
    const friendly = spawnSync(process.execPath, [bin, "workflow", "preview", file], {
      cwd: dir,
      encoding: "utf8",
    })
    expect(friendly.status).toBe(0)
    expect(friendly.stdout).toContain("✓ Ready to run")

    const machine = spawnSync(process.execPath, [bin, "workflow", "preview", file, "--json"], {
      cwd: dir,
      encoding: "utf8",
    })
    expect(machine.status).toBe(0)
    expect(JSON.parse(machine.stdout)).toMatchObject({
      status: "ready",
      purpose: "Publish a weekly brief after product review",
    })
  })
})

describe("workflow Preview parity with core", () => {
  it.each([
    ["ready", (source) => source],
    [
      "malformed workflow JSON",
      (source) => source.replace('"schema":"derive.workflow/v1"', '"schema":'),
    ],
    ["unsafe external effect", (source) => source.replace('"gate":"human"', '"gate":"none"')],
    [
      "human fallback",
      (source) =>
        source.replace(
          '"from":"review","to":"publish","when":"approve"',
          '"from":"review","to":"publish","when":"approve","fallback":true',
        ),
    ],
    ["missing entry", (source) => source.replace('"entry":"research"', '"entry":"missing"')],
    [
      "oversized workflow fact",
      (source) =>
        source.replace('"forbidden":[', `"padding":"${"x".repeat(33 * 1024)}","forbidden":[`),
    ],
  ])("keeps %s behavior identical", (_name, mutate) => {
    const source = mutate(workflowPage())
    expect(previewWorkflowSource(source)).toEqual(previewCoreWorkflow(source))
  })
})

describe("GitHub Actions one-shot workflow harness", () => {
  const oidcUrl = "https://pipelines.actions.githubusercontent.com/example/oidc?api-version=2.0"
  const requestToken = "github-request-value"
  const oidcToken = "signed-oidc-value"
  const nonce = "nonce-value-abcdefghijklmnop"
  const runId = "wfr_12345678"
  const expiresAt = "2030-01-01T00:00:00.000Z"

  it("inlines the exact validated graph so the capability can remain use-only", () => {
    const source = workflowPage()
    const instruction = workflowRunInstruction({
      shortId: "graph-123",
      version: 7,
      diagramId: "weekly-brief",
      runId,
      baseUrl: "https://derive.to",
      definition: factJson(source, "workflow-definition").value,
      manifest: factJson(source, "bundle-manifest").value,
    })
    expect(instruction).toContain("PINNED WORKFLOW-DEFINITION")
    expect(instruction).toContain('"context_ref":"signal-researcher"')
    expect(instruction).toContain("PINNED BUNDLE-MANIFEST")
    expect(instruction).not.toContain("read({")
  })

  it("requests GitHub OIDC with the fixed audience and bearer kept in a header", async () => {
    const calls = []
    const value = await requestGithubOidc({
      requestUrl: oidcUrl,
      requestToken,
      retryDelays: [0],
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({ value: oidcToken })
      },
    })
    expect(value).toBe(oidcToken)
    expect(githubOidcRequest(oidcUrl)).toContain("audience=derive-graph-runner")
    expect(calls).toEqual([
      expect.objectContaining({
        url: expect.stringContaining("audience=derive-graph-runner"),
        init: expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ authorization: `Bearer ${requestToken}` }),
        }),
      }),
    ])
    expect(calls[0].url).not.toContain(requestToken)
  })

  it("retries a lost exchange response with the exact same nonce and OIDC assertion", async () => {
    const calls = []
    const exchange = await exchangeWorkflowCapability({
      server: "https://derive.to",
      runId,
      nonce,
      oidcToken,
      retryDelays: [0, 0],
      sleepImpl: async () => {},
      now: Date.parse("2029-01-01T00:00:00.000Z"),
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return calls.length === 1
          ? jsonResponse({}, 503)
          : jsonResponse({
              token: "workflow-capability-value",
              instruction: "Run the pinned graph.",
              expiresAt,
              mcpUrl: "https://derive.to/mcp",
            })
      },
    })
    expect(exchange).toMatchObject({
      token: "workflow-capability-value",
      instruction: "Run the pinned graph.",
      mcpUrl: "https://derive.to/mcp",
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(JSON.parse(calls[0].init.body)).toEqual({ nonce, oidcToken })
  })

  it("rejects an expired capability and an MCP URL that could exfiltrate it", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        token: "workflow-capability-value",
        instruction: "Pinned.",
        expiresAt,
        mcpUrl: "https://attacker.example/mcp",
      })
    await expect(
      exchangeWorkflowCapability({
        server: "https://derive.to",
        runId,
        nonce,
        oidcToken,
        fetchImpl,
        retryDelays: [0],
        now: Date.parse("2029-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/another origin/)
    await expect(
      exchangeWorkflowCapability({
        server: "https://derive.to",
        runId,
        nonce,
        oidcToken,
        fetchImpl: async () =>
          jsonResponse({
            token: "workflow-capability-value",
            instruction: "Pinned.",
            expiresAt: "2020-01-01T00:00:00.000Z",
          }),
        retryDelays: [0],
        now: Date.parse("2029-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/expired/)
  })

  it("spawns exactly one Codex process with only use and no exchange secret in argv or logs", async () => {
    const fetchCalls = []
    const spawnCalls = []
    const logs = []
    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: oidcUrl,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
      DERIVE_EXCHANGE_NONCE: nonce,
      DERIVE_WORKFLOW_RUN_ID: runId,
      DERIVE_TOKEN: "ambient-derive-value",
      OPENAI_API_KEY: "owner-model-value",
      PATH: "/usr/bin",
    }
    const code = await runGithubWorkflowHarness({
      runId,
      nonce,
      server: "https://derive.to",
      requestUrl: oidcUrl,
      requestToken,
      env,
      timeoutMs: 60_000,
      retryDelays: [0],
      now: Date.parse("2029-01-01T00:00:00.000Z"),
      log: (line) => logs.push(line),
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init })
        return fetchCalls.length === 1
          ? jsonResponse({ value: oidcToken })
          : jsonResponse({
              token: "workflow-capability-value",
              instruction: "Execute exact pinned v7 graph.",
              expiresAt,
            })
      },
      spawnImpl: (bin, args, options) => {
        spawnCalls.push({ bin, args, options })
        return fakeChild(0)
      },
    })
    expect(code).toBe(0)
    expect(spawnCalls).toHaveLength(1)
    const [call] = spawnCalls
    expect(call.bin).toBe("codex")
    expect(call.args.join("\n")).toContain('mcp_servers.derive.enabled_tools=["use"]')
    expect(call.args.join("\n")).toContain("Execute exact pinned v7 graph.")
    expect(call.options.env).toMatchObject({
      OPENAI_API_KEY: "owner-model-value",
      DERIVE_WORKFLOW_TOKEN: "workflow-capability-value",
    })
    for (const removed of [
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "DERIVE_EXCHANGE_NONCE",
      "DERIVE_WORKFLOW_RUN_ID",
      "DERIVE_TOKEN",
    ])
      expect(call.options.env[removed]).toBeUndefined()
    const observable = JSON.stringify({ args: call.args, logs })
    for (const secret of [requestToken, oidcToken, nonce, "workflow-capability-value"])
      expect(observable).not.toContain(secret)
    expect(logs).toContain("[codex] → mcp_tool_call")
  })

  it("passes the one Codex process failure through as the command exit status", async () => {
    const responses = [
      jsonResponse({ value: oidcToken }),
      jsonResponse({
        token: "workflow-capability-value",
        instruction: "Pinned.",
        expiresAt,
      }),
    ]
    const code = await runGithubWorkflowHarness({
      runId,
      nonce,
      server: "https://derive.to",
      requestUrl: oidcUrl,
      requestToken,
      env: {},
      timeoutMs: 60_000,
      retryDelays: [0],
      now: Date.parse("2029-01-01T00:00:00.000Z"),
      log: () => {},
      fetchImpl: async () => responses.shift(),
      spawnImpl: () => fakeChild(17),
    })
    expect(code).toBe(17)
  })

  it("classifies a provider authentication failure without echoing raw diagnostics", async () => {
    const logs = []
    const rawDiagnostic =
      "401 Unauthorized from wss://api.openai.com with leaked-secret-owner-model-value"
    const responses = [
      jsonResponse({ value: oidcToken }),
      jsonResponse({
        token: "workflow-capability-value",
        instruction: "Pinned.",
        expiresAt,
      }),
    ]
    const code = await runGithubWorkflowHarness({
      runId,
      nonce,
      server: "https://derive.to",
      requestUrl: oidcUrl,
      requestToken,
      env: {},
      timeoutMs: 60_000,
      retryDelays: [0],
      now: Date.parse("2029-01-01T00:00:00.000Z"),
      log: (line) => logs.push(line),
      fetchImpl: async () => responses.shift(),
      spawnImpl: () => fakeChild(1, { stderr: rawDiagnostic }),
    })
    expect(code).toBe(1)
    expect(logs).toContain(
      "Codex provider authentication failed. Verify OPENAI_API_KEY or the configured workload identity in this GitHub environment.",
    )
    expect(JSON.stringify(logs)).not.toContain(rawDiagnostic)
    expect(JSON.stringify(logs)).not.toContain("leaked-secret-owner-model-value")
  })

  it("keeps the capability out of Codex argv while preserving owner model configuration", () => {
    const args = codexWorkflowArgs({
      instruction: "Pinned graph.",
      mcpUrl: "https://derive.to/mcp",
      model: "gpt-owner-choice",
    })
    expect(args).toContain("gpt-owner-choice")
    expect(args.join(" ")).toContain("bearer_token_env_var")
    expect(args.join(" ")).not.toContain("workflow-capability-value")
    expect(
      workflowAgentEnv(
        {
          CODEX_HOME: "/repo-owned/codex",
          OPENAI_API_KEY: "owner-model-value",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
        },
        "workflow-capability-value",
      ),
    ).toEqual({
      CODEX_HOME: "/repo-owned/codex",
      OPENAI_API_KEY: "owner-model-value",
      DERIVE_WORKFLOW_TOKEN: "workflow-capability-value",
    })
  })

  it("configures a custom Responses provider without putting its credential in argv", () => {
    const args = codexWorkflowArgs({
      instruction: "Pinned graph.",
      mcpUrl: "https://derive.to/mcp",
      model: "accounts/example/models/agent",
      provider: {
        baseUrl: "https://inference.example/v1/",
        apiKeyEnv: "OWNER_INFERENCE_KEY",
      },
    })
    const observable = args.join("\n")
    expect(observable).toContain('model_provider="derive-workflow-provider"')
    expect(observable).toContain('base_url="https://inference.example/v1"')
    expect(observable).toContain('env_key="OWNER_INFERENCE_KEY"')
    expect(observable).toContain('wire_api="responses"')
    expect(observable).toContain("requires_openai_auth=false")
    expect(observable).not.toContain("owner-inference-secret")
  })

  it("rejects unsafe custom provider configuration before spawning Codex", () => {
    expect(() =>
      codexWorkflowArgs({
        instruction: "Pinned graph.",
        mcpUrl: "https://derive.to/mcp",
        model: "agent",
        provider: { baseUrl: "http://inference.example/v1", apiKeyEnv: "OWNER_KEY" },
      }),
    ).toThrow(/HTTPS/)
    expect(() =>
      codexWorkflowArgs({
        instruction: "Pinned graph.",
        mcpUrl: "https://derive.to/mcp",
        model: "agent",
        provider: { baseUrl: "https://inference.example/v1", apiKeyEnv: "OWNER-KEY" },
      }),
    ).toThrow(/environment name/)
  })
})
