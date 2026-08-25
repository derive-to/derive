import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { publishAdvisories } from "../src/advisories"
import { MODEL_FAMILY_TIERS, tierForModelFamily } from "../src/agent-routing"
import { sha256Hex } from "../src/hash"
import { renderLinkedBundle, validateLinkedBundle } from "../src/linked-bundle"
import type { ArtifactRecord, BlobStore, MetaStore, NewArtifact, NewVersion } from "../src/ports"
import { artifactUrl, looksLikeHtmlDocument, type PublishInput, publish } from "../src/publish"
import { previewWorkflow, previewWorkflowJson, workflowDefinitionOf } from "../src/workflow"

// publish() stores content then writes the artifact/version. The
// interesting, security-relevant logic is storeContent's bundle handling (zip
// entry detection + path cleaning), reachable only through publish(). Drive it with
// a Map-backed blob store and a tiny fake MetaStore implementing just the handful of
// methods these two functions touch.
const makeBlobs = (): BlobStore => {
  const map = new Map<string, Uint8Array>()
  return {
    put: async (d) => {
      const k = await sha256Hex(d)
      map.set(k, d)
      return k
    },
    get: async (k) => map.get(k) ?? null,
  }
}

// A focused in-memory fake: only the handful of methods publish() actually calls,
// over plain records (no `any`). Cast through MetaStore at the end —
// the uncalled ~75 methods are never reached.
type FakeArtifact = NewArtifact & { current_version: number; created_at: string; removed_at: null }
type FakeVersion = NewVersion & { n: number; artifact_id: string; created_at: string }

const makeMeta = (): MetaStore => {
  const byShort = new Map<string, FakeArtifact>()
  const byId = new Map<string, FakeArtifact>()
  const versions = new Map<string, FakeVersion[]>()
  const meta = {
    createArtifact: async (a: NewArtifact): Promise<FakeArtifact> => {
      // Mirror the store's fail-closed column defaults for omitted access fields
      // (drizzle omits `undefined` keys on insert, so the DB default applies).
      const rec: FakeArtifact = {
        ...a,
        workspace_access: a.workspace_access ?? "none",
        link_role: a.link_role ?? "none",
        listed: a.listed ?? "none",
        current_version: 0,
        created_at: "t",
        removed_at: null,
      }
      byShort.set(a.short_id, rec)
      byId.set(a.id, rec)
      return rec
    },
    getByShortId: async (s: string) => byShort.get(s) ?? null,
    getArtifactById: async (id: string) => byId.get(id) ?? null,
    addVersion: async (artifactId: string, v: NewVersion): Promise<FakeVersion> => {
      const list = versions.get(artifactId) ?? []
      const rec: FakeVersion = {
        ...v,
        n: list.length + 1,
        artifact_id: artifactId,
        created_at: "t",
      }
      list.push(rec)
      versions.set(artifactId, list)
      const art = byId.get(artifactId)
      if (art) art.current_version = rec.n
      return rec
    },
    setVersionPreview: async () => {},
  }
  return meta as unknown as MetaStore
}

const file = (body: string, over: Partial<PublishInput> = {}): PublishInput => ({
  bytes: new TextEncoder().encode(body),
  filename: "page.html",
  isBundle: false,
  ...over,
})

const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])),
  )

const bundle = (files: Record<string, string>, over: Partial<PublishInput> = {}): PublishInput => ({
  bytes: zip(files),
  filename: "site.zip",
  isBundle: true,
  ...over,
})

