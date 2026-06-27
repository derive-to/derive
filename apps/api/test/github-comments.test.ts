import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, type CommentRecord, newId, type RepoSourceRecord } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseMeta } from "../src/lib/comments"
import {
  enqueueGithubPrComment,
  ingestGithubPrComment,
  lineFromDiffHunk,
  lineOfQuote,
  prSourceForArtifact,
} from "../src/lib/github-comments"

describe("anchor/line mapping", () => {
  it("finds the 1-based line of a quote's first non-empty line", () => {
    const text = "# Title\n\nfirst paragraph\nsecond paragraph\n"
    expect(lineOfQuote(text, "second paragraph")).toBe(4)
    expect(lineOfQuote(text, "  second paragraph  ")).toBe(4) // tolerant of indentation
    expect(lineOfQuote(text, "nope")).toBe(null)
  })

  it("extracts the commented line from a diff hunk (last added/context line)", () => {
    const hunk = "@@ -1,3 +1,4 @@\n context\n-removed line\n+added line here"
    expect(lineFromDiffHunk(hunk)).toBe("added line here")
    expect(lineFromDiffHunk("@@ -1 +1 @@\n-only removed")).toBe(null)
    expect(lineFromDiffHunk(undefined)).toBe(null)
  })
})

describe("github comment mirroring (inbound)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dock-ghc-"))
  const meta = new SqliteMetaStore(join(dir, "db.sqlite"))
  let artifact: ArtifactRecord
  let source: RepoSourceRecord

  beforeAll(async () => {
    artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: "ghc00001",
      org_id: "default",
      slug: null,
      title: "Doc",
      visibility: "link",
      kind: "file",
      spa: 0,
    })
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: "default",
      title: "PR #7",
      created_by: "u",
    })
    source = await meta.createRepoSource({
      id: newId("rs"),
      org_id: "default",
      collection_id: col.id,
      repo: "acme/widgets",
      ref: "headsha123",
      includes: "**/*.md",
      created_by: "u",
      pr_number: 7,
      installation_id: "inst1",
      files: JSON.stringify({ "docs/intro.md": { artifact_id: artifact.id, sha: "s1" } }),
    } as Parameters<typeof meta.createRepoSource>[0])
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("reverse-looks-up the PR source + path for an artifact", async () => {
    const found = await prSourceForArtifact(meta, artifact)
    expect(found?.path).toBe("docs/intro.md")
    expect(found?.source.pr_number).toBe(7)
  })

  it("mirrors an inline review comment as an anchored Dock comment", async () => {
    const created = await ingestGithubPrComment(meta, source, {
      ghCommentId: 1001,
      kind: "review",
      authorLogin: "octocat",
      authorType: "User",
      body: "needs a tweak",
      path: "docs/intro.md",
      diffHunk: "@@ -1 +1 @@\n+the intro line",
    })
    expect(created).toBeTruthy()
    expect(created?.author).toBe("octocat")
    expect(created?.author_id).toBe("gh:octocat")
    expect(created?.path).toBe("docs/intro.md")
    expect(JSON.parse(created?.anchor ?? "{}").exact).toBe("the intro line")
    expect(parseMeta(created?.meta ?? null).github?.comment_id).toBe(1001)
  })

  it("skips bot authors (our own write-back) — loop prevention", async () => {
    const r = await ingestGithubPrComment(meta, source, {
      ghCommentId: 2002,
      kind: "issue",
      authorLogin: "dock[bot]",
      authorType: "Bot",
      body: "echo",
    })
    expect(r).toBe(null)
  })

  it("skips a body still carrying the Dock marker", async () => {
    const r = await ingestGithubPrComment(meta, source, {
      ghCommentId: 2003,
      kind: "issue",
      authorLogin: "octocat",
      body: "hello\n\n_— via Dock_",
    })
    expect(r).toBe(null)
  })

  it("dedupes an already-mirrored GitHub comment id", async () => {
    const again = await ingestGithubPrComment(meta, source, {
      ghCommentId: 1001,
      kind: "review",
      authorLogin: "octocat",
      body: "needs a tweak",
      path: "docs/intro.md",
    })
    expect(again).toBe(null)
  })
})

describe("github comment write-back (outbound enqueue)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dock-ghc-out-"))
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
      visibility: "link",
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
    await enqueueGithubPrComment({ meta, blobs, baseUrl: "https://dock.test" }, artifact, cm)
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
    await enqueueGithubPrComment({ meta, blobs, baseUrl: "https://dock.test" }, artifact, fromGh)
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
    await enqueueGithubPrComment({ meta, blobs, baseUrl: "https://dock.test" }, artifact, cm)
    const rows = (await claim()).filter((d) => d.webhook_id === "internal")
    expect(rows.some((d) => d.kind === "github_issue_comment")).toBe(true)
  })
})
