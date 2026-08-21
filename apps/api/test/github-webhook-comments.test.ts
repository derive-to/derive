import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, type CommentRecord, DEFAULT_ORG_SETTINGS, newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { encryptSecret } from "../src/lib/crypto"
import { enqueueGithubPrComment } from "../src/lib/github-comments"
import { quotaApp } from "./helpers"

// Inbound half of bidirectional GitHub comment sync: a PR comment made on GitHub is
// mirrored into the matching Derive artifact. Gated by the App webhook-secret HMAC + the
// githubMirrorComments workspace toggle.
const KEY = "gh-webhook-comments-key"
const WHSEC = "whsec_derive_ghc"

const seedApp = async (meta: Awaited<ReturnType<typeof quotaApp>>["meta"]) =>
  meta.setGithubApp({
    id: "default",
    app_id: "1",
    slug: "derive-test",
    client_id: "Iv1.x",
    client_secret: encryptSecret("cs", KEY),
    private_key: encryptSecret("pk", KEY),
    webhook_secret: encryptSecret(WHSEC, KEY),
    created_at: "2026-06-15T00:00:00.000Z",
  })

// A PR-preview source mapping docs/intro.md → an artifact, like the PR sync builds.
const seedPrSource = async (meta: Awaited<ReturnType<typeof quotaApp>>["meta"]) => {
  const artifact = await meta.createArtifact({
    id: "a-ghw",
    short_id: "ghw00001",
    org_id: "default",
    slug: null,
    title: "Doc",
    workspace_access: "member",
    link_role: "viewer",
    listed: "public",
    kind: "file",
    spa: 0,
  })
  const col = await meta.createCollection({
    id: "col-ghw",
    org_id: "default",
    title: "PR #5",
    created_by: "u",
  })
  await meta.createRepoSource({
    id: "rs-ghw",
    org_id: "default",
    collection_id: col.id,
    repo: "acme/widgets",
    ref: "headsha",
    includes: "**/*.md",
    created_by: "u",
    pr_number: 5,
    installation_id: "1",
    files: JSON.stringify({ "docs/intro.md": { artifact_id: artifact.id, sha: "s1" } }),
    // biome-ignore lint/suspicious/noExplicitAny: NewRepoSource optional fields vary by dialect
  } as any)
  return artifact
}

const signed = (body: string) => `sha256=${createHmac("sha256", WHSEC).update(body).digest("hex")}`

const post = (
  app: ReturnType<typeof quotaApp>["app"],
  event: string,
  payload: unknown,
  sig?: string,
) => {
  const body = JSON.stringify(payload)
  return app.request("/v1/sync/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": sig ?? signed(body),
    },
    body,
  })
}

const reviewCommentPayload = (overrides: Record<string, unknown> = {}) => ({
  action: "created",
  installation: { id: 1 },
  repository: { full_name: "acme/widgets" },
  pull_request: { number: 5 },
  comment: {
    id: 9001,
    body: "please tweak this",
    path: "docs/intro.md",
    diff_hunk: "@@ -1 +1 @@\n+the intro line",
    user: { login: "octocat", type: "User" },
    ...overrides,
  },
})

describe("github → derive comment mirroring (webhook)", () => {
  it("rejects a bad signature", async () => {
    const { app, meta } = quotaApp("ghwc-badsig", { encryptionKey: KEY })
    await seedApp(meta)
    const r = await post(app, "pull_request_review_comment", reviewCommentPayload(), "sha256=bad")
    expect(r.status).toBe(401)
  })

  it("mirrors an inline review comment onto the artifact, anchored to the line", async () => {
    const { app, meta } = quotaApp("ghwc-review", { encryptionKey: KEY })
    await seedApp(meta)
    const artifact = await seedPrSource(meta)
    const r = await post(app, "pull_request_review_comment", reviewCommentPayload())
    expect(r.status).toBe(200)
    const comments = await meta.listComments(artifact.id)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.author).toBe("octocat")
    expect(comments[0]?.author_id).toBe("gh:octocat")
    expect(JSON.parse(comments[0]?.anchor ?? "{}").exact).toBe("the intro line")
  })

  it("mirrors a top-level PR issue comment onto the PR's first doc", async () => {
    const { app, meta } = quotaApp("ghwc-issue", { encryptionKey: KEY })
    await seedApp(meta)
    const artifact = await seedPrSource(meta)
    const r = await post(app, "issue_comment", {
      action: "created",
      installation: { id: 1 },
      repository: { full_name: "acme/widgets" },
      issue: { number: 5, pull_request: { url: "x" } },
      comment: { id: 9100, body: "overall looks good", user: { login: "dana", type: "User" } },
    })
    expect(r.status).toBe(200)
    const comments = await meta.listComments(artifact.id)
    expect(comments.find((c) => c.author === "dana")?.body_md).toBe("overall looks good")
  })

  it("skips a comment authored by a bot (our own write-back)", async () => {
    const { app, meta } = quotaApp("ghwc-bot", { encryptionKey: KEY })
    await seedApp(meta)
    const artifact = await seedPrSource(meta)
    const r = await post(
      app,
      "pull_request_review_comment",
      reviewCommentPayload({ user: { login: "derive[bot]", type: "Bot" } }),
    )
    expect(r.status).toBe(200)
    expect(await meta.listComments(artifact.id)).toHaveLength(0)
  })

  it("does nothing when the workspace has mirroring turned off", async () => {
    const { app, meta } = quotaApp("ghwc-off", { encryptionKey: KEY })
    await seedApp(meta)
    const artifact = await seedPrSource(meta)
    await meta.setOrgSettings("default", {
      ...DEFAULT_ORG_SETTINGS,
      emailNotifications: true,
      githubPostComments: true,
      githubMirrorComments: false,
      githubPreviewLink: true,
    })
    const r = await post(app, "pull_request_review_comment", reviewCommentPayload())
    expect(r.status).toBe(200)
    expect(await meta.listComments(artifact.id)).toHaveLength(0)
  })

  it("dedupes a redelivered comment id", async () => {
    const { app, meta } = quotaApp("ghwc-dedupe", { encryptionKey: KEY })
    await seedApp(meta)
    const artifact = await seedPrSource(meta)
    await post(app, "pull_request_review_comment", reviewCommentPayload())
    await post(app, "pull_request_review_comment", reviewCommentPayload())
    expect(await meta.listComments(artifact.id)).toHaveLength(1)
  })
})

