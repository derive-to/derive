import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ArtifactRecord,
  newId,
  type SessionMessageRecord,
  type SessionRecord,
} from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createInProcessBackplane } from "../src/bus"
import { TruncatedReplyError } from "../src/lib/model-openai"
import { runSessionTurn, type TurnDeps } from "../src/lib/session-turn"

// THE TURN — "chat with a derive", the whole attended path.
//
// Tested against a real store and a real blob store with only the MODEL faked, because the
// interesting behavior is what the turn does with what the model said: whether it writes at
// all, what a blocked write surfaces, and what happens when a human publishes underneath it.
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
  billingBlocked: async () => null,
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
      onBehalf: ED,
    })
    expect(res.outcome).toBe("answered")
    expect(res.wrote).toBeNull()
    expect(res.reply).toContain("three paragraphs")
    expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
  })
})

describe("a turn that edits", () => {
  it("publishes a VERSION — an agent's edit lands like a person's", async () => {
    const { meta, blobs, artifact } = await setup()
    const res = await runSessionTurn(deps(meta, blobs, revision()), {
      session: session(),
      subject: { kind: "artifact", id: "doc1" },
      artifact,
      transcript: transcript("make it shorter"),
      onBehalf: ED,
    })
    expect(res.outcome).toBe("published")
    expect(res.wrote).toEqual({ kind: "version", n: 2 })
    const v = await meta.getVersion("a1", 2)
    expect(new TextDecoder().decode((await blobs.get(v?.blob_key ?? "")) ?? undefined)).toBe(
      "# New",
    )
  })
})

describe("a blocked write surfaces its draft instead of landing", () => {
  const cases = [
    {
      block: "switch" as const,
      names: /agent writes switched off/,
      why: "the workspace turned agent writes off — zero live versions, the draft surfaces",
    },
    {
      block: "locked" as const,
      names: /locked/,
      why: "the document is locked — the agent path is not a side door around the lock",
    },
    {
      block: "role" as const,
      names: /can comment on this document but not publish/,
      why: "the asker cannot publish here — no agent gets more power than its person",
    },
  ]
  for (const c of cases) {
    it(c.why, async () => {
      const { meta, blobs, artifact } = await setup()
      const res = await runSessionTurn(deps(meta, blobs, revision()), {
        session: session(),
        subject: { kind: "artifact", id: "doc1" },
        artifact,
        transcript: transcript("make it shorter"),
        writeBlock: c.block,
        onBehalf: ED,
      })
      expect(res.outcome).toBe("commented")
      expect(res.wrote).toBeNull()
      // The draft is never lost: it rides the reply, with the real reason named.
      expect(res.reply).toContain("# New")
      expect(res.reply).toMatch(c.names)
      expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
    })
  }
})

describe("a human publishes while the model is thinking", () => {
  it("SURFACES the draft instead of clobbering their version", async () => {
    // The optimistic-concurrency case. The turn read v1; a person published v2 mid-flight.
    // Their write is the one a person just made, so the model's answer surfaces as a
    // suggestion in the reply rather than overwriting it.
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
      subject: { kind: "artifact", id: "doc1" },
      artifact,
      transcript: transcript("make it shorter"),
      onBehalf: ED,
    })
    expect(res.outcome).toBe("commented")
    expect(res.reply).toContain("published a new version while I was working")
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
        onBehalf: ED,
      },
    )
    expect(res.outcome).toBe("failed")
    expect(res.wrote).toBeNull()
    expect(res.reply).not.toBe("")
    expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
  })
})

describe("an edit never changes the document's format", () => {
  it("keeps text/markdown even when the model returns an .html filename", async () => {
    // The bug this prevents, seen in a real run: the model omitted a filename, parseRevision
    // fell back to `index.html` (correct when CREATING, wrong when editing), and a Markdown
    // document was silently republished as HTML — rendering as raw unformatted text with no
    // error anywhere. The format belongs to the document, not to the model.
    const { meta, blobs, artifact } = await setup()
    const html = `<revision>${JSON.stringify({ content: "# Still markdown", filename: "index.html", confidence: 0.95, message: "m" })}</revision>`
    const res = await runSessionTurn(deps(meta, blobs, html), {
      session: session(),
      subject: { kind: "artifact", id: "doc1" },
      artifact,
      transcript: transcript("make it shorter"),
      onBehalf: ED,
    })
    expect(res.outcome).toBe("published")
    expect((await meta.getVersion("a1", 2))?.content_type).toBe("text/markdown")
  })
})

describe("a reply cut off mid-flight", () => {
  it("writes nothing, and suggests something that can actually work", async () => {
    // Reachable now only for a SMALL document — anything large takes the edits contract and is
    // never asked for a whole-document reply. So "ask for a smaller change" is honest advice
    // here in a way it was not when it meant a 53KB page: on a small document a smaller change
    // genuinely does fit.
    const { meta, blobs, artifact } = await setup()
    const res = await runSessionTurn(
      deps(meta, blobs, async () => {
        throw new TruncatedReplyError()
      }),
      {
        session: session(),
        subject: { kind: "artifact", id: "doc1" },
        artifact,
        transcript: transcript("add a glossary"),
        onBehalf: ED,
      },
    )
    expect(res.outcome).toBe("failed")
    expect(res.wrote).toBeNull()
    expect(res.reply).toMatch(/cut off/i)
    // A truncated reply must never be treated as content.
    expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
  })
})

