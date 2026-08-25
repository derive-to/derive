import {
  AGENT_MANIFEST_FACT,
  AGENT_MANIFEST_SCHEMA,
  agentManifestForContext,
  agentManifestsOf,
  LINKED_BUNDLE_SCHEMA,
  type LinkedBundleManifest,
  validateAgentManifest,
  validateWorkflowDefinition,
  WORKFLOW_DEFINITION_SCHEMA,
} from "@derive/core"
import { describe, expect, it } from "vitest"

// The production workflow gate is intentionally a focused contract suite, not a
// second eval platform. These 18 cases cover the authored policy boundaries a local
// harness must be able to trust before it opens a context session.
// biome-ignore lint/suspicious/noExplicitAny: invalid-case mutations intentionally cross the schema.
const definition = (): any => ({
  schema: WORKFLOW_DEFINITION_SCHEMA,
  purpose: "Build and approve a brief",
  diagrams: [
    {
      id: "brief",
      entry: "draft",
      nodes: [
        {
          id: "draft",
          kind: "context",
          context_ref: "writer",
          instruction: "Draft the brief.",
          result: "A cited draft",
        },
        {
          id: "review",
          kind: "human",
          decision: "Publish this brief?",
          options: ["publish", "stop"],
          resume: "Choose publish or stop.",
        },
        {
          id: "publish",
          kind: "context",
          context_ref: "publisher",
          instruction: "Publish the approved brief.",
          result: "A published brief",
          terminal: true,
          effects: [
            {
              kind: "write",
              description: "Publish the brief",
              gate: "human",
              approval_ref: "review",
            },
          ],
        },
        { id: "stop", kind: "terminal", result: "Stopped without publishing" },
      ],
      routes: [
        { from: "draft", to: "review", when: "always" },
        { from: "review", to: "publish", when: "publish" },
        { from: "review", to: "stop", when: "stop" },
      ],
      scenarios: [
        {
          id: "expected",
          kind: "expected",
          path: ["draft", "review", "publish"],
          outcome: "The approved brief is published",
        },
        {
          id: "failure",
          kind: "failure",
          path: ["draft"],
          outcome: "The failure remains visible and execution stops",
        },
        {
          id: "human-stop",
          kind: "human",
          path: ["draft", "review", "stop"],
          outcome: "The reviewer explicitly stops",
        },
      ],
    },
  ],
})

const manifest = (): LinkedBundleManifest => ({
  schema: LINKED_BUNDLE_SCHEMA,
  purpose: "Build and approve a brief",
  members: [],
  diagrams: [
    {
      id: "brief",
      title: "Reviewed brief",
      type: "graph",
      nodes: [
        { id: "draft", label: "Draft" },
        { id: "review", label: "Review" },
        { id: "publish", label: "Publish" },
        { id: "stop", label: "Stop" },
      ],
      edges: [
        { from: "draft", to: "review", label: "next" },
        { from: "review", to: "publish", label: "publish" },
        { from: "review", to: "stop", label: "stop" },
      ],
    },
  ],
})

const errorsAfter = (
  // biome-ignore lint/suspicious/noExplicitAny: callers mutate one deliberately invalid field per case.
  mutateDefinition?: (value: any) => void,
  mutateManifest?: (value: LinkedBundleManifest) => void,
): string[] => {
  const value = definition()
  const linked = manifest()
  mutateDefinition?.(value)
  mutateManifest?.(linked)
  return validateWorkflowDefinition(value, linked).errors
}