const workflowPage = (mutate?: (workflow: Record<string, unknown>) => void): string => {
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
  const workflow: Record<string, unknown> = {
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
  mutate?.(workflow)
  return `<!doctype html><html><body><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(linked)}</script><script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(workflow)}</script></body></html>`
}

describe("publish: single file", () => {
  it("creates an artifact + first version, titled from the filename", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const { artifact, version } = await publish(meta, blobs, file("<h1>hi</h1>"))
    expect(artifact.kind).toBe("file")
    expect(artifact.title).toBe("page") // ".html" stripped
    // Publishing without access fields is fail-closed — nobody but the publisher
    // (the route writes them as the owner-member) until widened. The route, not
    // publish(), applies the product default (workspace_access member).
    expect(artifact.workspace_access).toBe("none")
    expect(artifact.link_role).toBe("none")
    expect(artifact.listed).toBe("none")
    expect(version.n).toBe(1)
    expect(version.content_type).toBe("text/html")
    expect(new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined)).toBe(
      "<h1>hi</h1>",
    )
  })

  it("recognizes a valid linked-bundle fact without changing the file kind", async () => {
    const body = `<!doctype html><html><body><a href="/artifacts/abc12345">Brief</a><script type="application/derive-facts" data-fact="bundle-manifest">{"schema":"derive.linked-bundle/v1","purpose":"Keep the work together","members":[{"id":"brief","ref":"abc12345","label":"Brief"}]}</script></body></html>`
    const { artifact, version } = await publish(makeMeta(), makeBlobs(), file(body))
    expect(artifact.kind).toBe("file")
    expect(version.content_type).toBe("text/x-derive-linked-bundle")
  })

  it("classifies a typed graph manifest separately even without a legacy bundle", async () => {
    const manifest = {
      schema: "derive.agent-manifest/v2",
      kind: "graph",
      purpose: "Publish a release note",
      title: "Release note",
      diagram: {
        id: "release",
        entry: "done",
        nodes: [{ id: "done", kind: "terminal", result: "Release note published" }],
        routes: [],
        scenarios: [
          {
            id: "expected",
            kind: "expected",
            path: ["done"],
            outcome: "Release note is published",
          },
        ],
      },
    }
    const body = `<!doctype html><html><body><script type="application/derive-facts" data-fact="agent-manifest">${JSON.stringify(manifest)}</script></body></html>`
    const { artifact, version } = await publish(makeMeta(), makeBlobs(), file(body))
    expect(artifact.kind).toBe("file")
    expect(version.content_type).toBe("text/x-derive-agent-manifest")
  })

  it("honors explicit title, access, and author", async () => {
    const { artifact, version } = await publish(
      makeMeta(),
      makeBlobs(),
      file("x", {
        title: "Custom",
        workspaceAccess: "member",
        linkRole: "viewer",
        listed: "public",
        author: "amy",
      }),
    )
    expect(artifact.title).toBe("Custom")
    expect(artifact.workspace_access).toBe("member")
    expect(artifact.link_role).toBe("viewer")
    expect(artifact.listed).toBe("public")
    expect(version.author).toBe("amy")
  })
})

describe("publish advisories", () => {
  it.each([
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
  ])("warns when sandboxed HTML references unavailable %s", (storage) => {
    const advisories = publishAdvisories(
      `<!doctype html><html><script>void ${storage}</script></html>`,
      "text/html",
    )
    expect(advisories).toEqual(
      expect.arrayContaining([expect.stringMatching(/opaque sandbox.*derive\.shared/)]),
    )
  })

  it("does not warn for ordinary HTML or non-HTML source examples", () => {
    expect(
      publishAdvisories("<!doctype html><html><p>Persistent state</p></html>", "text/html"),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining("browser storage")]))
    expect(
      publishAdvisories("Use `localStorage` in a normal web app.", "text/markdown"),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining("browser storage")]))
  })
})

