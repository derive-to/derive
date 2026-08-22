import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { previewWorkflow as previewCoreWorkflow } from "../../core/src/workflow"
import { factJson, formatWorkflowPreview, previewWorkflowSource } from "../src/workflow.js"

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
    members: [{ id: "brief", ref: "abc12345", label: "Signal brief" }],
    diagrams: [
      {
        id: "weekly-brief",
        title: "Weekly brief",
        type: "graph",
        nodes: [
          { id: "research", label: "Research signals" },
          { id: "review", label: "Product review" },
          { id: "publish", label: "Publish brief", member: "brief" },
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
  it("extracts facts without executing HTML and matches core's ready preview", () => {
    const source = workflowPage()
    expect(factJson(source, "workflow-definition").error).toBeNull()
    const preview = previewWorkflowSource(source)
    expect(preview).toEqual(previewCoreWorkflow(source))
    expect(formatWorkflowPreview(preview)).toContain("✓ Ready to run")
    expect(formatWorkflowPreview(preview)).toContain("Will pause")
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
      'WF-02 human node "review" routes must match its options exactly and omit fallback',
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
