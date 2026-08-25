import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { previewWorkflow as previewCoreWorkflow } from "../../core/src/workflow"
import {
  factJson,
  formatWorkflowPreview,
  previewWorkflowSource,
  syncWorkflowSource,
} from "../src/workflow.js"

const dirs = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-workflow-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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
    expect(visible.edges.map((edge) => edge.label)).toEqual(["next", "revise", "approve"])
    expect(previewWorkflowSource(synced.source).status).toBe("ready")
  })

  it("refreshes an existing edge label when the authoritative route condition changes", () => {
    const source = workflowPage()
    const bundle = factJson(source, "bundle-manifest").value
    bundle.diagrams[0].edges[1].label = "stale-condition"
    const drifted = source.replace(
      /(<script data-fact="bundle-manifest" type="application\/derive-facts">)[\s\S]*?(<\/script>)/,
      (_match, open, close) => `${open}${JSON.stringify(bundle)}${close}`,
    )

    const synced = syncWorkflowSource(drifted)
    const visible = factJson(synced.source, "bundle-manifest").value.diagrams[0]
    expect(visible.edges[1]).toMatchObject({
      from: "review",
      to: "research",
      label: "revise",
    })
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
