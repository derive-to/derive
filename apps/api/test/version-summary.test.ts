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
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { SUMMARY_SOURCE_CHARS, type Summarizer, summaryInput } from "../src/summarizer"

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

  it("never reaches an anonymous crawler for a doc it may not read", async () => {
    // The summary carries DOCUMENT CONTENT — a live model output named a person in testing —
    // onto surfaces the title alone used to occupy. It must inherit the title's gate exactly:
    // the SSR route injects meta only for an artifact `readable()` cleared, so an anonymous
    // request for a workspace-only doc gets the bare shell. Pinned because this field makes the
    // consequence of getting that wrong much larger than a leaked title.
    const { summarizer } = fakeSummarizer("Delays the Android build and assigns the copy to Priya.")
    const { app, meta } = makeApp("vs-anon", summarizer)
    const { short_id } = await publish(app, DOC, { title: "Internal", visibility: "org" })
    // It was generated and stored — this is about who may READ it, not whether it exists.
    expect((await summaryOf(meta, short_id)).summary).toContain("Priya")
    const html = await (await app.request(`/artifacts/${short_id}`)).text()
    expect(html).not.toContain("Priya")
    expect(html).not.toContain("og:description")
  })
})

// WHAT THE MODEL IS ACTUALLY SHOWN. Measured rather than assumed: converting a document to
// markdown costs CPU proportional to its PROSE, and uploads are capped at 100MB — 2MB of prose
// measured ~111ms, so an uncapped conversion spends seconds of metered background CPU on every
// publish of a large document to keep 6000 characters of it.

describe("the text handed to the model", () => {
  it("converts only the head, so cost cannot scale with document size", () => {
    // Asserted by CONTENT, not by a stopwatch: prose placed entirely past the cap must be
    // invisible. A timing threshold would pass with the cap removed on any fast machine and
    // flake on a slow one, which is a test that reports the CI box rather than the code.
    const filler = "<!-- padding -->".repeat(Math.ceil((SUMMARY_SOURCE_CHARS + 5_000) / 16))
    // Long enough to clear the length floor on its OWN, or both paths return null for
    // different reasons and the assertion proves nothing about the cap.
    const prose =
      "<p>The billing migration moves to November so the team can finish the invoicing work first and rehearse a rollback.</p>"
    const beyond = `<html><body>${filler}${prose}</body></html>`
    expect(summaryInput(`<html><body>${prose}</body></html>`, "text/html")).not.toBeNull()
    expect(summaryInput(beyond, "text/html")).toBeNull()
    // ...and the same prose within the cap is found, so this is a bound and not a blanket refusal.
    expect(
      summaryInput(
        `<p>The billing migration moves to November so the team can finish the invoicing work first.</p>`,
        "text/html",
      ),
    ).toContain("billing migration")
  })

  it("skips a page that is a screenshot rather than a document", () => {
    // After elision such a page reads as "[elided — 146KB inline image. Re-upload via …]":
    // 140 characters of instructions the HOST wrote for an agent, with not one word about the
    // document. It clears the length floor, so without stripping it first a screenshot page
    // would spend a model call having its own elision notice summarized back at it.
    const img = `<p><img src="data:image/png;base64,${"A".repeat(400)}"></p>`
    expect(summaryInput(img, "text/html")).toBeNull()
  })
})