// Outbound half: a Derive comment on a PR-preview doc is queued for write-back to GitHub,
// resolved to the file + line + commit when the quote can be located, else as an issue comment.
describe("github comment write-back (outbound enqueue)", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-ghc-out-"))
  const meta = new SqliteMetaStore(join(dir, "db.sqlite"))
  const blobs = new FsBlobStore(join(dir, "blobs"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const setup = async () => {
    let artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Doc",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    // A version whose blob holds the text the comment anchor quotes.
    const key = await blobs.put(new TextEncoder().encode("# Title\n\nthe target line here\n"))
    await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key: key,
      content_type: "text/markdown",
      author: "u",
      message: null,
    })
    artifact = (await meta.getArtifactById(artifact.id)) as ArtifactRecord
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "default",
      title: "PR #9",
      created_by: "u",
    })
    await meta.createRepoSource({
      id: newId("rs"),
      org_id: "default",
      collection_id: col.id,
      repo: "acme/widgets",
      ref: "headsha999",
      includes: "**/*.md",
      created_by: "u",
      pr_number: 9,
      installation_id: "1",
      files: JSON.stringify({ "docs/intro.md": { artifact_id: artifact.id, sha: "s1" } }),
    } as Parameters<typeof meta.createRepoSource>[0])
    return artifact
  }

  const claim = () =>
    meta.claimDueDeliveries(
      new Date(Date.now() + 60_000).toISOString(),
      100,
      new Date(Date.now() + 120_000).toISOString(),
    )

  it("enqueues an inline review comment with the resolved file + line + commit", async () => {
    const artifact = await setup()
    const cm = await meta.createComment({
      id: newId("c"),
      artifact_id: artifact.id,
      thread_id: newId("c"),
      base_version: artifact.current_version,
      path: "docs/intro.md",
      anchor: JSON.stringify({ exact: "the target line here" }),
      body_md: "fix this",
      author: "Ada",
      author_id: "u1",
    })
    await enqueueGithubPrComment({ meta, blobs, baseUrl: "https://derive.test" }, artifact, cm)
    const rows = (await claim()).filter((d) => d.webhook_id === "internal")
    const gh = rows.find((d) => d.kind === "github_review_comment")
    expect(gh).toBeTruthy()
    const payload = JSON.parse(gh?.payload ?? "{}")
    expect(payload).toMatchObject({
      repo: "acme/widgets",
      prNumber: 9,
      path: "docs/intro.md",
      line: 3,
      commitId: "headsha999",
    })
  })

  it("does not enqueue for a comment that originated in GitHub (loop prevention)", async () => {
    const artifact = await setup()
    const cm = await meta.createComment({
      id: newId("c"),
      artifact_id: artifact.id,
      thread_id: newId("c"),
      base_version: artifact.current_version,
      path: "docs/intro.md",
      anchor: null,
      body_md: "from gh",
      author: "octocat",
      author_id: "gh:octocat",
    })
    await meta.updateComment(cm.id, {
      meta: JSON.stringify({ github: { comment_id: 5, kind: "review" } }),
    })
    const fromGh = (await meta.getComment(cm.id)) as CommentRecord
    await enqueueGithubPrComment({ meta, blobs, baseUrl: "https://derive.test" }, artifact, fromGh)
    const rows = (await claim()).filter((d) => d.webhook_id === "internal")
    expect(rows).toHaveLength(0)
  })

  it("falls back to a top-level issue comment when the quote can't be located", async () => {
    const artifact = await setup()
    const cm = await meta.createComment({
      id: newId("c"),
      artifact_id: artifact.id,
      thread_id: newId("c"),
      base_version: artifact.current_version,
      path: "docs/intro.md",
      anchor: JSON.stringify({ exact: "text that is not in the file" }),
      body_md: "general note",
      author: "Ada",
      author_id: "u1",
    })
    await enqueueGithubPrComment({ meta, blobs, baseUrl: "https://derive.test" }, artifact, cm)
    const rows = (await claim()).filter((d) => d.webhook_id === "internal")
    expect(rows.some((d) => d.kind === "github_issue_comment")).toBe(true)
  })
})