describe("workflow preview contract", () => {
  it("classifies malformed extracted workflow JSON through the same Preview contract", () => {
    expect(previewWorkflowJson("{", null)).toEqual({
      status: "needs-changes",
      execution_started: false,
      purpose: null,
      errors: ["WF-01 workflow-definition is not valid JSON"],
      warnings: [],
      diagrams: [],
      cannot_do: [],
    })
  })

  it("explains one valid graph while keeping the linked bundle as visible truth", () => {
    const preview = previewWorkflow(workflowPage())
    expect(preview.status).toBe("ready")
    expect(preview.purpose).toBe("Publish a weekly brief after product review")
    expect(preview.diagrams[0]).toMatchObject({
      id: "weekly-brief",
      title: "Weekly brief",
      will_do: [
        "Research signals — A cited draft brief",
        "Publish brief — A published Derive artifact",
      ],
      will_pause: [
        "Product review — Approve or request one revision; resume: The product lead chooses an option",
      ],
      can_repeat: [
        "Reach an approvable brief — at most 2 attempts; human stop: The product lead stops or changes the brief",
      ],
      side_effects: ["Publish the approved brief — authorized at Product review"],
      context_sessions: [
        {
          node_id: "research",
          label: "Research signals",
          context_ref: "signal-researcher",
          starts_when: "explicit run",
        },
        {
          node_id: "publish",
          label: "Publish brief",
          context_ref: "brief-publisher",
          starts_when: "Product review returns approve",
        },
      ],
    })
    expect(preview.cannot_do).toEqual(["Publish without approval"])
    expect(workflowDefinitionOf(workflowPage())?.errors).toEqual([])
  })

  it("blocks unbounded cycles and unsafe effects in the same Preview result", () => {
    const source = workflowPage((workflow) => {
      const diagram = (workflow.diagrams as Array<Record<string, unknown>>)[0]
      if (!diagram) return
      diagram.loops = []
      const nodes = diagram.nodes as Array<Record<string, unknown>>
      const publishNode = nodes.find((node) => node.id === "publish")
      if (publishNode)
        publishNode.effects = [
          { kind: "write", description: "Publish the approved brief", gate: "none" },
        ]
    })
    const preview = previewWorkflow(source)
    expect(preview.status).toBe("needs-changes")
    expect(preview.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("WF-04"), expect.stringContaining("WF-05")]),
    )
    expect(publishAdvisories(source, "text/x-derive-linked-bundle")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Workflow preview: WF-04"),
        expect.stringContaining("Workflow preview: WF-05"),
      ]),
    )
  })

  it("blocks drift between visible edges and executable routes", () => {
    const source = workflowPage((workflow) => {
      const diagram = (workflow.diagrams as Array<Record<string, unknown>>)[0]
      if (!diagram) return
      diagram.routes = (diagram.routes as Array<Record<string, unknown>>).filter(
        (route) => route.to !== "publish",
      )
    })
    const preview = previewWorkflow(source)
    expect(preview.status).toBe("needs-changes")
    expect(preview.errors).toContain(
      'WF-02 visible edge "Product review" → "Publish brief" in "weekly-brief" has no workflow route',
    )
  })

  it("requires a runnable entry and a loop policy covering the actual cycle", () => {
    const source = workflowPage((workflow) => {
      const diagram = (workflow.diagrams as Array<Record<string, unknown>>)[0]
      if (!diagram) return
      diagram.entry = "missing"
      const loops = diagram.loops as Array<Record<string, unknown>>
      if (loops[0]) loops[0].nodes = ["publish"]
    })
    const preview = previewWorkflow(source)
    expect(preview.status).toBe("needs-changes")
    expect(preview.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("requires an entry node"),
        expect.stringContaining("has no covering bounded loop policy"),
      ]),
    )
  })

  it("does not treat an unknown human response as approval through fallback", () => {
    const source = workflowPage((workflow) => {
      const diagram = (workflow.diagrams as Array<Record<string, unknown>>)[0]
      if (!diagram) return
      const routes = diagram.routes as Array<Record<string, unknown>>
      const approval = routes.find((route) => route.to === "publish")
      if (approval) approval.fallback = true
    })
    expect(previewWorkflow(source).errors).toContain(
      'WF-02 human node "review" routes must match its options exactly; fallback is not allowed',
    )
  })
})