describe("a document too large for a whole-document reply uses EDITS", () => {
  // Anything over EDITS_THRESHOLD_CHARS. The point of the contract switch is that the reply is
  // bounded by the CHANGE, so the same one-line edit works on a document of any size.
  const big = `# Big\n\n${"filler paragraph that makes this document long. ".repeat(400)}\n\n## Risks\n\nOne risk.\n`
  const editsBlock = (edits: unknown, message = "m") =>
    `<edits>${JSON.stringify({ edits, confidence: 0.95, message })}</edits>`

  it("applies a search/replace and publishes the result", async () => {
    const { meta, blobs, artifact } = await setup({ source: big })
    const res = await runSessionTurn(
      deps(
        meta,
        blobs,
        editsBlock([
          { old_str: "## Risks\n\nOne risk.", new_str: "## Risks\n\nOne risk.\nA second risk." },
        ]),
      ),
      {
        session: session(),
        subject: { kind: "artifact", id: "doc1" },
        artifact,
        transcript: transcript("add a second risk"),
        onBehalf: ED,
      },
    )
    expect(res.outcome).toBe("published")
    const v = await meta.getVersion("a1", 2)
    const text = new TextDecoder().decode((await blobs.get(v?.blob_key ?? "")) ?? undefined)
    expect(text).toContain("A second risk.")
    // The rest of the document survived — an edit is not a rewrite.
    expect(text.length).toBeGreaterThan(big.length - 10)
  })

  it("writes NOTHING when an anchor does not match, even partially", async () => {
    // applyEdits is all-or-nothing. A model that gets one anchor right and one wrong must not
    // leave a half-applied document behind.
    const { meta, blobs, artifact } = await setup({ source: big })
    const res = await runSessionTurn(
      deps(
        meta,
        blobs,
        editsBlock([
          { old_str: "## Risks\n\nOne risk.", new_str: "## Risks\n\nChanged." },
          { old_str: "TEXT THAT IS NOT IN THE DOCUMENT", new_str: "x" },
        ]),
      ),
      {
        session: session(),
        subject: { kind: "artifact", id: "doc1" },
        artifact,
        transcript: transcript("two changes"),
        onBehalf: ED,
      },
    )
    expect(res.outcome).toBe("failed")
    expect(res.wrote).toBeNull()
    expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
    // The reply carries applyEdits' diagnostic rather than a shrug.
    expect(res.reply).toMatch(/not found|could not apply/i)
  })

  it("RETRIES a miss with the diagnostic, and succeeds on the second attempt", async () => {
    // The reason a miss is worth retrying at all: the diagnostic says WHY it missed, so the
    // model can correct the anchor rather than guess again.
    const { meta, blobs, artifact } = await setup({ source: big })
    let call = 0
    const flaky: TurnDeps = {
      ...deps(meta, blobs, ""),
      callModel: async () => {
        call += 1
        return {
          text:
            call === 1
              ? editsBlock([{ old_str: "NOT PRESENT ANYWHERE", new_str: "x" }])
              : editsBlock([{ old_str: "One risk.", new_str: "One risk. And another." }]),
          toolUses: [],
          costUsd: null,
          done: true,
        }
      },
    }
    const res = await runSessionTurn(flaky, {
      session: session(),
      subject: { kind: "artifact", id: "doc1" },
      artifact,
      transcript: transcript("add a risk"),
      onBehalf: ED,
    })
    expect(call).toBe(2)
    expect(res.outcome).toBe("published")
  })

  it("still answers a QUESTION about a large document without editing it", async () => {
    const { meta, blobs, artifact } = await setup({ source: big })
    const res = await runSessionTurn(deps(meta, blobs, "It is about 400 paragraphs long."), {
      session: session(),
      subject: { kind: "artifact", id: "doc1" },
      artifact,
      transcript: transcript("how long is it?"),
      onBehalf: ED,
    })
    expect(res.outcome).toBe("answered")
    expect((await meta.getArtifactById("a1"))?.current_version).toBe(1)
  })
})

describe("what filename attended chat SHOWS the model", () => {
  // The same upstream bug the run lane had: the prompt named the document by bare short_id
  // ("doc1"), which carries no format signal, so a model asked to name its output guessed and
  // the edits contract's fallback made that guess index.html. Correcting the content type on
  // the way out does not cover this — a model that believes it is editing an extensionless file
  // will also write HTML into a Markdown document's BODY.
  it("names a markdown document doc1.md in the prompt", async () => {
    const { meta, blobs, artifact } = await setup()
    let system = ""
    const d = deps(meta, blobs, revision())
    const spy: typeof d = {
      ...d,
      callModel: async (input) => {
        system = input.system ?? ""
        return { text: revision(), toolUses: [], costUsd: null, done: true }
      },
    }
    await runSessionTurn(spy, {
      session: session(),
      subject: { kind: "artifact", id: "doc1" },
      artifact,
      transcript: transcript("tighten the intro"),
      onBehalf: ED,
    })
    expect(system).toContain("its filename is doc1.md")
  })
})
