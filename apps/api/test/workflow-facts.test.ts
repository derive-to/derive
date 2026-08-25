import { describe, expect, it } from "vitest"
import { parseLinkedWorkflowFacts } from "../src/lib/workflow-facts"

const bundle = JSON.stringify({
  schema: "derive.linked-bundle/v1",
  purpose: "Keep related work together",
  members: [{ id: "brief", ref: "abc12345", label: "Brief" }],
})

describe("linked workflow facts", () => {
  it("distinguishes absence from malformed authored data", () => {
    expect(parseLinkedWorkflowFacts([])).toMatchObject({
      bundleFound: false,
      workflowFound: false,
      manifest: null,
      bundleErrors: [],
    })
    expect(parseLinkedWorkflowFacts([{ slot: "bundle-manifest", json: "{" }])).toMatchObject({
      bundleFound: true,
      workflowFound: false,
      manifest: null,
      bundleErrors: ["bundle-manifest is not valid JSON"],
    })
  })

  it("uses the canonical Preview error for malformed workflow JSON", () => {
    const facts = parseLinkedWorkflowFacts([
      { slot: "bundle-manifest", json: bundle },
      { slot: "workflow-definition", json: "{" },
    ])
    expect(facts.manifest?.purpose).toBe("Keep related work together")
    expect(facts.preview).toMatchObject({
      status: "needs-changes",
      errors: ["WF-01 workflow-definition is not valid JSON"],
    })
    expect(facts.definition).toBeUndefined()
  })

  it("exposes exact semantics only for a definition validated against the visible graph", () => {
    const manifest = JSON.stringify({
      schema: "derive.linked-bundle/v1",
      purpose: "Run a brief",
      members: [],
      diagrams: [
        {
          id: "brief",
          title: "Brief workflow",
          type: "graph",
          nodes: [
            { id: "draft", label: "Draft" },
            { id: "done", label: "Done" },
          ],
          edges: [{ from: "draft", to: "done", label: "old canvas copy" }],
        },
      ],
    })
    const definition = JSON.stringify({
      schema: "derive.workflow/v1",
      purpose: "Run a brief",
      diagrams: [
        {
          id: "brief",
          entry: "draft",
          nodes: [
            {
              id: "draft",
              kind: "context",
              context_ref: "brief-writer",
              instruction: "Write the brief.",
              result: "A cited brief",
            },
            { id: "done", kind: "terminal", result: "The accepted brief" },
          ],
          routes: [{ from: "draft", to: "done", when: "accepted", fallback: true }],
          scenarios: [
            {
              id: "expected",
              kind: "expected",
              path: ["draft", "done"],
              outcome: "The accepted brief is stored",
            },
            {
              id: "failure",
              kind: "failure",
              path: ["draft"],
              outcome: "The run stops visibly",
            },
          ],
        },
      ],
    })
    const facts = parseLinkedWorkflowFacts([
      { slot: "bundle-manifest", json: manifest },
      { slot: "workflow-definition", json: definition },
    ])

    expect(facts.preview?.status).toBe("ready")
    expect(facts.definition?.diagrams[0]?.nodes[0]).toMatchObject({
      kind: "context",
      context_ref: "brief-writer",
      instruction: "Write the brief.",
      result: "A cited brief",
    })
    expect(facts.definition?.diagrams[0]?.routes[0]).toEqual({
      from: "draft",
      to: "done",
      when: "accepted",
      fallback: true,
    })
  })
})
