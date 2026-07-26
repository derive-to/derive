import { createHmac } from "node:crypto"
import { DEFAULT_ORG_SETTINGS } from "@derive/core"
import { describe, expect, it } from "vitest"
import { encryptSecret } from "../src/lib/crypto"
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
      slackPost: true,
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
