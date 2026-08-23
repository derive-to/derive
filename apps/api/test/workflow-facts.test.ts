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
  })
})