describe("workflow production evaluation — 18 focused policy cases", () => {
  it("01 accepts a complete versioned workflow contract", () => {
    const checked = validateWorkflowDefinition(definition(), manifest())
    expect(checked.errors).toEqual([])
    expect(checked.definition?.diagrams[0]?.entry).toBe("draft")
  })

  it("02 rejects an unknown workflow schema", () => {
    expect(errorsAfter((v) => (v.schema = "derive.workflow/v0"))).toContain(
      'WF-01 schema must be "derive.workflow/v1"',
    )
  })

  it("03 rejects purpose drift between policy and visible graph", () => {
    expect(errorsAfter(undefined, (m) => (m.purpose = "Something else"))).toContain(
      "WF-02 workflow purpose must match bundle-manifest purpose",
    )
  })

  it("04 rejects a policy node missing from the visible graph", () => {
    expect(
      errorsAfter(undefined, (m) => {
        const diagram = m.diagrams?.[0]
        if (diagram) diagram.nodes = diagram.nodes.filter((node) => node.id !== "publish")
      }),
    ).toContain('WF-02 workflow node "brief/publish" is not visible in bundle-manifest')
  })

  it("05 requires a context binding", () => {
    expect(errorsAfter((v) => delete v.diagrams[0].nodes[0].context_ref)).toContain(
      'WF-03 context node "draft" requires context_ref',
    )
  })

  it("06 requires an executable context instruction", () => {
    expect(errorsAfter((v) => delete v.diagrams[0].nodes[0].instruction)).toContain(
      'WF-03 context node "draft" requires instruction',
    )
  })

  it("07 requires an expected context result", () => {
    expect(errorsAfter((v) => delete v.diagrams[0].nodes[0].result)).toContain(
      'WF-03 context node "draft" requires result',
    )
  })

  it("08 requires a human decision", () => {
    expect(errorsAfter((v) => delete v.diagrams[0].nodes[1].decision)).toContain(
      'WF-07 human node "review" requires decision',
    )
  })

  it("09 requires at least two human options", () => {
    expect(errorsAfter((v) => (v.diagrams[0].nodes[1].options = ["publish"]))).toContain(
      'WF-07 human node "review" requires at least two options',
    )
  })

  it("09b requires human options to be distinct", () => {
    expect(errorsAfter((v) => (v.diagrams[0].nodes[1].options = ["publish", "PUBLISH"]))).toContain(
      'WF-07 human node "review" requires distinct options',
    )
  })

  it("10 requires human routes to match authored options exactly", () => {
    expect(errorsAfter((v) => (v.diagrams[0].routes[2].when = "later"))).toEqual(
      expect.arrayContaining([expect.stringContaining("routes must match its options exactly")]),
    )
  })

  it("11 requires idempotency for an autonomous write effect", () => {
    expect(
      errorsAfter((v) => {
        const effect = v.diagrams[0].nodes[2].effects[0]
        effect.gate = "none"
        delete effect.approval_ref
      }),
    ).toContain('WF-05 node "publish" write effect needs a human gate or idempotency')
  })

  it("12 requires a human-gated effect to reference a real human node", () => {
    expect(
      errorsAfter((v) => (v.diagrams[0].nodes[2].effects[0].approval_ref = "missing")),
    ).toContain('WF-05 node "publish" effect approval_ref must name a human node in the diagram')
  })

  it("13 requires an explicit routing mode for a branching context", () => {
    expect(
      errorsAfter((v) => v.diagrams[0].routes.push({ from: "draft", to: "stop", when: "fail" })),
    ).toContain('WF-02 context node "draft" with multiple routes requires routing')
  })

  it("14 requires exactly one fallback for routing one", () => {
    expect(
      errorsAfter((v) => {
        v.diagrams[0].nodes[0].routing = "one"
        v.diagrams[0].routes.push({ from: "draft", to: "stop", when: "fail" })
      }),
    ).toContain(
      'WF-02 routing:"one" node "draft" requires unique conditions and exactly one fallback',
    )
  })

  it("14b rejects duplicate predicates for routing one", () => {
    expect(
      errorsAfter((v) => {
        v.diagrams[0].nodes[0].routing = "one"
        v.diagrams[0].routes[0].when = "ready"
        v.diagrams[0].routes.push({ from: "draft", to: "stop", when: "READY" })
        v.diagrams[0].routes.push({
          from: "draft",
          to: "publish",
          when: "otherwise",
          fallback: true,
        })
      }),
    ).toContain(
      'WF-02 routing:"one" node "draft" requires unique conditions and exactly one fallback',
    )
  })

  it("15 rejects unreachable nodes", () => {
    expect(
      errorsAfter(
        (v) => v.diagrams[0].nodes.push({ id: "orphan", kind: "terminal", result: "Unused" }),
        (m) => m.diagrams?.[0]?.nodes.push({ id: "orphan", label: "Orphan" }),
      ),
    ).toContain('WF-02 node "orphan" is unreachable from entry "draft"')
  })

  it("16 rejects a directed cycle without a bounded loop policy", () => {
    expect(
      errorsAfter((v) => {
        v.diagrams[0].nodes[2].terminal = false
        v.diagrams[0].routes.push({ from: "publish", to: "draft", when: "revise" })
      }),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("has no covering bounded loop policy")]),
    )
  })

  it("17 caps loop attempts at one hundred", () => {
    expect(
      errorsAfter((v) => {
        v.diagrams[0].nodes[2].terminal = false
        v.diagrams[0].routes.push({ from: "publish", to: "draft", when: "revise" })
        v.diagrams[0].loops = [
          {
            id: "repair",
            nodes: ["draft", "review", "publish"],
            goal: "Reach approval",
            evaluate: "Check the review decision",
            stop: { max_attempts: 101, human_stop: "The person stops" },
          },
        ]
      }),
    ).toContain('WF-04 loop "repair" max_attempts must be an integer from 1 to 100')
  })

  it("17b requires an integer stagnation limit", () => {
    expect(
      errorsAfter((v) => {
        v.diagrams[0].loops = [
          {
            id: "repair",
            nodes: ["draft", "review"],
            goal: "Reach approval",
            evaluate: "Check the review decision",
            stop: { max_attempts: 2, stagnation_limit: 0.5, human_stop: "The person stops" },
          },
        ]
      }),
    ).toContain('WF-04 loop "repair" stagnation_limit must be an integer')
  })

  it("18 requires a context-failure scenario", () => {
    expect(
      errorsAfter((v) => {
        v.diagrams[0].scenarios = v.diagrams[0].scenarios.filter(
          // biome-ignore lint/suspicious/noExplicitAny: scenarios are part of the mutable invalid fixture.
          (scenario: any) => scenario.kind !== "failure",
        )
      }),
    ).toContain('WF-10 diagram "brief" needs a failure scenario')
  })
})

