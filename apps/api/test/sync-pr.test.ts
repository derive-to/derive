import { createHmac, generateKeyPairSync } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_ORG_SETTINGS } from "@derive/core"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { encryptSecret } from "../src/lib/crypto"
import { runToCompletion } from "../src/lib/sync-runner"
import { quotaApp } from "./helpers"

// End-to-end PR previews: a `pull_request` webhook creates an ephemeral "PR #<n>"
// repo_source (pr_number set, ref = head sha) and the engine mirrors ONLY the PR's
// CHANGED docs into its collection; close tears it down. We give the app a no-op
// `startSync` so the webhook doesn't fire a detached sync, then drive the engine
// inline via runToCompletion for a deterministic assertion.

const { privateKey: RSA_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const KEY = "test-encryption-key"
const WHSEC = "whsec_derive_test"
const ORG = "prpreview-ws"
const INSTALL = "100"
const REPO = "acme/docs"

const signed = (body: string) => `sha256=${createHmac("sha256", WHSEC).update(body).digest("hex")}`

const { app, meta } = quotaApp("prpreview", { encryptionKey: KEY, startSync: () => {} })
const blobStore = new FsBlobStore(mkdtempSync(join(tmpdir(), "derive-pr-blobs-")))
const sync = (id: string) => runToCompletion(meta, blobStore, KEY, id)

const postWebhook = (action: string, pr: Record<string, unknown>) => {
  const payload = {
    action,
    installation: { id: Number(INSTALL) },
    repository: { full_name: REPO },
    pull_request: pr,
  }
  const body = JSON.stringify(payload)
  return app.request("/v1/sync/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signed(body),
    },
    body,
  })
}

// What `GET /pulls/:n/files` returns — mutated per test to drive different change sets.
let prFiles: { filename: string; status: string }[] = []
// In-memory GitHub issue (PR conversation) comments, keyed by PR number — the sticky
// preview comment writes here so tests can assert post-once + edit-in-place.
const ghComments: Record<string, { id: number; body: string }[]> = {}
let ghCommentSeq = 0
// The repo tree at any ref: markdown docs + one non-doc (excluded by the globs).
// promote-me.md / edit-me.md back the merge-graduation tests.
const tree = [
  { path: "docs/guide.md", sha: "g1", type: "blob" as const },
  { path: "docs/other.md", sha: "o1", type: "blob" as const },
  { path: "docs/promote-me.md", sha: "pm1", type: "blob" as const },
  { path: "docs/edit-me.md", sha: "e1", type: "blob" as const },
  { path: "src/x.ts", sha: "x1", type: "blob" as const },
]
const blobs: Record<string, string> = {
  g1: "# Guide",
  o1: "# Other",
  pm1: "# New plan",
  e1: "# Edit me",
  x1: "const x = 1",
}

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const s = String(url)
      const method = (init?.method ?? "GET").toUpperCase()
      // Installation token (effectiveToken → installationToken).
      if (s.includes("/access_tokens") && method === "POST")
        return new Response(
          JSON.stringify({ token: "ghs_test", expires_at: "2099-01-01T00:00:00.000Z" }),
          { status: 200 },
        )
      // The PR's changed files (drives the preview scope).
      if (/\/pulls\/\d+\/files/.test(s))
        return new Response(JSON.stringify(prFiles), { status: 200 })
      if (s.includes("/git/trees/"))
        return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 })
      const bm = s.match(/\/git\/blobs\/([^/?]+)/)
      if (bm?.[1]) {
        const b = blobs[bm[1]]
        return b == null ? new Response("nf", { status: 404 }) : new Response(b, { status: 200 })
      }
      // lastCommit (best-effort) + GraphQL batch (force the REST blob fallback).
      if (s.includes("/commits?")) return new Response("[]", { status: 200 })
      if (s.endsWith("/graphql")) return new Response("nope", { status: 404 })
      // Sticky preview comment: list / create / edit (scoped per PR number).
      const icList = s.match(/\/issues\/(\d+)\/comments/)
      if (icList?.[1] && method === "GET")
        return new Response(JSON.stringify(ghComments[icList[1]] ?? []), { status: 200 })
      if (icList?.[1] && method === "POST") {
        const b = JSON.parse(String(init?.body ?? "{}")) as { body: string }
        const id = ++ghCommentSeq
        const pr = icList[1]
        if (!ghComments[pr]) ghComments[pr] = []
        ghComments[pr].push({ id, body: b.body })
        return new Response(JSON.stringify({ id }), { status: 201 })
      }
      const icPatch = s.match(/\/issues\/comments\/(\d+)/)
      if (icPatch?.[1] && method === "PATCH") {
        const id = Number(icPatch[1])
        const b = JSON.parse(String(init?.body ?? "{}")) as { body: string }
        for (const arr of Object.values(ghComments)) {
          const c = arr.find((x) => x.id === id)
          if (c) c.body = b.body
        }
        return new Response(JSON.stringify({ id }), { status: 200 })
      }
      return new Response("nf", { status: 404 })
    }),
  )

  await meta.setGithubApp({
    id: "default",
    app_id: "1",
    slug: "derive-test",
    client_id: "Iv1.x",
    client_secret: encryptSecret("cs", KEY),
    private_key: encryptSecret(RSA_PEM, KEY),
    webhook_secret: encryptSecret(WHSEC, KEY),
    created_at: "2026-06-15T00:00:00.000Z",
  })
  await meta.upsertGithubInstallation({
    installation_id: INSTALL,
    org_id: ORG,
    account_login: "acme",
    created_by: "u1",
    created_at: "2026-06-15T00:00:00.000Z",
  })
  // The BRANCH mirror (no pr_number). PR previews are only created for connected repos.
  const col = await meta.createCollection({
    id: "col_branch",
    org_id: ORG,
    title: `GitHub: ${REPO}`,
    created_by: "u1",
  })
  await meta.createRepoSource({
    id: "rs_branch",
    org_id: ORG,
    collection_id: col.id,
    repo: REPO,
    ref: "HEAD",
    includes: "**/*.md",
    token: null,
    installation_id: INSTALL,
    created_by: "u1",
  })
})
afterAll(() => vi.unstubAllGlobals())

