import { createHmac, generateKeyPairSync } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FsBlobStore } from "@dock/storage/fs"
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
const WHSEC = "whsec_dock_test"
const ORG = "prpreview-ws"
const INSTALL = "100"
const REPO = "acme/docs"

const signed = (body: string) => `sha256=${createHmac("sha256", WHSEC).update(body).digest("hex")}`

const { app, meta } = quotaApp("prpreview", { encryptionKey: KEY, startSync: () => {} })
const blobStore = new FsBlobStore(mkdtempSync(join(tmpdir(), "dock-pr-blobs-")))
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
// The repo tree at any ref: two markdown docs + one non-doc (excluded by the globs).
const tree = [
  { path: "docs/guide.md", sha: "g1", type: "blob" as const },
  { path: "docs/other.md", sha: "o1", type: "blob" as const },
  { path: "src/x.ts", sha: "x1", type: "blob" as const },
]
const blobs: Record<string, string> = { g1: "# Guide", o1: "# Other", x1: "const x = 1" }

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
      return new Response("nf", { status: 404 })
    }),
  )

  await meta.setGithubApp({
    id: "default",
    app_id: "1",
    slug: "dock-test",
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
})
