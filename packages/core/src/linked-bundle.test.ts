import { describe, expect, it } from "vitest"
import {
  LINKED_BUNDLE_FACT,
  LINKED_BUNDLE_SCHEMA,
  type LinkedBundleManifest,
  linkedBundleAdvisories,
  linkedBundleOf,
  linkedBundleReviewId,
  renderLinkedBundle,
  validateLinkedBundle,
} from "./linked-bundle"

const manifest = {
  schema: LINKED_BUNDLE_SCHEMA,
  purpose: "Keep the product brief and evidence together while the loop improves them.",
  members: [
    { id: "brief", ref: "https://derive.to/artifacts/product-brief-abc12345", label: "Brief" },
    { id: "evidence", ref: "def67890", label: "Evidence", role: "input" },
  ],
  diagrams: [
    {
      id: "improve",
      title: "Improve until confident",
      type: "loop" as const,
      goal: "Make the brief decision-ready",
      evaluate: "Check claims against evidence",
      stop: "Stop when material objections are resolved",
      nodes: [
        {
          id: "write",
          label: "Revise",
          member: "brief",
          state: "active" as const,
          basis_version: 3,
          note: "Address the open evidence objection",
        },
        { id: "check", label: "Evaluate", member: "evidence" },
      ],
      edges: [
        { from: "write", to: "check" },
        { from: "check", to: "write", label: "improve" },
      ],
    },
  ],
} satisfies LinkedBundleManifest

describe("linked bundle contract", () => {
  it("normalizes artifact URLs and keeps loops explicit", () => {
    const result = validateLinkedBundle(manifest)
    expect(result.errors).toEqual([])
    expect(result.manifest?.members.map((member) => member.ref)).toEqual(["abc12345", "def67890"])
    expect(result.manifest?.diagrams?.[0]).toMatchObject({
      type: "loop",
      evaluate: "Check claims against evidence",
      stop: "Stop when material objections are resolved",
      nodes: [
        {
          id: "write",
          state: "active",
          basis_version: 3,
          note: "Address the open evidence objection",
        },
        { id: "check" },
      ],
    })
  })

  it("rejects invented state and non-positive version bases", () => {
    const result = validateLinkedBundle({
      ...manifest,
      diagrams: [
        {
          ...manifest.diagrams[0],
          nodes: [
            { id: "write", label: "Revise", member: "brief", state: "running" },
            { id: "check", label: "Evaluate", member: "evidence", basis_version: 0 },
          ],
        },
      ],
    })
    expect(result.manifest).toBeNull()
    expect(result.errors.join(" ")).toContain("state must be")
    expect(result.errors.join(" ")).toContain("basis_version must be positive")
  })

  it("warns when a version basis has no linked artifact", () => {
    const result = validateLinkedBundle({
      ...manifest,
      diagrams: [
        {
          ...manifest.diagrams[0],
          nodes: [{ id: "write", label: "Revise", basis_version: 3 }],
          edges: [{ from: "write", to: "write" }],
        },
      ],
    })
    expect(result.manifest).not.toBeNull()
    expect(result.warnings).toContain('diagram node "write" has basis_version but no linked member')
  })

  it("rejects dangling diagram references", () => {
    const result = validateLinkedBundle({
      ...manifest,
      diagrams: [
        {
          id: "bad",
          title: "Bad graph",
          type: "graph",
          nodes: [{ id: "one", label: "One", member: "missing" }],
          edges: [{ from: "one", to: "two" }],
        },
      ],
    })
    expect(result.manifest).toBeNull()
    expect(result.errors.join(" ")).toContain("unknown member")
    expect(result.errors.join(" ")).toContain("unknown node")
  })

  it("warns when a loop omits its inspectable policy", () => {
    const result = validateLinkedBundle({
      schema: LINKED_BUNDLE_SCHEMA,
      purpose: "A loop",
      members: [{ id: "brief", ref: "abc12345", label: "Brief" }],
      diagrams: [
        {
          id: "loop",
          title: "Loop",
          type: "loop",
          nodes: [{ id: "revise", label: "Revise" }],
          edges: [{ from: "revise", to: "revise" }],
        },
      ],
    })
    expect(result.manifest).not.toBeNull()
    expect(result.warnings).toHaveLength(3)
  })

  it("distinguishes a named loop from an acyclic graph", () => {
    const result = validateLinkedBundle({
      ...manifest,
      diagrams: [
        {
          ...manifest.diagrams[0],
          edges: [{ from: "write", to: "check" }],
        },
      ],
    })
    expect(result.manifest).not.toBeNull()
    expect(result.warnings).toContain('loop "improve" has no directed cycle')
  })

  it("rejects duplicate diagram ids", () => {
    const result = validateLinkedBundle({
      ...manifest,
      diagrams: [manifest.diagrams[0], { ...manifest.diagrams[0], title: "Another view" }],
    })
    expect(result.manifest).toBeNull()
    expect(result.errors).toContain('duplicate diagram id "improve"')
  })

  it("renders visible member links and the fact from one model", () => {
    const html = renderLinkedBundle(manifest, "Launch loop")
    expect(html).toContain('href="/artifacts/abc12345"')
    expect(html).toContain('href="/artifacts/def67890"')
    expect(html).toContain(`data-fact="${LINKED_BUNDLE_FACT}"`)
    expect(linkedBundleOf(html)?.manifest).toEqual(validateLinkedBundle(manifest).manifest)
    expect(linkedBundleAdvisories(html)).toEqual([])
    expect(html).toContain(
      `id="${linkedBundleReviewId("improve", "node", "write")}" data-derive-review-id=`,
    )
    expect(html).toContain('data-derive-review-kind="loop-step"')
    expect(html).toContain('data-derive-review-kind="loop-policy"')
    expect(html).toContain('data-derive-review-kind="loop-transition"')
    expect(html).toContain('data-state="active"')
    expect(html).toContain("based on v3")
  })

  it("warns when the manifest and visible member links drift", () => {
    const html = renderLinkedBundle(manifest).replace('href="/artifacts/def67890"', 'href="#"')
    expect(linkedBundleAdvisories(html)).toEqual([expect.stringContaining("Evidence")])
  })
})