const fact = (slot: string, value: unknown) =>
  `<script type="application/derive-facts" data-fact="${slot}">${JSON.stringify(value)}</script>`

const explicitManifest = (kind: "graph" | "loop" = "graph") => ({
  schema: AGENT_MANIFEST_SCHEMA,
  kind,
  purpose: "Build and approve a brief",
  title: "Reviewed brief",
  diagram: definition().diagrams[0],
  labels: { draft: "Draft", review: "Review", publish: "Publish", stop: "Stop" },
})

describe("typed agent manifest normalization", () => {
  it("adapts an ordinary Markdown context as a single manifest without rewriting it", () => {
    const source = "# Researcher\n\nAnswer with cited evidence."
    const read = agentManifestsOf(source, "text/markdown")
    expect(read.errors).toEqual([])
    expect(read.candidates).toHaveLength(1)
    expect(read.candidates[0]).toMatchObject({
      kind: "single",
      source: "implicit-single",
      manifest: { kind: "single", instructions: source },
    })
  })

  it("accepts an explicit v2 single manifest", () => {
    const checked = validateAgentManifest({
      schema: AGENT_MANIFEST_SCHEMA,
      kind: "single",
      purpose: "Answer support questions",
      instructions: "Use the support handbook and cite it.",
    })
    expect(checked.errors).toEqual([])
    expect(checked.manifest?.kind).toBe("single")
    expect(checked.preview).toBeNull()
  })

  it("accepts one explicit v2 graph and produces a ready preview", () => {
    const checked = validateAgentManifest(explicitManifest())
    expect(checked.errors).toEqual([])
    expect(checked.manifest?.kind).toBe("graph")
    expect(checked.preview?.status).toBe("ready")
    expect(checked.preview?.diagrams[0]?.title).toBe("Reviewed brief")
  })

  it("refuses a graph manifest that declares loop policy", () => {
    const value = explicitManifest()
    value.diagram.loops = [
      {
        id: "unneeded",
        nodes: ["draft"],
        goal: "Repeat",
        evaluate: "Check",
        stop: { max_attempts: 2, human_stop: "Stop" },
      },
    ]
    expect(validateAgentManifest(value).errors).toContain(
      "AM-04 graph manifest must be acyclic and must not declare loop policies",
    )
  })

  it("refuses a loop manifest without a bounded loop", () => {
    expect(validateAgentManifest(explicitManifest("loop")).errors).toContain(
      "AM-04 loop manifest requires at least one bounded loop policy",
    )
  })

  it("gives an explicit v2 fact precedence over legacy workflow facts", () => {
    const single = {
      schema: AGENT_MANIFEST_SCHEMA,
      kind: "single",
      purpose: "Leaf",
      instructions: "Do one thing.",
    }
    const source = `<!doctype html><body>${fact(AGENT_MANIFEST_FACT, single)}${fact("bundle-manifest", manifest())}${fact("workflow-definition", definition())}</body>`
    const read = agentManifestsOf(source)
    expect(read.candidates).toHaveLength(1)
    expect(read.candidates[0]).toMatchObject({ source: "agent-manifest-v2", kind: "single" })
  })

  it("adapts every valid legacy workflow diagram without mutating the source", () => {
    const source = `<!doctype html><body>${fact("bundle-manifest", manifest())}${fact("workflow-definition", definition())}</body>`
    const read = agentManifestsOf(source)
    expect(read.errors).toEqual([])
    expect(read.candidates).toHaveLength(1)
    expect(read.candidates[0]).toMatchObject({
      source: "workflow-v1",
      kind: "graph",
      legacy_diagram_id: "brief",
      manifest: { title: "Reviewed brief" },
    })
    expect(source).toContain("derive.workflow/v1")
  })

  it("requires an explicit selector for a legacy multi-diagram context", () => {
    const linked = manifest()
    const workflow = definition()
    linked.diagrams?.push({
      ...linked.diagrams[0],
      id: "second",
      title: "Second flow",
      nodes: linked.diagrams[0]?.nodes.map((node) => ({ ...node })) ?? [],
      edges: linked.diagrams[0]?.edges.map((edge) => ({ ...edge })) ?? [],
    })
    workflow.diagrams.push({ ...workflow.diagrams[0], id: "second" })
    const source = `<!doctype html><body>${fact("bundle-manifest", linked)}${fact("workflow-definition", workflow)}</body>`
    expect(agentManifestForContext(source).errors).toContain(
      "AM-02 context manifest contains multiple diagrams and requires an explicit selector",
    )
    expect(agentManifestForContext(source, "text/html", "second").manifest).toMatchObject({
      kind: "graph",
      diagram: { id: "second" },
    })
  })

  it("reports malformed explicit JSON instead of falling back to single", () => {
    const source = `<!doctype html><body><script type="application/derive-facts" data-fact="${AGENT_MANIFEST_FACT}">{</script></body>`
    const read = agentManifestsOf(source)
    expect(read.candidates[0]?.errors).toEqual(["AM-01 agent-manifest is not valid JSON"])
    expect(read.candidates[0]?.manifest).toBeNull()
  })
})
