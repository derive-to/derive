import { describe, expect, it } from "vitest"
import { workflowTriggerLabel } from "./workflow-preview"

describe("workflow Preview", () => {
  it("explains context triggers in plain run language", () => {
    expect(workflowTriggerLabel("explicit run")).toBe("Starts when you run this workflow")
    expect(workflowTriggerLabel("Research completes")).toBe("After Research completes")
    expect(workflowTriggerLabel("Quality check returns ready")).toBe(
      "When Quality check returns ready",
    )
  })
})
