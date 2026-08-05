/**
 * THE ONE-LINE DESCRIPTION EVERY UNFURL SURFACE USES.
 *
 * Without it, a shared Derive link describes itself as "Markdown · 3 versions · 7 comments · on
 * Derive" — on the Slack card, in og:description, and so in Twitter, LinkedIn, Discord and
 * iMessage. That answers "what is this?" and never "what is it about?", and an artifact carries
 * no author-written description anywhere to answer it with.
 *
 * These tests are mostly about the ways it must NOT fire: it rides the publish path, so every
 * failure mode has to end in "the publish stood and the card kept its old line" rather than in a
 * failed write or a card that says something worse than nothing.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app"
import type { Summarizer } from "../src/summarizer"

const dir = mkdtempSync(join(tmpdir(), "derive-version-summary-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN = "tok"
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** Long enough to clear SUMMARY_MIN_CHARS — below it the job correctly declines to call. */
const DOC =
  "# Q4 rollout plan\n\nWe are moving the billing migration to November so the team can finish " +
  "the invoicing work first. The cutover needs a maintenance window and a rollback rehearsal.\n"

/** `/artifacts/:ref` injects unfurl meta only when a SPA shell is configured to inject INTO. */
const SHELL =
  "<!doctype html><html><head><title>Derive</title></head><body><div id=root></div></body></html>"

const makeApp = (name: string, summarize?: Summarizer) => {
  const meta = new SqliteMetaStore(join(dir, `${name}.db`))
  const blobs = new FsBlobStore(join(dir, `blobs-${name}`))
  // Node runs `background` inline, so by the time publish returns the summary has been written.
  // That is what makes this observable without polling.
  const app = createApp({
    meta,
    blobs,
    baseUrl: "http://derive.test",
    token: TOKEN,
    shell: SHELL,
    summarize,
  })
  return { app, meta }
}

/** A summarizer that records what it was asked, so a test can assert it was NOT asked. */
const fakeSummarizer = (reply: string | null = "Moves the billing migration to November.") => {
  const calls: { title: string | null; text: string }[] = []
  return {
    calls,
    summarizer: {
      summarize: async (input: { title: string | null; text: string }) => {
        calls.push(input)
        return reply
      },
    } satisfies Summarizer,
  }
}

const publish = async (
  app: ReturnType<typeof createApp>,
  content: string,
  fields: Record<string, string> = {},
  shortId?: string,
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "doc.md")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const res = await app.request(shortId ? `/v1/artifacts/${shortId}/versions` : "/v1/artifacts", {
    method: "POST",
    body: form,
    headers: AUTH,
  })
  expect(res.status).toBeLessThan(300)
  return (await res.json()) as { short_id: string; current_version: number }
}

const summaryOf = async (meta: SqliteMetaStore, shortId: string) => {
  const a = await meta.getByShortId(shortId)
  if (!a) throw new Error("artifact not found")
  const v = await meta.getVersion(a.id, a.current_version)
  return { summary: v?.summary ?? null, hash: v?.summary_src_hash ?? null }
}