describe("linked bundle agent tiers", () => {
  it("accepts a graph-first manifest before any result artifacts exist", () => {
    const graphFirst = validateLinkedBundle({
      schema: "derive.linked-bundle/v1",
      purpose: "Preview work before it creates artifacts",
      members: [],
      diagrams: [
        {
          id: "preview",
          title: "Preview",
          type: "graph",
          nodes: [{ id: "draft", label: "Draft", state: "pending" }],
          edges: [],
        },
      ],
    })
    expect(graphFirst.errors).toEqual([])
    expect(graphFirst.manifest?.members).toEqual([])
    expect(
      renderLinkedBundle(graphFirst.manifest as NonNullable<typeof graphFirst.manifest>),
    ).toContain("No result artifacts yet.")

    expect(
      validateLinkedBundle({
        schema: "derive.linked-bundle/v1",
        purpose: "Empty",
        members: [],
        diagrams: [],
      }).errors,
    ).toContain("members or diagrams must contain at least one item")
  })

  it("accepts and renders optional human-readable node working state", () => {
    const result = validateLinkedBundle({
      schema: "derive.linked-bundle/v1",
      purpose: "Coordinate a careful handoff",
      members: [{ id: "brief", ref: "abc12345", label: "Brief" }],
      diagrams: [
        {
          id: "handoff",
          title: "Handoff",
          type: "graph",
          nodes: [
            {
              id: "review",
              label: "Review the brief",
              member: "brief",
              state: "waiting",
              role: "  Evidence reviewer  ",
              tier: "expert",
              confidence: { level: "medium", basis: "Source coverage is complete" },
              help: {
                needed: true,
                question: "Which source should take priority?",
                can_continue: "I can continue with the current ordering.",
              },
            },
          ],
          edges: [],
        },
      ],
    })

    expect(result.errors).toEqual([])
    expect(result.manifest?.diagrams?.[0]?.nodes[0]).toMatchObject({
      state: "waiting",
      role: "Evidence reviewer",
      tier: "expert",
      confidence: { level: "medium", basis: "Source coverage is complete" },
      help: {
        needed: true,
        question: "Which source should take priority?",
        can_continue: "I can continue with the current ordering.",
      },
    })
    const html = renderLinkedBundle(result.manifest as NonNullable<typeof result.manifest>)
    expect(html).toContain("Role: Evidence reviewer")
    expect(html).toContain("Tier: expert")
    expect(html).toContain("Confidence: medium — Source coverage is complete")
    expect(html).toContain("Help needed: Which source should take priority?")
    expect(html).not.toContain("<form")
  })

  it("renders the effective diagram tier when a node inherits it", () => {
    const manifest = {
      schema: "derive.linked-bundle/v1" as const,
      purpose: "Route work by durable capability",
      members: [{ id: "brief", ref: "abc12345", label: "Brief" }],
      diagrams: [
        {
          id: "handoff",
          title: "Handoff",
          type: "graph" as const,
          tier: "expert" as const,
          nodes: [{ id: "review", label: "Review the brief" }],
          edges: [],
        },
      ],
    }
    expect(renderLinkedBundle(manifest)).toContain("Tier: expert")
  })

  it("rejects invalid optional node working state shapes", () => {
    const result = validateLinkedBundle({
      schema: "derive.linked-bundle/v1",
      purpose: "Reject malformed state",
      members: [{ id: "brief", ref: "abc12345", label: "Brief" }],
      diagrams: [
        {
          id: "handoff",
          title: "Handoff",
          type: "graph",
          nodes: [
            {
              id: "review",
              label: "Review",
              state: "paused",
              role: "   ",
              confidence: { level: "certain", basis: "" },
              help: { needed: true },
            },
            {
              id: "approve",
              label: "Approve",
              help: {
                needed: false,
                question: "This should not be here",
                can_continue: "Nor should this",
              },
            },
          ],
          edges: [],
        },
      ],
    })

    expect(result.errors).toContain(
      'diagrams[0].nodes[0].state must be "pending", "active", "blocked", "waiting", or "done"',
    )
    expect(result.errors).toContain("diagrams[0].nodes[0].role must be a nonempty string")
    expect(result.errors).toContain(
      'diagrams[0].nodes[0].confidence.level must be "low", "medium", or "high"',
    )
    expect(result.errors).toContain(
      "diagrams[0].nodes[0].confidence.basis must be a nonempty string",
    )
    expect(result.errors).toContain(
      "diagrams[0].nodes[0].help.question is required when help.needed is true",
    )
    expect(result.errors).toContain(
      "diagrams[0].nodes[1].help.question must not be set when help.needed is false",
    )
    expect(result.errors).toContain(
      "diagrams[0].nodes[1].help.can_continue must not be set when help.needed is false",
    )
  })

  it("keeps a graph default and per-step tier without pinning a model version", () => {
    const result = validateLinkedBundle({
      schema: "derive.linked-bundle/v1",
      purpose: "Regression improvement loop",
      members: [{ id: "qa", ref: "abc12345", label: "QA evidence" }],
      diagrams: [
        {
          id: "qa-loop",
          title: "QA loop",
          type: "loop",
          tier: "balanced",
          nodes: [
            { id: "test", label: "Test", member: "qa", tier: "fast" },
            { id: "judge", label: "Judge", tier: "frontier" },
          ],
          edges: [
            { from: "test", to: "judge" },
            { from: "judge", to: "test" },
          ],
          goal: "Improve confidence",
          evaluate: "Compare against the previous run",
          stop: "No material regression remains",
        },
      ],
    })

    expect(result.errors).toEqual([])
    expect(result.manifest?.diagrams?.[0]).toMatchObject({
      tier: "balanced",
      nodes: [{ tier: "fast" }, { tier: "frontier" }],
    })
  })

  it("rejects tiers outside the five-step contract", () => {
    const result = validateLinkedBundle({
      schema: "derive.linked-bundle/v1",
      purpose: "Bad graph",
      members: [{ id: "qa", ref: "abc12345", label: "QA" }],
      diagrams: [
        {
          id: "bad",
          title: "Bad",
          type: "graph",
          tier: "ultra",
          nodes: [{ id: "test", label: "Test", tier: "cheap" }],
          edges: [],
        },
      ],
    })

    expect(result.errors).toContain(
      'diagrams[0].tier must be "utility", "fast", "balanced", "expert", or "frontier"',
    )
    expect(result.errors).toContain(
      'diagrams[0].nodes[0].tier must be "utility", "fast", "balanced", "expert", or "frontier"',
    )
  })

  it("maps stable model families to tiers and covers the monthly OpenRouter leaders", () => {
    expect(MODEL_FAMILY_TIERS).toMatchObject({
      "deepseek-v4-flash": "fast",
      hy3: "balanced",
      mimo: "fast",
      luna: "balanced",
      "nemotron-ultra": "fast",
      glm: "balanced",
      opus: "frontier",
      ox: "expert",
      "deepseek-v4-pro": "expert",
      sonnet: "expert",
      terra: "expert",
      sol: "frontier",
      fable: "frontier",
    })
    expect(tierForModelFamily("opus")).toBe("frontier")
    expect(tierForModelFamily("opus-5-20260801")).toBeNull()
  })
})