const preview = async (prNumber: number) =>
  (await meta.listRepoSources(ORG)).find((s) => s.pr_number === prNumber)

// The docs currently mirrored by a source = the keys of its `files` map (the engine's
// authoritative set; a dropped doc is tombstoned + removed from this map on re-sync).
const mirrored = async (prNumber: number): Promise<string[]> => {
  const p = await preview(prNumber)
  return Object.keys(JSON.parse(p?.files ?? "{}")).sort()
}

type FileMap = Record<string, { artifact_id?: string }>
// The artifact id a PR preview currently mirrors at a path (from its files map).
const previewArtifactAt = async (prNumber: number, path: string): Promise<string | undefined> => {
  const p = await preview(prNumber)
  return (JSON.parse(p?.files ?? "{}") as FileMap)[path]?.artifact_id
}
// The artifact id the BRANCH mirror owns at a path.
const branchArtifactAt = async (path: string): Promise<string | undefined> => {
  const b = await meta.getRepoSource("rs_branch", ORG)
  return (JSON.parse(b?.files ?? "{}") as FileMap)[path]?.artifact_id
}

describe("github pr previews", () => {
  it("opened: mirrors ONLY the PR's changed docs into a 'PR #<n>' collection", async () => {
    // The PR changes one doc + one non-doc; the unchanged doc must stay out.
    prFiles = [
      { filename: "docs/guide.md", status: "modified" },
      { filename: "src/x.ts", status: "modified" },
    ]
    const res = await postWebhook("opened", { number: 7, title: "Add guide", head: { sha: "h1" } })
    expect(res.status).toBe(200)

    const p = await preview(7)
    if (!p) throw new Error("preview not created")
    expect(p.ref).toBe("h1") // mirrors the PR head sha
    expect(p.installation_id).toBe(INSTALL) // inherited from the branch source
    const col = await meta.getCollection(p.collection_id)
    expect(col?.title).toBe("PR #7: Add guide")

    await sync(p.id)
    // Exactly the changed .md. NOT docs/other.md (unchanged), NOT src/x.ts (not a doc).
    expect(await mirrored(7)).toEqual(["docs/guide.md"])
  })

  it("synchronize: re-points the preview at the new head and re-scopes the docs", async () => {
    // A new push to the PR: now it changes the OTHER doc instead of the guide.
    prFiles = [{ filename: "docs/other.md", status: "modified" }]
    const res = await postWebhook("synchronize", {
      number: 7,
      title: "Add guide",
      head: { sha: "h2" },
    })
    expect(res.status).toBe(200)

    const p = await preview(7)
    if (!p) throw new Error("preview vanished")
    expect(p.ref).toBe("h2") // re-pointed at the new head

    await sync(p.id)
    // Re-scoped: docs/other.md is now mirrored; docs/guide.md is dropped (tombstoned).
    expect(await mirrored(7)).toEqual(["docs/other.md"])
  })

  it("closed: tears the preview down (source + collection gone)", async () => {
    const before = await preview(7)
    if (!before) throw new Error("no preview to close")
    const res = await postWebhook("closed", { number: 7, title: "Add guide", head: { sha: "h2" } })
    expect(res.status).toBe(200)

    expect(await preview(7)).toBeUndefined()
    expect(await meta.getCollection(before.collection_id)).toBeNull()
  })

  it("opened with no changed docs: creates no preview", async () => {
    prFiles = [{ filename: "src/only-code.ts", status: "modified" }]
    const res = await postWebhook("opened", { number: 9, title: "Code only", head: { sha: "c1" } })
    expect(res.status).toBe(200)
    expect(await preview(9)).toBeUndefined()
  })

  it("merged (new doc): promotes the reviewed artifact into the main collection", async () => {
    // A doc the branch mirror doesn't own yet → PROMOTE on merge.
    prFiles = [{ filename: "docs/promote-me.md", status: "added" }]
    await postWebhook("opened", { number: 11, title: "New plan", head: { sha: "p1" } })
    const p = await preview(11)
    if (!p) throw new Error("no preview")
    await sync(p.id)
    const artId = await previewArtifactAt(11, "docs/promote-me.md")
    if (!artId) throw new Error("preview didn't mirror the doc")

    await postWebhook("closed", {
      number: 11,
      title: "New plan",
      merged: true,
      head: { sha: "p1" },
    })

    expect(await preview(11)).toBeUndefined() // preview shell gone
    // The SAME artifact you reviewed is now canonical: alive, in the main collection,
    // owned by the branch source.
    expect(await meta.getArtifactById(artId)).not.toBeNull()
    expect(await meta.collectionArtifactIds("col_branch")).toContain(artId)
    expect(await branchArtifactAt("docs/promote-me.md")).toBe(artId)
  })

  it("merged (edited doc): folds the PR's versions + comments into the canonical doc", async () => {
    // Make the branch mirror own the docs first, so an edit folds rather than promotes.
    await sync("rs_branch")
    const canonicalId = await branchArtifactAt("docs/edit-me.md")
    if (!canonicalId) throw new Error("branch didn't mirror edit-me.md")
    const before = await meta.getArtifactById(canonicalId)
    const beforeVersion = before?.current_version ?? 0

    // A PR edits that doc; reviewer leaves a comment on the preview.
    prFiles = [{ filename: "docs/edit-me.md", status: "modified" }]
    await postWebhook("opened", { number: 12, title: "Edit plan", head: { sha: "e2" } })
    const p = await preview(12)
    if (!p) throw new Error("no preview")
    await sync(p.id)
    const previewArtId = await previewArtifactAt(12, "docs/edit-me.md")
    if (!previewArtId) throw new Error("preview didn't mirror the doc")
    await meta.createComment({
      id: "cm_fold_root",
      artifact_id: previewArtId,
      thread_id: "cm_fold_root",
      base_version: 1,
      path: null,
      anchor: null,
      body_md: "ship it",
      author: "reviewer",
      author_id: "rev1",
    })

    await postWebhook("closed", {
      number: 12,
      title: "Edit plan",
      merged: true,
      head: { sha: "e2" },
    })

    expect(await preview(12)).toBeUndefined() // preview shell gone
    expect(await meta.getArtifactById(previewArtId)).toBeNull() // preview copy deleted
    const after = await meta.getArtifactById(canonicalId)
    expect(after?.current_version ?? 0).toBeGreaterThan(beforeVersion) // PR version folded in
    const comments = await meta.listComments(canonicalId)
    expect(comments.some((c) => c.body_md === "ship it")).toBe(true) // review carried over
  })
})