describe("generating a version's summary", () => {
  it("writes the model's line to the version it describes", async () => {
    const { calls, summarizer } = fakeSummarizer()
    const { app, meta } = makeApp("vs-basic", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4 rollout" })
    expect((await summaryOf(meta, short_id)).summary).toBe(
      "Moves the billing migration to November.",
    )
    // The model sees READABLE text and the title, not raw source — feeding it the indexed
    // form would summarize tag soup, and not naming the title is how a card ends up saying
    // the same thing twice.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.title).toBe("Q4 rollout")
    expect(calls[0]?.text).toContain("billing migration")
  })

  it("does not ask a model to describe a doc with nothing in it", async () => {
    // A model handed three words hands the title back, which the card already shows above.
    const { calls, summarizer } = fakeSummarizer()
    const { app, meta } = makeApp("vs-tiny", summarizer)
    const { short_id } = await publish(app, "# Hi\n", { title: "Hi" })
    expect(calls).toHaveLength(0)
    expect((await summaryOf(meta, short_id)).summary).toBeNull()
  })

  it("writes nothing when no model is bound, which is how self-host stays unchanged", async () => {
    const { app, meta } = makeApp("vs-none")
    const { short_id } = await publish(app, DOC, { title: "Q4" })
    expect((await summaryOf(meta, short_id)).summary).toBeNull()
  })
})

describe("the ways it must not break a publish", () => {
  it("a model that throws leaves the version published and unsummarized", async () => {
    // The contract every step in this chain shares: a link preview is never worth failing a
    // write that already succeeded.
    const boom: Summarizer = {
      summarize: async () => {
        throw new Error("model exploded")
      },
    }
    const { app, meta } = makeApp("vs-throws", boom)
    const { short_id, current_version } = await publish(app, DOC, { title: "Q4" })
    expect(current_version).toBe(1)
    expect((await summaryOf(meta, short_id)).summary).toBeNull()
    // ...and the artifact is genuinely readable, not half-written.
    const res = await app.request(`/v1/artifacts/${short_id}`, { headers: AUTH })
    expect(res.status).toBe(200)
  })

  it("a model that returns nothing usable writes nothing", async () => {
    const { summarizer } = fakeSummarizer(null)
    const { app, meta } = makeApp("vs-empty", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4" })
    expect((await summaryOf(meta, short_id)).summary).toBeNull()
  })
})

describe("the hash gate — why this is affordable at all", () => {
  it("copies the previous summary forward when the content has not changed", async () => {
    // Agents republish constantly and most publishes do not change what a document is ABOUT.
    // Without this, every one of those pays a model for an identical sentence.
    const { calls, summarizer } = fakeSummarizer()
    const { app, meta } = makeApp("vs-gate", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4" })
    expect(calls).toHaveLength(1)

    await publish(app, DOC, {}, short_id) // byte-identical republish
    expect(calls).toHaveLength(1) // NOT asked again
    const after = await summaryOf(meta, short_id)
    // Carried forward rather than left null, so v2's card reads exactly as v1's did.
    expect(after.summary).toBe("Moves the billing migration to November.")
    expect(after.hash).toBeTruthy()
  })

  it("asks again when the content actually changed", async () => {
    const { calls, summarizer } = fakeSummarizer()
    const { app } = makeApp("vs-gate-changed", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4" })
    await publish(
      app,
      `${DOC}\n\nThe rollback rehearsal is now scheduled for the 12th.\n`,
      {},
      short_id,
    )
    expect(calls).toHaveLength(2)
  })
})

describe("sanitizing what a model returns", () => {
  // The summary is derived from document content, so on any workspace taking contributions it
  // is attacker-influenced. It reaches SVG markup, an HTML attribute, and Slack mrkdwn. Those
  // escape — but the guarantee has to travel with the value, because the next surface to read
  // this field inherits whatever is promised here and not what its predecessors remembered.
  it("strips markup characters at the source, before any surface sees them", async () => {
    const { summarizer } = fakeSummarizer('A plan <script>alert(1)</script> & "quoted" text')
    const { app, meta } = makeApp("vs-sanitize", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4" })
    const { summary } = await summaryOf(meta, short_id)
    expect(summary).not.toContain("<")
    expect(summary).not.toContain(">")
    expect(summary).not.toContain("&")
    expect(summary).toContain("A plan")
  })

  it("flattens a model that answers with a bulleted list", async () => {
    const { summarizer } = fakeSummarizer("Summary:\n- moves billing\n- needs a window\n")
    const { app, meta } = makeApp("vs-flatten", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4" })
    const { summary } = await summaryOf(meta, short_id)
    expect(summary).not.toContain("\n")
    // The preamble goes too — "Summary:" on a card is a wasted line.
    expect(summary?.toLowerCase().startsWith("summary:")).toBe(false)
  })

  it("clamps a runaway answer at a word boundary", async () => {
    const { summarizer } = fakeSummarizer(`${"word ".repeat(200)}end`)
    const { app, meta } = makeApp("vs-clamp", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4" })
    const { summary } = await summaryOf(meta, short_id)
    expect(summary?.length).toBeLessThanOrEqual(201) // 200 + the ellipsis
    expect(summary?.endsWith("…")).toBe(true)
  })
})

describe("what the surfaces then show", () => {
  it("og:description carries the summary, escaped", async () => {
    const { summarizer } = fakeSummarizer("Moves the billing migration to November.")
    const { app } = makeApp("vs-og", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4", visibility: "public" })
    // A bare short id 302s to the canonical name-first URL; the injected meta lives there.
    const bare = await app.request(`/artifacts/${short_id}`, { headers: AUTH })
    expect(bare.status).toBe(302)
    const html = await (await app.request(bare.headers.get("location") ?? "")).text()
    expect(html).toContain("Moves the billing migration to November.")
    // The inventory line it replaced is gone from the description.
    expect(html).not.toMatch(/og:description[^>]*1 version/)
  })

  it("the OG card image keeps the inventory line, which is what it has room for", async () => {
    // The card draws its description as one unwrapped 28px line sized for ~50 characters; a
    // 200-character summary would run off the canvas. The reader gets it via og:description.
    const { summarizer } = fakeSummarizer("Moves the billing migration to November.")
    const { app } = makeApp("vs-ogimg", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Q4", visibility: "public" })
    const svg = await (await app.request(`/v1/og/${short_id}`)).text()
    expect(svg).not.toContain("<image")
    expect(svg).toContain("<svg")
    expect(svg).not.toContain("Moves the billing migration")
    expect(svg).toContain("version")
  })
})
