import type { CommentRecord, CommentState } from "@dock/core"
import { beforeEach, describe, expect, it } from "vitest"
import { markAddressed, releaseAddressed } from "../src/lib/addressed"
import { parseMeta } from "../src/lib/comments"

// Unit-level guards for the addressed/release helpers. The end-to-end lifecycle
// (propose -> addressed -> approve/withdraw) is covered by addressed.test.ts; this
// pins the edge cases that integration test doesn't exercise — resolved-skip,
// cross-artifact-skip, multi-proposal isolation, and meta preservation.

// A focused in-memory comment store with the same semantics the helpers rely on
// (setThreadState flips EVERY row sharing a thread id).
class FakeStore {
  rows: CommentRecord[] = []
  async getComment(id: string): Promise<CommentRecord | null> {
    return this.rows.find((r) => r.id === id) ?? null
  }
  async updateComment(
    id: string,
    fields: { body_md?: string; meta?: string | null },
  ): Promise<CommentRecord | null> {
    const r = this.rows.find((x) => x.id === id)
    if (!r) return null
    Object.assign(r, fields)
    return r
  }
  async setThreadState(artifactId: string, threadId: string, state: CommentState): Promise<number> {
    let n = 0
    for (const r of this.rows)
      if (r.artifact_id === artifactId && r.thread_id === threadId) {
        r.state = state
        n++
      }
    return n
  }
  async listComments(
    artifactId: string,
    opts?: { state?: CommentState },
  ): Promise<CommentRecord[]> {
    return this.rows.filter(
      (r) => r.artifact_id === artifactId && (!opts?.state || r.state === opts.state),
    )
  }
}

const ART = "art1"
const row = (over: Partial<CommentRecord> & { id: string }): CommentRecord => ({
  artifact_id: ART,
  thread_id: over.id, // default: a root comment (id === thread_id)
  base_version: 1,
  path: null,
  anchor: null,
  body_md: "feedback",
  author: "jess",
  author_id: "u1",
  state: "open",
  visibility: "public",
  owner_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  meta: null,
  ...over,
})

let store: FakeStore
const rowOf = (id: string) => store.rows.find((r) => r.id === id)
const stateOf = (id: string) => rowOf(id)?.state
const addressedBy = (id: string) => parseMeta(rowOf(id)?.meta ?? null).addressed_by

beforeEach(() => {
  store = new FakeStore()
})

describe("markAddressed", () => {
  it("flips open roots to addressed and tags them with the proposal id", async () => {
    store.rows = [row({ id: "t1" }), row({ id: "t2" })]
    const marked = await markAddressed(store, ART, "p1", ["t1", "t2"])
    expect(marked).toEqual(["t1", "t2"])
    expect(stateOf("t1")).toBe("addressed")
    expect(addressedBy("t1")).toBe("p1")
    expect(addressedBy("t2")).toBe("p1")
  })

  it("skips missing threads, threads on another artifact, and already-resolved threads", async () => {
    store.rows = [
      row({ id: "other", artifact_id: "art2" }), // different artifact
      row({ id: "resolved1", state: "resolved" }), // already settled
      row({ id: "ok" }), // the only addressable one
    ]
    const marked = await markAddressed(store, ART, "p1", ["missing", "other", "resolved1", "ok"])
    expect(marked).toEqual(["ok"])
    expect(stateOf("resolved1")).toBe("resolved") // settled feedback stays settled
    expect(stateOf("ok")).toBe("addressed")
  })

  it("preserves existing meta when adding the tag", async () => {
    store.rows = [row({ id: "t1", meta: JSON.stringify({ reactions: { "👍": ["u2"] } }) })]
    await markAddressed(store, ART, "p1", ["t1"])
    const md = parseMeta(rowOf("t1")?.meta ?? null)
    expect(md.reactions).toEqual({ "👍": ["u2"] })
    expect(md.addressed_by).toBe("p1")
  })
})

describe("releaseAddressed", () => {
  it("resolves the threads a proposal addressed and clears the tag (approve)", async () => {
    store.rows = [row({ id: "t1" }), row({ id: "t2" })]
    await markAddressed(store, ART, "p1", ["t1", "t2"])
    const released = await releaseAddressed(store, ART, "p1", "resolved")
    expect(released.sort()).toEqual(["t1", "t2"])
    expect(stateOf("t1")).toBe("resolved")
    expect(addressedBy("t1")).toBeUndefined()
  })

  it("reopens the threads when a proposal is withdrawn / sent back (open)", async () => {
    store.rows = [row({ id: "t1" })]
    await markAddressed(store, ART, "p1", ["t1"])
    await releaseAddressed(store, ART, "p1", "open")
    expect(stateOf("t1")).toBe("open")
    expect(addressedBy("t1")).toBeUndefined()
  })

  it("only releases threads addressed by THIS proposal", async () => {
    store.rows = [row({ id: "t1" }), row({ id: "t2" })]
    await markAddressed(store, ART, "p1", ["t1"])
    await markAddressed(store, ART, "p2", ["t2"])
    const released = await releaseAddressed(store, ART, "p1", "resolved")
    expect(released).toEqual(["t1"])
    expect(stateOf("t2")).toBe("addressed") // still pending under p2
    expect(addressedBy("t2")).toBe("p2")
  })

  it("is a no-op once nothing is tagged (idempotent)", async () => {
    store.rows = [row({ id: "t1" })]
    await markAddressed(store, ART, "p1", ["t1"])
    await releaseAddressed(store, ART, "p1", "resolved")
    expect(await releaseAddressed(store, ART, "p1", "resolved")).toEqual([])
  })
})
