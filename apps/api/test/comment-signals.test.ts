import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publish } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Backend for the "Needs your feedback" feature: per-artifact comment signals (open
// thread count + whether the viewer is tagged in or authored an open thread), and the
// set of artifacts needing the viewer's feedback. Mentions live in comment.meta JSON;
// "needs feedback" = tagged OR authored, in an OPEN thread only.

const dir = mkdtempSync(join(tmpdir(), "dock-comment-signals-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ME = "user_me"
const OTHER = "user_other"
const mentionMeta = (id: string) => JSON.stringify({ mentions: [{ id, name: "Me" }] })

let meta: SqliteMetaStore
let ids: { mentioned: string; authored: string; uninvolved: string; resolved: string }

beforeAll(async () => {
  meta = new SqliteMetaStore(join(dir, "signals.db"))
  const blobs = new FsBlobStore(join(dir, "blobs"))
  const mk = async (title: string) =>
    (
      await publish(meta, blobs, {
        bytes: new TextEncoder().encode("<p>x</p>"),
        filename: "a.html",
        isBundle: false,
        title,
        author: "seed",
      })
    ).artifact.id

  // A1: an open thread that @mentions me (authored by someone else) + a second open
  // thread, so open_threads must count DISTINCT threads (2), not comments.
  const mentioned = await mk("A1")
  await meta.createComment({
    id: "c1",
    artifact_id: mentioned,
    thread_id: "t1",
    base_version: 1,
    body_md: "hey @me",
    author: "Other",
    author_id: OTHER,
  })
  await meta.updateComment("c1", { meta: mentionMeta(ME) })
  await meta.createComment({
    id: "c1b",
    artifact_id: mentioned,
    thread_id: "t1b",
    base_version: 1,
    body_md: "another thread",
    author: "Other",
    author_id: OTHER,
  })

  // A2: an open thread I authored (no mention).
  const authored = await mk("A2")
  await meta.createComment({
    id: "c2",
    artifact_id: authored,
    thread_id: "t2",
    base_version: 1,
    body_md: "my note",
    author: "Me",
    author_id: ME,
  })

  // A3: an open thread by someone else that doesn't involve me (count only).
  const uninvolved = await mk("A3")
  await meta.createComment({
    id: "c3",
    artifact_id: uninvolved,
    thread_id: "t3",
    base_version: 1,
    body_md: "unrelated",
    author: "Other",
    author_id: OTHER,
  })

  // A4: a RESOLVED thread that mentions me — must NOT count (only open threads do).
  const resolved = await mk("A4")
  await meta.createComment({
    id: "c4",
    artifact_id: resolved,
    thread_id: "t4",
    base_version: 1,
    body_md: "old",
    author: "Other",
    author_id: OTHER,
  })
  await meta.updateComment("c4", { meta: mentionMeta(ME) })
  await meta.setThreadState(resolved, "t4", "resolved")

  ids = { mentioned, authored, uninvolved, resolved }
})

describe("commentSignals", () => {
  it("reports distinct open threads + tagged/authored flags per artifact", async () => {
    const sig = await meta.commentSignals(
      [ids.mentioned, ids.authored, ids.uninvolved, ids.resolved],
      ME,
    )
    expect(sig[ids.mentioned]).toEqual({
      open_threads: 2,
      mentions_me: true,
      i_participated: false,
    })
    expect(sig[ids.authored]).toEqual({ open_threads: 1, mentions_me: false, i_participated: true })
    expect(sig[ids.uninvolved]).toEqual({
      open_threads: 1,
      mentions_me: false,
      i_participated: false,
    })
    // Resolved-only artifact has no open threads → no entry at all.
    expect(sig[ids.resolved]).toBeUndefined()
  })

  it("a null viewer gets counts but no personal flags", async () => {
    const sig = await meta.commentSignals([ids.mentioned, ids.authored], null)
    expect(sig[ids.mentioned]).toEqual({
      open_threads: 2,
      mentions_me: false,
      i_participated: false,
    })
    expect(sig[ids.authored]).toEqual({
      open_threads: 1,
      mentions_me: false,
      i_participated: false,
    })
  })
})

describe("artifactIdsNeedingFeedback", () => {
  it("returns artifacts where I'm tagged or authored an OPEN thread — nothing else", async () => {
    const got = await meta.artifactIdsNeedingFeedback(ME, "local")
    expect([...got].sort()).toEqual([ids.mentioned, ids.authored].sort())
    // Not the uninvolved one, and not the resolved one (even though it tagged me).
    expect(got).not.toContain(ids.uninvolved)
    expect(got).not.toContain(ids.resolved)
  })
})