describe("publish: bundles (zip)", () => {
  it("prefers a root index.html as the entry point", async () => {
    const blobs = makeBlobs()
    const { artifact, version } = await publish(
      makeMeta(),
      blobs,
      bundle({ "index.html": "<h1>home</h1>", "style.css": "body{}" }),
    )
    expect(artifact.kind).toBe("bundle")
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    expect(manifest.entry).toBe("/index.html")
    expect(Object.keys(manifest.files).sort()).toEqual(["/index.html", "/style.css"])
  })

  it("falls back to the shallowest html when there's no root index", async () => {
    const blobs = makeBlobs()
    const { version } = await publish(
      makeMeta(),
      blobs,
      bundle({ "deep/a/b.html": "x", "top.html": "y" }),
    )
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    expect(manifest.entry).toBe("/top.html")
  })

  it("strips path-traversal, __MACOSX, and .DS_Store entries", async () => {
    const blobs = makeBlobs()
    const { version } = await publish(
      makeMeta(),
      blobs,
      bundle({
        "../escape.html": "no",
        "__MACOSX/x": "no",
        ".DS_Store": "no",
        "ok.html": "yes",
      }),
    )
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    expect(Object.keys(manifest.files)).toEqual(["/ok.html"])
    expect(manifest.entry).toBe("/ok.html")
  })

  it("rejects a non-zip, an empty bundle, and one with neither html nor markdown", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    await expect(
      publish(meta, blobs, {
        bytes: new TextEncoder().encode("not a zip"),
        filename: "x.zip",
        isBundle: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(publish(meta, blobs, bundle({}))).rejects.toMatchObject({ statusCode: 400 })
    // A bundle of only non-renderable files (no .html, no .md) still has no entry.
    await expect(publish(meta, blobs, bundle({ "readme.txt": "hi" }))).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it("publishes a skill folder (SKILL.md + scripts, no HTML), entry = /SKILL.md", async () => {
    const blobs = makeBlobs()
    const { artifact, version } = await publish(
      makeMeta(),
      blobs,
      bundle({
        "SKILL.md": "---\nname: my-skill\ndescription: does things\n---\n\n# My Skill\n\nbody",
        "scripts/run.sh": "#!/usr/bin/env bash\necho hi\n",
        "references/notes.md": "# Notes",
      }),
    )
    expect(artifact.kind).toBe("bundle")
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    expect(manifest.entry).toBe("/SKILL.md")
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/SKILL.md",
      "/references/notes.md",
      "/scripts/run.sh",
    ])
  })

  it("a root SKILL.md wins the entry over a nested HTML reference (still a skill)", async () => {
    const blobs = makeBlobs()
    const { version } = await publish(
      makeMeta(),
      blobs,
      bundle({
        "SKILL.md": "---\nname: chart-style\ndescription: how we chart\n---\n\n# Chart style",
        "references/example.html": "<!doctype html><h1>example</h1>",
      }),
    )
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    // Not references/example.html — the skill keeps its identity despite shipping HTML.
    expect(manifest.entry).toBe("/SKILL.md")
    // A skill carries the distinct content type so the library can badge it for free.
    expect(version.content_type).toBe("derive/skill")
  })

  it("prefers HTML over SKILL.md, and falls back to README.md / shallowest .md", async () => {
    const blobs = makeBlobs()
    // HTML wins even when a SKILL.md is present.
    const a = await publish(makeMeta(), blobs, bundle({ "SKILL.md": "# s", "index.html": "<h1>" }))
    const ma = JSON.parse(
      new TextDecoder().decode((await blobs.get(a.version.blob_key)) ?? undefined),
    )
    expect(ma.entry).toBe("/index.html")
    // No HTML, no SKILL.md → README.md.
    const b = await publish(makeMeta(), blobs, bundle({ "README.md": "# r", "deep/x.md": "# x" }))
    const mb = JSON.parse(
      new TextDecoder().decode((await blobs.get(b.version.blob_key)) ?? undefined),
    )
    expect(mb.entry).toBe("/README.md")
    // No HTML, no SKILL/README → shallowest markdown.
    const c = await publish(makeMeta(), blobs, bundle({ "deep/a/b.md": "# b", "top.md": "# t" }))
    const mc = JSON.parse(
      new TextDecoder().decode((await blobs.get(c.version.blob_key)) ?? undefined),
    )
    expect(mc.entry).toBe("/top.md")
  })

  it("a context source dir enters at MANIFEST.md even when a README sits beside it", async () => {
    // The entry is the runner's system prompt — a docs README must not hijack it.
    const blobs = makeBlobs()
    const a = await publish(
      makeMeta(),
      blobs,
      bundle({ "MANIFEST.md": "# m", "README.md": "# r", "references/schema.md": "# s" }),
    )
    const ma = JSON.parse(
      new TextDecoder().decode((await blobs.get(a.version.blob_key)) ?? undefined),
    )
    expect(ma.entry).toBe("/MANIFEST.md")
  })
})

describe("publish: republish an existing artifact", () => {
  it("records validated derivation lineage on creation", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const source = await publish(meta, blobs, file("source"))
    const copy = await publish(meta, blobs, { ...file("copy"), derivedFrom: source.artifact.id })
    expect(copy.artifact.derived_from).toBe(source.artifact.id)
  })

  it("appends a version under the same short id", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const { artifact } = await publish(meta, blobs, file("v1"))
    const { version } = await publish(meta, blobs, file("v2"), artifact.short_id)
    expect(version.n).toBe(2)
  })

  it("404s for an unknown short id and 409s on a kind change", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    await expect(publish(meta, blobs, file("x"), "missing")).rejects.toMatchObject({
      statusCode: 404,
    })
    const { artifact } = await publish(meta, blobs, file("a file"))
    await expect(
      publish(meta, blobs, bundle({ "index.html": "x" }), artifact.short_id),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe("publish: URL + JSON helpers", () => {
  const artifact = {
    short_id: "abc123",
    slug: "my-doc",
    title: "My Doc",
    kind: "file",
    workspace_access: "member",
    link_role: "none",
    listed: "none",
    spa: 0,
    current_version: 2,
    created_at: "t",
  } as unknown as ArtifactRecord

  it("artifactUrl is name-first: explicit slug, else slug-from-title, else bare", () => {
    // Name-first refs (#130): <name>-<short_id>.
    expect(artifactUrl("https://derive.test", artifact)).toBe(
      "https://derive.test/artifacts/my-doc-abc123",
    )
    // No explicit slug → derive the name from the current title (so links stay readable
    // and rename-safe without a backfill).
    expect(artifactUrl("https://derive.test", { ...artifact, slug: null })).toBe(
      "https://derive.test/artifacts/my-doc-abc123",
    )
    // No slug and no title → the bare short id.
    expect(artifactUrl("https://derive.test", { ...artifact, slug: null, title: null })).toBe(
      "https://derive.test/artifacts/abc123",
    )
  })
})

// looksLikeHtmlDocument is the trigger for serve-content's "never serve a blank
// page" self-heal: a blob mislabeled text/markdown whose bytes are really a full
// HTML document is served verbatim as HTML instead of run through the markdown
// renderer (which would strip <head>/<style>/scripts and show white). So the
// boundary that matters is full-document vs. not — false positives would serve a
// fragment as a document; false negatives bring the blank screen back.

describe("looksLikeHtmlDocument", () => {
  it("detects a headless designed page by its head/meta/style openers", () => {
    // The 2026-07 dogfood miss: a styled report opening with <meta>/<style> (no
    // doctype) rendered its CSS as visible text through the markdown path.
    expect(looksLikeHtmlDocument('<meta name="viewport" content="width=device-width" />')).toBe(
      true,
    )
    expect(looksLikeHtmlDocument("<style>body{color:red}</style><p>x</p>")).toBe(true)
    expect(looksLikeHtmlDocument("<head><title>t</title></head>")).toBe(true)
    expect(looksLikeHtmlDocument("<body><h1>hi</h1></body>")).toBe(true)
  })

  it("skips leading HTML comments; the comment alone never decides", () => {
    expect(looksLikeHtmlDocument("<!-- generated --><!doctype html><html></html>")).toBe(true)
    expect(looksLikeHtmlDocument('<!-- a -->\n<!-- b -->\n<meta charset="utf-8" />')).toBe(true)
    // Markdown that merely opens with a comment stays markdown.
    expect(looksLikeHtmlDocument("<!-- prettier-ignore -->\n# Heading\n\nprose")).toBe(false)
    expect(looksLikeHtmlDocument("<!-- unterminated comment")).toBe(false)
  })

  it("is false for ambiguous fragments — how HTML-flavored Markdown opens", () => {
    // A centered README opens with <div align="center">; a snippet with <p>/<h1>.
    // Rendering those as markdown is correct.
    expect(looksLikeHtmlDocument('<div align="center">fragment</div>')).toBe(false)
    expect(looksLikeHtmlDocument("<p>a paragraph</p>")).toBe(false)
    expect(looksLikeHtmlDocument("<h1>title</h1>")).toBe(false)
    expect(looksLikeHtmlDocument('<?xml version="1.0"?><svg></svg>')).toBe(false)
  })
})