describe("github pr preview: sticky comment on the PR", () => {
  it("opened: posts ONE comment linking to the preview collection", async () => {
    prFiles = [{ filename: "docs/guide.md", status: "modified" }]
    await postWebhook("opened", { number: 20, title: "Doc PR", head: { sha: "s20" } })
    const p = await preview(20)
    if (!p) throw new Error("no preview")
    const comments = ghComments["20"] ?? []
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain(`/?collection=${p.collection_id}`)
    expect(comments[0]?.body).toContain("<!-- derive-preview -->") // sticky marker
    expect(comments[0]?.body).toContain("1 doc")
    expect(comments[0]?.body).not.toContain("—") // no em dashes in customer-facing copy
  })

  it("synchronize: edits the same comment in place (no duplicate)", async () => {
    prFiles = [
      { filename: "docs/guide.md", status: "modified" },
      { filename: "docs/other.md", status: "modified" },
    ]
    await postWebhook("synchronize", { number: 20, title: "Doc PR", head: { sha: "s21" } })
    const comments = ghComments["20"] ?? []
    expect(comments).toHaveLength(1) // still one — sticky, not spammed
    expect(comments[0]?.body).toContain("2 docs")
  })

  it("closed without merge: resolves the comment to a removed note", async () => {
    await postWebhook("closed", { number: 20, title: "Doc PR", head: { sha: "s21" } })
    const comments = ghComments["20"] ?? []
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body.toLowerCase()).toContain("removed")
  })

  it("respects the workspace toggle: no comment when githubPreviewLink is off", async () => {
    await meta.setOrgSettings(ORG, {
      ...DEFAULT_ORG_SETTINGS,
      emailNotifications: true,
      githubPostComments: true,
      githubMirrorComments: true,
      githubPreviewLink: false,
    })
    prFiles = [{ filename: "docs/guide.md", status: "modified" }]
    await postWebhook("opened", { number: 21, title: "No comment", head: { sha: "s30" } })
    expect(await preview(21)).toBeDefined() // preview still created
    expect(ghComments["21"]).toBeUndefined() // but no PR comment posted
    // Restore for any later assertions.
    await meta.setOrgSettings(ORG, {
      ...DEFAULT_ORG_SETTINGS,
      emailNotifications: true,
      githubPostComments: true,
      githubMirrorComments: true,
      githubPreviewLink: true,
    })
  })
})
