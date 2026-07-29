import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ArtifactRecord,
  newId,
  parseSubject,
  type SessionMessageRecord,
  type SessionRecord,
} from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createInProcessBackplane } from "../src/bus"
import { runSessionTurn, type TurnDeps } from "../src/lib/session-turn"

// THE TURN — "chat with a derive", the whole attended path.
//
// Tested against a real store and a real blob store with only the MODEL faked, because the
// interesting behavior is what the turn does with what the model said: whether it writes at
// all, whether the gate demotes it, and what happens when a human publishes underneath it.
// A mocked store would test the mock.

const setup = async (opts?: { source?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "turn-"))
  const meta = new SqliteMetaStore(join(dir, "db.sqlite"))
  const blobs = new FsBlobStore(join(dir, "blobs"))
  await meta.createArtifact({
    id: "a1",
    short_id: "doc1",
    org_id: "default",
    slug: null,
    title: "Doc",
    workspace_access: "member",
    link_role: "viewer",
    listed: "workspace",
    kind: "file",
    spa: 0,
  })
  const key = await blobs.put(new TextEncoder().encode(opts?.source ?? "# Original\n"))
  await meta.addVersion("a1", {
    id: newId("v"),
    blob_key: key,
    content_type: "text/markdown",
    size_bytes: 11,
    author: "Ed",
    author_id: "u-ed",
    source: "web",
    message: "first",
    name: null,
  })
  const fresh = (await meta.getArtifactById("a1")) as ArtifactRecord
  return { dir, meta, blobs, artifact: fresh }
}

/** Deps with a scripted model. `notify`/`background` are the no-op edges — this test is
 *  about the write decision, and after-publish fan-out has its own suite. */
const deps = (
  meta: SqliteMetaStore,
  blobs: FsBlobStore,
  reply: string | (() => Promise<never>),
): TurnDeps => ({
  meta,
  blobs,
  bus: createInProcessBackplane(),
  notify: async () => {},
  notifyRender: () => {},
  background: async () => {},
  search: undefined,
  callModel: async () => {
    if (typeof reply !== "string") return reply()
    return { text: reply, toolUses: [], costUsd: null, done: true }
  },
})

const session = (): SessionRecord =>
  ({
    id: "ses1",
    context_id: "cx1",
    org_id: "default",
    asker_id: "u-ed",
    context_version: 1,
    state: "open",
    created_at: new Date().toISOString(),
    updated_at: null,
    started_at: null,
    lease_until: null,
    result_artifact_id: null,
    dedupe_key: null,
    subject_ref: JSON.stringify({ kind: "artifact", id: "doc1" }),
  }) as SessionRecord

const transcript = (text: string): SessionMessageRecord[] => [
  {
    id: "sm1",
    session_id: "ses1",
    author_kind: "asker",
    author_id: "u-ed",
    body_md: text,
    meta: null,
    created_at: new Date().toISOString(),
  } as SessionMessageRecord,
]

const revision = (content = "# New", confidence: number | null = 0.95) =>
  `<revision>${JSON.stringify({ content, filename: "doc.md", confidence, message: "shortened it" })}</revision>`

const FLAGS = { agentKillswitch: false, agentAutoEnabled: true }
const ED = { id: "u-ed", name: "Ed" }

describe("a turn that is not an edit", () => {
  it("ANSWERS in prose without touching the document", async () => {
    // The difference from an unattended run, and the reason chat needed its own path: a
    // reply with no revision block is a perfectly good answer to a question, not a failure
    // to follow the contract. Nothing is written and nothing is nudged.
    const { meta, blobs, artifact } = await setup()
    const res = await runSessionTurn(deps(meta, blobs, "It is about three paragraphs long."), {
      session: session(),
      subject: { kind: "artifact", id: "doc1" },
      artifact,
      transcript: transcript("how long is this doc?"),
      flags: FLAGS,
      onBehalf: ED,
    })
    expect(res.outcome).toBe("answered")
    expect(res.wrote).toBeNull()
    expect(res.reply).toContain("three paragraphs")
    expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
  })
})

