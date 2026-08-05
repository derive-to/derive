/**
 * THE ONE-TIME SWEEP for artifacts published before summaries existed.
 *
 * Publishing keeps them current going forward, so this closes a gap that shrinks on its own —
 * which is exactly why it must be cheap to re-run and impossible to wedge. The tests are mostly
 * about those two properties rather than about generation, which the publish path already owns.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { backfillSummaryBatch } from "../src/lib/summary-backfill"
import type { Summarizer } from "../src/summarizer"

const dir = mkdtempSync(join(tmpdir(), "derive-summary-backfill-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN = "tok"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const DOC =
  "# Q4 rollout plan\n\nWe are moving the billing migration to November so the team can finish " +
  "the invoicing work first. The cutover needs a maintenance window and a rollback rehearsal.\n"

const counting = (reply: string | null = "Moves the billing migration to November.") => {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    summarizer: {
      summarize: async () => {
        calls++
        return reply
      },
    } satisfies Summarizer,
  }
}

/** An app with NO summarizer, so publishing leaves the corpus exactly as it was before the
 *  feature — which is the state a backfill exists to find. */
const legacyApp = (name: string) => {
  const meta = new SqliteMetaStore(join(dir, `${name}.db`))
  const blobs = new FsBlobStore(join(dir, `blobs-${name}`))
  return {
    meta,
    blobs,
    app: createApp({ meta, blobs, baseUrl: "http://derive.test", token: TOKEN }),
  }
}

const publish = async (app: ReturnType<typeof createApp>, title: string, content = DOC) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "doc.md")
  form.append("title", title)
  const res = await app.request("/v1/artifacts", { method: "POST", body: form, headers: AUTH })
  expect(res.status).toBeLessThan(300)
  return (await res.json()) as { short_id: string }
}

const summaryOf = async (meta: SqliteMetaStore, shortId: string) => {
  const a = await meta.getByShortId(shortId)
  if (!a) throw new Error("not found")
  return (await meta.getVersion(a.id, a.current_version))?.summary ?? null
}

describe("backfilling a corpus that predates summaries", () => {
  it("describes artifacts the publish path never saw", async () => {
    const { app, meta, blobs } = legacyApp("bf-basic")
    const one = await publish(app, "One")
    const two = await publish(app, "Two")
    const ids = [one, two]
    expect(await summaryOf(meta, one.short_id)).toBeNull()

    // NOT destructured: object spread EVALUATES the `calls` getter, so `{...counting()}` would
    // capture a snapshot of zero and the assertion would pass for the wrong reason.
    const spy = counting()
    const r = await backfillSummaryBatch({ meta, blobs, summarize: spy.summarizer }, { limit: 25 })
    expect(r.scanned).toBe(2)
    expect(r.attempted).toBe(2)
    expect(spy.calls).toBe(2)
    for (const i of ids)
      expect(await summaryOf(meta, i.short_id)).toBe("Moves the billing migration to November.")
  })

  it("costs a read, not a model call, for anything already described", async () => {
    // What makes a partial sweep resumable from cursor 0 instead of needing its progress tracked.
    const { app, meta, blobs } = legacyApp("bf-idempotent")
    await publish(app, "One")
    const first = counting()
    await backfillSummaryBatch({ meta, blobs, summarize: first.summarizer }, { limit: 25 })
    expect(first.calls).toBe(1)

    const second = counting()
    const r = await backfillSummaryBatch(
      { meta, blobs, summarize: second.summarizer },
      { limit: 25 },
    )
    expect(second.calls).toBe(0)
    expect(r.alreadyHad).toBe(1)
    expect(r.attempted).toBe(0)
  })

  it("keeps walking when one artifact's model call fails", async () => {
    // The sweep is the only driver, so an isolated failure must not wedge the operator's cursor
    // — unlike the publish path, nothing else will come along and retry this row.
    const { app, meta, blobs } = legacyApp("bf-partial")
    await publish(app, "One")
    await publish(app, "Two")
    let n = 0
    const flaky: Summarizer = {
      summarize: async () => {
        n++
        if (n === 1) throw new Error("model exploded")
        return "A second artifact."
      },
    }
    const r = await backfillSummaryBatch({ meta, blobs, summarize: flaky }, { limit: 25 })
    expect(r.scanned).toBe(2)
    expect(r.attempted).toBe(2)
    // One landed; the other is simply still null and will be picked up by a re-sweep.
    const got = await Promise.all(
      (await meta.listArtifacts({ limit: 10 })).map((a) =>
        meta.getVersion(a.id, a.current_version).then((v) => v?.summary ?? null),
      ),
    )
    expect(got.filter(Boolean)).toHaveLength(1)
  })

  it("pages, and reports a null cursor when the walk is done", async () => {
    const { app, meta, blobs } = legacyApp("bf-pages")
    for (const t of ["One", "Two", "Three"]) await publish(app, t)
    const { summarizer } = counting()
    const p1 = await backfillSummaryBatch({ meta, blobs, summarize: summarizer }, { limit: 2 })
    expect(p1.scanned).toBe(2)
    expect(p1.nextCursor).not.toBeNull()
    const p2 = await backfillSummaryBatch(
      { meta, blobs, summarize: summarizer },
      { limit: 2, cursor: p1.nextCursor ?? undefined },
    )
    expect(p2.scanned).toBe(1)
    expect(p2.nextCursor).toBeNull()
  })
})

describe("the operator endpoint", () => {
  const withSummarizer = (name: string, summarize: Summarizer) => {
    const meta = new SqliteMetaStore(join(dir, `${name}.db`))
    const blobs = new FsBlobStore(join(dir, `blobs-${name}`))
    return {
      meta,
      app: createApp({ meta, blobs, baseUrl: "http://derive.test", token: TOKEN, summarize }),
    }
  }

  it("refuses without operator credentials", async () => {
    const { app } = withSummarizer("bf-authz", counting().summarizer)
    const res = await app.request("/v1/system/summary-backfill", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(403)
  })

  it("says so plainly when no model is bound, rather than reporting an empty sweep", async () => {
    // A 200 with "0 attempted" on a deploy that can never summarize anything reads like an empty
    // corpus — the operator would conclude the backfill had nothing to do and move on.
    const { app } = legacyApp("bf-nomodel")
    const res = await app.request("/v1/system/summary-backfill", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { ...AUTH, "content-type": "application/json" },
    })
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).toContain("AI binding")
  })

  it("runs a page and reports what it did", async () => {
    const { app, meta } = withSummarizer("bf-endpoint", counting().summarizer)
    // Published WITH a summarizer bound, so these already have summaries — the realistic state
    // of a corpus after the feature shipped, where a backfill should report zero work.
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode(DOC)]), "doc.md")
    form.append("title", "Live")
    await app.request("/v1/artifacts", { method: "POST", body: form, headers: AUTH })

    const res = await app.request("/v1/system/summary-backfill", {
      method: "POST",
      body: JSON.stringify({ limit: 5 }),
      headers: { ...AUTH, "content-type": "application/json" },
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { scanned: number; alreadyHad: number; attempted: number }
    expect(out.scanned).toBe(1)
    expect(out.alreadyHad).toBe(1)
    expect(out.attempted).toBe(0)
    expect(await meta.getByShortId("nope")).toBeNull()
  })
})