describe("a turn that edits", () => {
  it("publishes a VERSION when the subject says publish", async () => {
    const { meta, blobs, artifact } = await setup()
    const res = await runSessionTurn(deps(meta, blobs, revision()), {
      session: session(),
      subject: { kind: "artifact", id: "doc1", mode: "publish" },
      artifact,
      transcript: transcript("make it shorter"),
      flags: FLAGS,
      onBehalf: ED,
    })
    expect(res.outcome).toBe("published")
    expect(res.wrote).toEqual({ kind: "version", n: 2 })
    const v = await meta.getVersion("a1", 2)
    expect(new TextDecoder().decode((await blobs.get(v?.blob_key ?? "")) ?? undefined)).toBe(
      "# New",
    )
  })

  it("files a PROPOSAL when the subject does not say publish", async () => {
    // Propose is the default on a selector, so the quiet path is the safe one.
    const { meta, blobs, artifact } = await setup()
    const res = await runSessionTurn(deps(meta, blobs, revision()), {
      session: session(),
      subject: { kind: "artifact", id: "doc1" },
      artifact,
      transcript: transcript("make it shorter"),
      flags: FLAGS,
      onBehalf: ED,
    })
    expect(res.outcome).toBe("proposed")
    expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
    expect((await meta.listProposals("a1")).length).toBe(1)
  })

  it("the KILLSWITCH demotes a publish to a proposal", async () => {
    const { meta, blobs, artifact } = await setup()
    const res = await runSessionTurn(deps(meta, blobs, revision()), {
      session: session(),
      subject: { kind: "artifact", id: "doc1", mode: "publish" },
      artifact,
      transcript: transcript("make it shorter"),
      flags: { agentKillswitch: true, agentAutoEnabled: true },
      onBehalf: ED,
    })
    expect(res.outcome).toBe("proposed")
  })

  it("an UNSTATED confidence never publishes live", async () => {
    const { meta, blobs, artifact } = await setup()
    const res = await runSessionTurn(deps(meta, blobs, revision("# New", null)), {
      session: session(),
      subject: { kind: "artifact", id: "doc1", mode: "publish" },
      artifact,
      transcript: transcript("make it shorter"),
      flags: FLAGS,
      onBehalf: ED,
    })
    expect(res.outcome).toBe("proposed")
  })
})

describe("a human publishes while the model is thinking", () => {
  it("DEMOTES to a proposal instead of clobbering their version", async () => {
    // The optimistic-concurrency case. The turn read v1; a person published v2 mid-flight.
    // Their write was reviewed by a human and the model's was not, so the model's answer
    // becomes a proposal against what they wrote rather than overwriting it.
    const { meta, blobs, artifact } = await setup()
    const racing: TurnDeps = {
      ...deps(meta, blobs, revision()),
      callModel: async () => {
        const key = await blobs.put(new TextEncoder().encode("# Human edit"))
        await meta.addVersion("a1", {
          id: newId("v"),
          blob_key: key,
          content_type: "text/markdown",
          size_bytes: 12,
          author: "Ed",
          author_id: "u-ed",
          source: "web",
          message: "human",
          name: null,
        })
        return { text: revision(), toolUses: [], costUsd: null, done: true }
      },
    }
    const res = await runSessionTurn(racing, {
      session: session(),
      subject: { kind: "artifact", id: "doc1", mode: "publish" },
      artifact,
      transcript: transcript("make it shorter"),
      flags: FLAGS,
      onBehalf: ED,
    })
    expect(res.outcome).toBe("proposed")
    expect(res.reply).toContain("published while I was working")
    // The human's version is still current — the turn did NOT overwrite it.
    const now = await meta.getArtifactById("a1")
    expect(now?.current_version).toBe(2)
    const v2 = await meta.getVersion("a1", 2)
    expect(new TextDecoder().decode((await blobs.get(v2?.blob_key ?? "")) ?? undefined)).toBe(
      "# Human edit",
    )
  })
})

describe("failures still answer the person sitting there", () => {
  it("a dead model returns a reply and writes nothing", async () => {
    const { meta, blobs, artifact } = await setup()
    const res = await runSessionTurn(
      deps(meta, blobs, async () => {
        throw new Error("429 slow down")
      }),
      {
        session: session(),
        subject: { kind: "artifact", id: "doc1" },
        artifact,
        transcript: transcript("make it shorter"),
        flags: FLAGS,
        onBehalf: ED,
      },
    )
    expect(res.outcome).toBe("failed")
    expect(res.wrote).toBeNull()
    expect(res.reply).not.toBe("")
    expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
  })
})

describe("the stored subject", () => {
  it("round-trips through the column, and a corrupt one degrades to a plain ask", async () => {
    expect(parseSubject(JSON.stringify({ kind: "artifact", id: "doc1", mode: "publish" }))).toEqual(
      {
        kind: "artifact",
        id: "doc1",
        mode: "publish",
      },
    )
    // A bare short_id is the ergonomic shorthand everywhere a selector is accepted.
    expect(parseSubject(JSON.stringify("doc1"))).toEqual({ kind: "artifact", id: "doc1" })
    // Unparseable and absent both read as "no subject" — a corrupt column must degrade a
    // session to a plain ask, never wedge it.
    expect(parseSubject("{not json")).toBeNull()
    expect(parseSubject(null)).toBeNull()
  })
})
