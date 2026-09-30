import { type BlobStore, tarSync } from "@derive/core"
import { gzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { runImportTick } from "../src/imports"
import { ARXIV_REQUEST_INTERVAL_MS } from "../src/lib/arxiv-import"
import { browserFigureShrinker, type ShrinkPage } from "../src/lib/image-shrink-cf"
import { sharpShrinker } from "../src/lib/image-shrink-node"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Papers imported from arXiv: the paste, the background worker that fetches the paper into a
// locked, read-only Context, the implementation repository beside it, and its analysis.
describe("paper imports from arXiv", () => {
  const owner: TestUser = { id: "u_ax_own", email: "axown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_ax_mem", email: "axmem@derive.test", name: "Member" }
  const ID = "2401.12345"
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x1f, 0x8b,
  ])
  const ATOM = (
    id: string,
    title = "Attention Is All You Need",
  ) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/${id}v2</id>
    <published>2024-01-30T18:00:00Z</published>
    <title>${title}</title>
    <summary>  We propose a new simple network architecture, the Transformer &amp; friends.
  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:comment>15 pages, 5 figures</arxiv:comment>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/><category term="cs.LG"/>
  </entry>
</feed>`
  const ERROR_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title><summary>Bad id</summary></entry></feed>`
  const BIBTEX = `@misc{vaswani2024attention,
      title={Attention Is All You Need},
      author={Ashish Vaswani and Noam Shazeer},
      year={2024},
      eprint={${ID}},
      archivePrefix={arXiv},
      primaryClass={cs.CL}
}`
  const SOURCE = () =>
    gzipSync(
      tarSync({
        "paper-src/paper.tex":
          "\\documentclass{article}\n\\begin{document}\n\\begin{abstract}\nWe propose a new simple network architecture.\n\\end{abstract}\n\\input{main}\n\\section{Intro}\nSee \\cite{ref1}.\n\\bibliography{refs}\n\\end{document}\n",
        "paper-src/main.tex": "A chapter, not the paper.",
        "paper-src/refs.bib": "@article{ref1, title={Ref}, author={A}, year={2020}}",
        "paper-src/paper.bbl":
          "\\begin{thebibliography}{1}\\bibitem{ref1} A. Ref. 2020.\\end{thebibliography}",
        "paper-src/fig/a.png": PNG,
      }),
    )

  type Stub = (url: string, init?: RequestInit) => Response | Promise<Response>
  const gzip = (bytes: Uint8Array) =>
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "application/gzip" },
    })
  const arxivStub = (
    over: Partial<Record<"metadata" | "source" | "bibtex", Stub>> = {},
    /** Repository archives by `owner/name`, for an import that attaches an implementation. */
    repos: Record<string, () => Response | Promise<Response>> = {},
  ) => {
    const calls: string[] = []
    const stub = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      const u = new URL(url)
      if (u.hostname === "export.arxiv.org")
        return over.metadata?.(url, init) ?? new Response(ATOM(u.searchParams.get("id_list") ?? ID))
      if (u.pathname.startsWith("/src/")) return over.source?.(url, init) ?? gzip(SOURCE())
      if (u.pathname.startsWith("/bibtex/")) return over.bibtex?.(url, init) ?? new Response(BIBTEX)
      // codeload: /<owner>/<name>/tar.gz/<ref>. GitLab: /<ns>/<name>/-/archive/<ref>/….
      const repo = /^\/([^/]+)\/([^/]+)\/(?:tar\.gz|-\/archive)\//.exec(u.pathname)
      if (repo) {
        const served = repos[`${repo[1]}/${repo[2]}`]
        if (served) return served()
      }
      return new Response("nope", { status: 404 })
    }
    return { fetch: stub as unknown as typeof fetch, calls }
  }

  /** A clock that advances only through the worker's own sleeps. */
  const clock = () => {
    let t = Date.parse("2030-01-01T00:00:00.000Z")
    const sleeps: number[] = []
    return {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        t += ms
      },
      sleeps,
      advance: (ms: number) => {
        t += ms
      },
    }
  }

  const setup = (name: string, fetchStub: typeof fetch) => {
    const made = makeAuthedApp(name, [owner, member], "editor", { deps: { fetch: fetchStub } })
    const c = clock()
    const tickDeps = (holder = "w1") => ({
      meta: made.meta,
      blobs: made.ctx.blobs,
      bus: made.ctx.bus,
      notify: made.ctx.notify,
      background: made.ctx.background,
      baseUrl: "http://derive.test",
      fetch: fetchStub,
      now: c.now,
      sleep: c.sleep,
      caps: {
        compressedBytes: 1024 * 1024,
        inflatedBytes: 4 * 1024 * 1024,
        bundleBytes: 4 * 1024 * 1024,
        files: 200,
      },
      repoCaps: {
        compressedBytes: 1024 * 1024,
        inflatedBytes: 4 * 1024 * 1024,
        totalBytes: 4 * 1024 * 1024,
        files: 200,
        depth: 3,
        repos: 5,
      },
      holder,
    })
    return { ...made, clock: c, tickDeps }
  }
  const importPaper = (app: ReturnType<typeof makeAuthedApp>["app"], url: string, who = owner) =>
    app.request("/v1/contexts/import/arxiv", jsonAs(as(who.email), { url }))

  it("queues a paper the moment it is pasted, then the worker turns it into a locked, read-only Context", async () => {
    const stub = arxivStub()
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(member.email) })

    // Any of the forms people paste resolves to the id; the PDF link is the common one.
    const res = await importPaper(app, `https://arxiv.org/pdf/${ID}v2.pdf`)
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created).toMatchObject({
      name: `arXiv:${ID}`,
      ask_policy: "workspace",
      import: { source: "arxiv", ref: ID, status: "pending", error: null, imported_by: owner.id },
    })
    expect(created.import.url).toBe(`https://arxiv.org/abs/${ID}`)
    // Listed at once, for every member, marked as on its way.
    const listed = await (await app.request("/v1/contexts", { headers: as(member.email) })).json()
    expect(listed.contexts.map((x: { id: string }) => x.id)).toContain(created.id)
    expect(listed.contexts[0].import.status).toBe("pending")
    // One artifact from the first second: the Context points at the paper, whose first
    // version is a placeholder document saying the fetch is on its way. A member can open
    // it (workspace policy) and reads it as a page, never as source.
    const before = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(member.email) })
    ).json()
    expect(before.manifest).toBeNull()
    expect(before.documents).toEqual([
      { short_id: before.manifest_short_id, title: `arXiv:${ID}`, kind: "bundle", role: "paper" },
    ])
    const fetching = await app.request(
      `/v1/artifacts/${before.manifest_short_id}/content?format=text`,
      { headers: as(member.email) },
    )
    expect(await fetching.text()).toContain("Fetching this paper from arXiv")
    // Nothing has been fetched yet: the queue, not the request, talks to arXiv.
    expect(stub.calls).toHaveLength(0)

    expect(await runImportTick(tickDeps())).toBe(1)
    // Three requests, in order, each at least the interval apart.
    expect(stub.calls.map((u) => new URL(u).pathname)).toEqual([
      "/api/query",
      `/src/${ID}v2`,
      `/bibtex/${ID}`,
    ])
    expect(c.sleeps.filter((ms) => ms >= 3000).length).toBeGreaterThanOrEqual(2)
    for (const url of stub.calls) expect(new URL(url).hostname).toMatch(/arxiv\.org$/)

    const after = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(member.email) })
    ).json()
    expect(after.name).toBe("Attention Is All You Need")
    expect(after.import).toMatchObject({ status: "ready", version: 2, error: null })
    // Still one artifact, now the paper: the same short id the queue created.
    expect(after.documents).toEqual([
      {
        short_id: before.manifest_short_id,
        title: "Attention Is All You Need",
        kind: "bundle",
        role: "paper",
      },
    ])
    expect(after.manifest).toBeNull()
    expect(after.bibtex).toContain("@misc{vaswani2024attention")
    expect(after.description).toContain("Ashish Vaswani")

    // The paper: a LaTeX bundle entering at the real paper, with its citation file, the
    // figure byte for byte, tagged, attributed to arXiv and locked.
    const paper = await (
      await app.request(`/v1/artifacts/${after.documents[0].short_id}`, {
        headers: as(member.email),
      })
    ).json()
    expect(paper.title).toBe("Attention Is All You Need")
    expect(paper.locked).toBe(true)
    // v1 was the placeholder the queue published; v2 is the paper, by its own authors.
    expect(paper.versions.map((v: { author: string }) => v.author)).toEqual([
      "arXiv",
      "Ashish Vaswani, Noam Shazeer",
    ])
    expect(paper.current_version).toBe(2)
    expect(paper.import_source).toBe("arxiv")
    const row = await meta.getByShortId(paper.short_id)
    const v = row ? await meta.getVersion(row.id, paper.current_version) : null
    expect(v?.content_type).toBe("derive/latex")
    // What the import decided rides on the version, not in a second document.
    expect(v?.message).toContain(`Imported from arXiv:${ID}v2`)
    expect(v?.message).toContain("unwrapped the top-level directory paper-src/")
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    )
    expect(manifest.entry).toBe("/paper.tex")
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/CITATION.bib",
      "/fig/a.png",
      "/main.bbl",
      "/main.tex",
      "/paper.bbl",
      "/paper.tex",
      "/refs.bib",
    ])
    expect([...((await ctx.blobs.get(manifest.files["/fig/a.png"].key)) ?? [])]).toEqual([...PNG])
    expect((await meta.tagsForArtifacts([row?.id ?? ""]))[row?.id ?? ""]).toEqual([
      "arxiv",
      `arxiv:${ID}`,
    ])
    // A person reads the paper, never its LaTeX: `content` answers in prose whatever it
    // is asked for, and the source-shaped routes are not there for them.
    const page = await app.request(`/v1/artifacts/${paper.short_id}/content`, {
      headers: as(member.email),
    })
    expect(page.status).toBe(200)
    const prose = await page.text()
    expect(prose).toContain("Intro")
    expect(prose).not.toContain("\\documentclass")
    expect(prose).not.toContain("\\bibliography")
    for (const path of [
      `/v1/artifacts/${paper.short_id}/source.zip`,
      `/v1/artifacts/${paper.short_id}/files/paper.tex`,
      `/v1/artifacts/${paper.short_id}/bib`,
      `/v1/artifacts/${paper.short_id}/diff?from=1&to=2`,
    ])
      expect((await app.request(path, { headers: as(member.email) })).status).toBe(404)
    // The rendered page is what the viewer shows, and `?raw=1` cannot peel it back.
    const rawTry = await app.request(
      `/raw/${paper.short_id}/v/${paper.current_version}/paper.tex?raw=1`,
      { headers: as(member.email) },
    )
    expect(await rawTry.text()).not.toContain("\\documentclass")

    // Read-only for people: no new version, no restore.
    expect(
      (await publishAs(app, "\\documentclass{article}", {}, as(owner.email), paper.short_id))
        .status,
    ).toBe(409)
    expect(
      (await publishAs(app, "# edited", {}, as(owner.email), after.manifest_short_id)).status,
    ).toBe(409)
    const restore = await app.request(`/v1/artifacts/${after.manifest_short_id}/restore`, {
      ...jsonAs(as(owner.email), { version: 1 }),
    })
    expect(restore.status).toBe(409)
    // The same paper again opens the one Context; a non-arXiv link is refused up front.
    const again = await importPaper(app, `https://huggingface.co/papers/${ID}`)
    expect(again.status).toBe(200)
    expect((await again.json()).id).toBe(created.id)
    const bad = await importPaper(app, "https://example.com/paper.pdf")
    expect(bad.status).toBe(400)
    expect((await bad.json()).code).toBe("not_arxiv")
  })

  it("holds arXiv's gate across workers, honours Retry-After for everyone, and resumes a reclaimed job", async () => {
    let rateLimit = true
    const stub = arxivStub({
      source: () =>
        rateLimit
          ? new Response("slow down", { status: 429, headers: { "retry-after": "120" } })
          : gzip(SOURCE()),
    })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-gate", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const a = await (await importPaper(app, "2402.00001")).json()
    const b = await (await importPaper(app, "2402.00002")).json()
    expect(
      await meta.countActiveImportJobs(
        a.import ? ((await meta.getContext(a.id))?.org_id ?? "") : "",
      ),
    ).toBe(2)

    // Two workers on one store: one takes the gate, the other gets nothing.
    const [x, y] = await Promise.all([runImportTick(tickDeps("w1")), runImportTick(tickDeps("w2"))])
    expect(x + y).toBe(1)
    const jobA = await meta.getImportJobForContext(a.id)
    expect(jobA).toMatchObject({ status: "failed", error_code: "rate_limited", attempts: 1 })
    // The 429 holds every worker back for the Retry-After, not only the one that saw it.
    const lease = await meta.getImportLease("arxiv", "http://derive.test")
    expect(Date.parse(lease?.next_allowed_at ?? "")).toBeGreaterThanOrEqual(c.now() + 120_000)
    expect(await runImportTick(tickDeps("w2"))).toBe(0)
    c.advance(121_000)
    rateLimit = false
    // The other paper goes first (its job is due; A waits out its backoff).
    expect(await runImportTick(tickDeps("w2"))).toBe(1)
    expect((await meta.getImportJobForContext(b.id))?.status).toBe("ready")
    c.advance(10 * 60_000)
    expect(await runImportTick(tickDeps("w1"))).toBe(1)
    expect((await meta.getImportJobForContext(a.id))?.status).toBe("ready")

    // A worker that died mid-import: its job lease lapses and the next tick resumes from
    // the paper it had already published, fetching only the metadata again.
    const done = await meta.getImportJobForContext(a.id)
    if (!done) throw new Error("job missing")
    await meta.updateImportJob(done.id, {
      status: "fetching",
      lease_until: "2000-01-01T00:00:00.000Z",
      manifest_version: null,
    })
    const before = stub.calls.length
    c.advance(5 * 60_000)
    expect(await runImportTick(tickDeps("w3"))).toBe(1)
    expect(stub.calls.slice(before).map((u) => new URL(u).pathname)).toEqual(["/api/query"])
    const resumed = await meta.getImportJobForContext(a.id)
    expect(resumed).toMatchObject({ status: "ready", paper_artifact_id: done.paper_artifact_id })
    // Resuming republishes nothing: the paper it already published stands.
    const paper = await meta.getArtifactById(done.paper_artifact_id ?? "")
    expect(paper?.current_version).toBe(2)
  })

  it("gives up on a paper whose worker keeps being cut off, without running it again", async () => {
    // A worker the platform stops (memory, CPU, wall clock) records nothing: its lease just
    // lapses. Three of those in a row end the import instead of reclaiming it forever.
    const stub = arxivStub()
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-cutoff", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2407.00001")).json()
    const job = await meta.getImportJobForContext(x.id)
    if (!job) throw new Error("job missing")
    await meta.updateImportJob(job.id, {
      status: "fetching",
      attempts: 3,
      lease_until: "2000-01-01T00:00:00.000Z",
    })
    expect(await runImportTick(tickDeps())).toBe(1)
    // Recorded from what the store knows, without another request to arXiv.
    expect(stub.calls).toHaveLength(0)
    const context = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
    ).json()
    expect(context.import).toMatchObject({ status: "dead", error: { code: "internal" } })
    expect(context.import.error.detail).toContain("cut off")
    // The page says the import gave up, rather than reading "fetching" forever.
    const page = await app.request(
      `/v1/artifacts/${context.manifest_short_id}/content?format=text`,
      { headers: as(owner.email) },
    )
    expect(await page.text()).toContain("Derive tried three times")
    // And it is never due again.
    c.advance(60 * 60_000)
    expect(await runImportTick(tickDeps("w2"))).toBe(0)
  })

  it("stops a worker whose job was taken over, before it can write over the new owner", async () => {
    let takeOver: (() => Promise<void>) | null = null
    const stub = arxivStub({
      source: async () => {
        await takeOver?.()
        return gzip(SOURCE())
      },
    })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-takeover", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2407.00002")).json()
    const job = await meta.getImportJobForContext(x.id)
    if (!job) throw new Error("job missing")
    // The download outlasts the first worker's lease, and another worker claims the job.
    let tookOver: unknown = null
    takeOver = async () => {
      c.advance(5 * 60_000)
      tookOver = await meta.claimDueImportJob(
        new Date(c.now()).toISOString(),
        new Date(c.now() + 4 * 60_000).toISOString(),
        "http://derive.test",
        "w2:took-over",
      )
    }
    expect(await runImportTick(tickDeps("w1"))).toBe(1)
    expect(tookOver).toMatchObject({ id: job.id, attempts: 2 })
    // The first worker stopped at its next write, so nothing it did afterwards landed: no
    // paper, no failure, and the job still belongs to the worker that took it.
    expect(await meta.getImportJob(job.id)).toMatchObject({
      status: "fetching",
      claim_token: "w2:took-over",
      paper_artifact_id: null,
      error_code: null,
    })
    const context = await meta.getContext(x.id)
    const placeholder = await meta.getArtifactById(context?.manifest_artifact_id ?? "")
    expect(placeholder?.current_version).toBe(1)
  })

  it("keeps its claim through a run that outlasts the lease", async () => {
    let onSource: (() => void) | null = null
    let onBibtex: (() => Promise<void>) | null = null
    const stub = arxivStub({
      source: async () => {
        onSource?.()
        return gzip(SOURCE())
      },
      bibtex: async () => {
        await onBibtex?.()
        return new Response(BIBTEX)
      },
    })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-heartbeat", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2407.00003")).json()
    // Three minutes on the download and three more on the BibTeX: past the four-minute
    // lease. A worker that never renewed its claim would look dead halfway through.
    let stolen: unknown = "not attempted"
    onSource = () => c.advance(3 * 60_000)
    onBibtex = async () => {
      c.advance(3 * 60_000)
      stolen = await meta.claimDueImportJob(
        new Date(c.now()).toISOString(),
        new Date(c.now() + 4 * 60_000).toISOString(),
        "http://derive.test",
        "w2:too-early",
      )
    }
    expect(await runImportTick(tickDeps("w1"))).toBe(1)
    expect(stolen).toBeNull()
    expect((await meta.getImportJobForContext(x.id))?.status).toBe("ready")
  })

  it("names the phase and the reason a failure gave", async () => {
    // Every failure records WHERE it happened and WHAT was said. Without this the only
    // thing an operator ever sees is "arXiv didn't answer", which is not always true.
    const stub = arxivStub({ metadata: () => new Response("nope", { status: 403 }) })
    const { app, meta, tickDeps } = setup("contexts-import-detail", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })

    const x = await (await importPaper(app, "2407.00001")).json()
    expect(await runImportTick(tickDeps())).toBe(1)
    const job = await meta.getImportJobForContext(x.id)
    expect(job).toMatchObject({ error_code: "unavailable" })
    expect(job?.error_detail).toBe("metadata: arXiv answered 403")
    // And it reaches the person, not just the log.
    const detail = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.import.error).toEqual({
      code: "unavailable",
      detail: "metadata: arXiv answered 403",
    })
  })

  it("says which host went quiet and what the runtime said", async () => {
    // A connection that never happened has no status to report, so the runtime's own
    // message is the only evidence of what went wrong. Discarding it left "arXiv could
    // not be reached", which covers DNS, a refused connection, a reset and TLS alike.
    const stub = arxivStub({
      metadata: () => {
        throw new TypeError("Network connection lost.")
      },
    })
    const { app, meta, tickDeps } = setup("contexts-import-cause", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2407.00004")).json()
    expect(await runImportTick(tickDeps())).toBe(1)

    const job = await meta.getImportJobForContext(x.id)
    expect(job?.error_code).toBe("unavailable")
    // The phase, the host that failed, and the runtime's verdict.
    expect(job?.error_detail).toBe(
      "metadata: export.arxiv.org could not be reached (TypeError: Network connection lost.)",
    )
  })

  it("distinguishes a timeout from a connection that never happened", async () => {
    const stub = arxivStub({
      metadata: () => {
        const e = new Error("The operation was aborted due to timeout")
        e.name = "TimeoutError"
        throw e
      },
    })
    const { app, meta, tickDeps } = setup("contexts-import-timeout", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2407.00005")).json()
    expect(await runImportTick(tickDeps())).toBe(1)
    expect((await meta.getImportJobForContext(x.id))?.error_detail).toBe(
      "metadata: export.arxiv.org did not answer within 10s",
    )
  })

  it("never blames arXiv for a fault of its own", async () => {
    // arXiv answers perfectly; the store is what breaks. Reporting that as an upstream
    // that went quiet sends whoever is debugging it to the wrong system entirely.
    const stub = arxivStub()
    const { app, meta, tickDeps } = setup("contexts-import-internal", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2407.00002")).json()

    const base = tickDeps()
    const broken = {
      ...base,
      meta: new Proxy(base.meta, {
        get: (target, prop, receiver) =>
          prop === "setArtifactTags"
            ? async () => {
                throw new Error('relation "artifact_tag" does not exist')
              }
            : Reflect.get(target, prop, receiver),
      }),
    }
    expect(await runImportTick(broken)).toBe(1)

    const job = await meta.getImportJobForContext(x.id)
    expect(job?.error_code).toBe("internal")
    expect(job?.error_code).not.toBe("unavailable")
    // It says which phase, and what actually happened.
    expect(job?.error_detail).toContain("publish:")
    expect(job?.error_detail).toContain("artifact_tag")
    const detail = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.import.error.code).toBe("internal")
  })

  it("gives a re-pasted paper its attempts back", async () => {
    // Pasting again is a person asking for another go. A paper that had already died used
    // to come back with its budget spent and give up on the first failure.
    const stub = arxivStub({ metadata: () => new Response("nope", { status: 403 }) })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-repaste", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2407.00003")).json()
    for (let i = 0; i < 3; i++) {
      c.advance(10 * 60_000)
      expect(await runImportTick(tickDeps())).toBe(1)
    }
    expect(await meta.getImportJobForContext(x.id)).toMatchObject({ status: "dead", attempts: 3 })

    const again = await (await importPaper(app, "2407.00003")).json()
    expect(again.id).toBe(x.id)
    expect(await meta.getImportJobForContext(x.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    })
  })

  it("gives up on arXiv's verdicts without retrying, and says so on the paper's page", async () => {
    const cases: [string, Stub | undefined, Stub | undefined, string][] = [
      ["2403.00001", () => new Response(ERROR_ATOM), undefined, "not_found"],
      [
        "2403.00002",
        undefined,
        () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), { status: 200 }),
        "no_source",
      ],
      [
        "2403.00003",
        undefined,
        () => gzip(gzipSync(tarSync({ "README.md": "no tex here" }))),
        "no_tex",
      ],
      ["2403.00004", undefined, () => gzip(gzipSync(new Uint8Array(6 * 1024 * 1024))), "too_large"],
      [
        "2403.00005",
        undefined,
        () => new Response("", { status: 301, headers: { location: "https://evil.example/src" } }),
        "unavailable",
      ],
      // A PDF that arrives gzipped is still only a PDF.
      [
        "2403.00006",
        undefined,
        () => gzip(gzipSync(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))),
        "no_source",
      ],
    ]
    let current = cases[0]
    const stub = arxivStub({
      metadata: (url, init) => current?.[1]?.(url, init) ?? new Response(ATOM(current?.[0] ?? ID)),
      source: (url, init) => current?.[2]?.(url, init) ?? gzip(SOURCE()),
    })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-failures", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    for (const kase of cases) {
      current = kase
      const [id, , , code] = kase
      const x = await (await importPaper(app, id)).json()
      c.advance(60_000)
      expect(await runImportTick(tickDeps())).toBe(1)
      const job = await meta.getImportJobForContext(x.id)
      expect(job?.error_code).toBe(code)
      const detail = await (
        await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
      ).json()
      if (code === "unavailable") {
        // A redirect off arXiv is refused, and counts as arXiv being unreachable: retried.
        expect(job?.status).toBe("failed")
        expect(Date.parse(job?.next_attempt_at ?? "")).toBeGreaterThan(c.now())
        expect(detail.import.status).toBe("failed")
      } else {
        expect(job).toMatchObject({ status: "dead", attempts: 1 })
        expect(detail.import).toMatchObject({ status: "dead", error: { code } })
        // The one artifact says so on its page: it never keeps saying "fetching".
        const page = await app.request(
          `/v1/artifacts/${detail.manifest_short_id}/content?format=text`,
          { headers: as(owner.email) },
        )
        const text = await page.text()
        expect(text).toContain("Import failed:")
        expect(text).not.toContain("Fetching this paper")
      }
      // Its owner can queue it again; the count starts over.
      const retry = await app.request(`/v1/contexts/${x.id}/import/retry`, {
        method: "POST",
        headers: as(owner.email),
      })
      expect(retry.status).toBe(200)
      expect((await retry.json()).import.status).toBe("pending")
      expect((await meta.getImportJobForContext(x.id))?.attempts).toBe(
        code === "unavailable" ? 1 : 0,
      )
      // Clear it so the workspace cap does not trip the next case.
      await app.request(`/v1/contexts/${x.id}`, { method: "DELETE", headers: as(owner.email) })
      expect(await meta.getImportJob(job?.id ?? "")).toBeNull()
    }
  })

  it("shrinks oversized raster figures in place until the bundle fits, and names what it cannot shrink", async () => {
    // A 2200 px square of noise: PNG cannot compress it, so it weighs about as much as
    // its pixels, and the only way under a small cap is fewer pixels.
    const sharp = (await import("sharp")).default
    const noise = new Uint8Array(2200 * 2200)
    for (let at = 0; at < noise.length; at += 65_536)
      crypto.getRandomValues(noise.subarray(at, Math.min(at + 65_536, noise.length)))
    const bigPng = new Uint8Array(
      await sharp(noise, { raw: { width: 2200, height: 2200, channels: 1 } })
        .png()
        .toBuffer(),
    )
    const smallJpg = new Uint8Array(
      await sharp({ create: { width: 200, height: 120, channels: 3, background: "#3366aa" } })
        .jpeg()
        .toBuffer(),
    )
    expect(bigPng.byteLength).toBeGreaterThan(4 * 1024 * 1024)
    const tex = `\\documentclass{article}\\begin{document}\\includegraphics{figs/noise.png}\\includegraphics{figs/tiny.jpg}\\end{document}`
    let source: () => Uint8Array = () =>
      gzipSync(tarSync({ "main.tex": tex, "figs/noise.png": bigPng, "figs/tiny.jpg": smallJpg }))
    const stub = arxivStub({ source: () => gzip(source()) })
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import-shrink", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const caps = {
      compressedBytes: 64 * 1024 * 1024,
      inflatedBytes: 64 * 1024 * 1024,
      bundleBytes: 4 * 1024 * 1024,
      files: 200,
    }
    const x = await (await importPaper(app, "2405.00001")).json()
    expect(await runImportTick({ ...tickDeps(), caps, shrink: sharpShrinker() })).toBe(1)
    const detail = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.import.status).toBe("ready")
    const paper = await meta.getByShortId(detail.documents[0].short_id)
    const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
    expect(v?.author).toBe("Ashish Vaswani, Noam Shazeer")
    expect(v?.message).toMatch(
      /shrank 1 figure to at most 1600 px on the long side \(\d+\.\d MB → \d+\.\d MB\)/,
    )
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    )
    // Same paths and formats; the PNG lost pixels, the small JPEG kept its bytes.
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/CITATION.bib",
      "/figs/noise.png",
      "/figs/tiny.jpg",
      "/main.tex",
    ])
    const shrunk = (await ctx.blobs.get(manifest.files["/figs/noise.png"].key)) ?? new Uint8Array()
    expect(shrunk.byteLength).toBeLessThan(bigPng.byteLength)
    expect([...shrunk.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    const width = new DataView(shrunk.buffer, shrunk.byteOffset).getUint32(16)
    const height = new DataView(shrunk.buffer, shrunk.byteOffset).getUint32(20)
    expect(Math.max(width, height)).toBe(1600)
    expect([...((await ctx.blobs.get(manifest.files["/figs/tiny.jpg"].key)) ?? [])]).toEqual([
      ...smallJpg,
    ])
    expect(v?.size_bytes).toBeLessThan(caps.bundleBytes)
    const page = await app.request(`/v1/artifacts/${paper?.short_id}/content`, {
      headers: as(owner.email),
    })
    expect(await page.text()).toContain("figs/noise.png")

    // A PDF figure is never touched: when it alone keeps the bundle over the cap, the
    // import gives up and says which file it was.
    source = () =>
      gzipSync(
        tarSync({
          "main.tex":
            "\\documentclass{article}\\begin{document}\\includegraphics{figs/plot.pdf}\\end{document}",
          "figs/plot.pdf": new Uint8Array(6 * 1024 * 1024).fill(0x25),
          "figs/noise.png": bigPng,
        }),
      )
    const y = await (await importPaper(app, "2405.00002")).json()
    c.advance(60_000)
    expect(await runImportTick({ ...tickDeps(), caps, shrink: sharpShrinker() })).toBe(1)
    const job = await meta.getImportJobForContext(y.id)
    expect(job).toMatchObject({ status: "dead", error_code: "too_large" })
    expect(job?.error_detail).toMatch(
      /after shrinking 1 figures; largest: figs\/plot\.pdf \(6\.0 MB\)/,
    )
    const failed = await (
      await app.request(`/v1/contexts/${y.id}`, { headers: as(owner.email) })
    ).json()
    const failedPage = await app.request(
      `/v1/artifacts/${failed.manifest_short_id}/content?format=text`,
      { headers: as(owner.email) },
    )
    expect(await failedPage.text()).toContain("Import failed:")
  }, 30_000)

  it("streams a source into storage as it arrives, holding the paper's text and little else", async () => {
    // A figure larger than what the worker reads whole, in a source that arrives a kilobyte
    // at a time: the figure goes through a writer as it arrives, byte for byte.
    const figure = new Uint8Array(600 * 1024)
    for (let at = 0; at < figure.length; at += 65_536)
      crypto.getRandomValues(figure.subarray(at, Math.min(at + 65_536, figure.length)))
    const archive = gzipSync(
      tarSync({
        "paper/main.tex":
          "\\documentclass{article}\\begin{document}\\includegraphics{fig/big.png}\\end{document}",
        "paper/refs.bib": "@misc{a, title={A}, author={B}, year={2020}}",
        "paper/fig/big.png": figure,
      }),
    )
    const stub = arxivStub({
      source: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let at = 0; at < archive.length; at += 1024)
                controller.enqueue(archive.slice(at, at + 1024))
              controller.close()
            },
          }),
          { status: 200, headers: { "content-type": "application/gzip" } },
        ),
    })
    const { app, meta, ctx, tickDeps } = setup("contexts-import-stream", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2408.00001")).json()
    const puts: number[] = []
    const streamed: number[] = []
    const blobs: BlobStore = {
      put: (data) => {
        puts.push(data.byteLength)
        return ctx.blobs.put(data)
      },
      get: (key) => ctx.blobs.get(key),
      writer: (size) => {
        streamed.push(size)
        const writer = ctx.blobs.writer?.(size)
        if (!writer) throw new Error("the test store streams")
        return writer
      },
    }
    const base = tickDeps()
    const caps = { ...base.caps, bufferFileBytes: 64 * 1024, inflightBytes: 256 * 1024 }
    expect(await runImportTick({ ...base, blobs, caps })).toBe(1)

    const detail = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.import.status).toBe("ready")
    const paper = await meta.getByShortId(detail.documents[0].short_id)
    const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    ) as { files: Record<string, { key: string; size: number }> }
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/CITATION.bib",
      "/fig/big.png",
      "/main.tex",
      "/refs.bib",
    ])
    // Only the figure streamed, and nothing larger than the read-whole size went in whole.
    expect(streamed).toEqual([figure.byteLength])
    expect(Math.max(...puts)).toBeLessThanOrEqual(64 * 1024)
    const stored = await ctx.blobs.get(manifest.files["/fig/big.png"]?.key ?? "")
    expect(Buffer.from(stored ?? new Uint8Array()).equals(Buffer.from(figure))).toBe(true)
    expect(v?.size_bytes).toBe(Object.values(manifest.files).reduce((n, f) => n + f.size, 0))
  })

  it("imports a paper without what it cannot afford, and says what that was", async () => {
    // A figure over what a request can read whole to serve, and a generated table past the
    // text an import reads to find the paper. Neither is a reason to lose the paper.
    const stub = arxivStub({
      source: () =>
        gzip(
          gzipSync(
            tarSync({
              "main.tex":
                "\\documentclass{article}\\begin{document}\\input{tables/all}\\end{document}",
              "tables/all.tex": `${"1 & 2 \\\\\n".repeat(40_000)}`,
              "fig/huge.png": new Uint8Array(1536 * 1024),
              "fig/small.png": new Uint8Array(64),
            }),
          ),
        ),
    })
    const { app, meta, ctx, tickDeps } = setup("contexts-import-left-out", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2408.00003")).json()
    const base = tickDeps()
    const caps = { ...base.caps, maxFileBytes: 1024 * 1024, textBytes: 256 * 1024 }
    expect(await runImportTick({ ...base, caps })).toBe(1)

    const detail = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.import.status).toBe("ready")
    const paper = await meta.getByShortId(detail.documents[0].short_id)
    const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    ) as { entry: string; files: Record<string, unknown> }
    // The table is kept, unread; the figure is left out and named.
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/CITATION.bib",
      "/fig/small.png",
      "/main.tex",
      "/tables/all.tex",
    ])
    expect(manifest.entry).toBe("/main.tex")
    expect(v?.message).toContain("left out 1 file over the 1.0 MB one file may be: fig/huge.png")
    expect(v?.message).toContain("did not read 1 .tex file")
  })

  it("stops reading a source while storage is behind", async () => {
    // Forty 64 KB figures in front of a store that takes nothing until it is told to. The
    // reader has to stop once the bytes waiting on storage reach the limit, not run on.
    const figures: Record<string, Uint8Array> = {}
    for (let i = 0; i < 40; i++) {
      const png = new Uint8Array(64 * 1024)
      crypto.getRandomValues(png)
      figures[`paper/fig/${i}.png`] = png
    }
    const archive = gzipSync(
      tarSync({
        "paper/main.tex": "\\documentclass{article}\\begin{document}x\\end{document}",
        ...figures,
      }),
    )
    let pulled = 0
    const stub = arxivStub({
      source: () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (pulled >= archive.length) {
                  controller.close()
                  return
                }
                const piece = archive.slice(pulled, pulled + 16 * 1024)
                pulled += piece.length
                controller.enqueue(piece)
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200, headers: { "content-type": "application/gzip" } },
        ),
    })
    const { app, meta, ctx, tickDeps } = setup("contexts-import-backpressure", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2408.00002")).json()
    let open: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    const blobs: BlobStore = {
      put: async (data) => {
        await opened
        return ctx.blobs.put(data)
      },
      get: (key) => ctx.blobs.get(key),
    }
    const base = tickDeps()
    const tick = runImportTick({
      ...base,
      blobs,
      caps: {
        ...base.caps,
        compressedBytes: 8 * 1024 * 1024,
        inflatedBytes: 8 * 1024 * 1024,
        bufferFileBytes: 128 * 1024,
        inflightBytes: 256 * 1024,
      },
    })
    // Wait until the reader has started and then gone still.
    let last = -1
    for (let i = 0; i < 200 && (pulled === 0 || pulled !== last); i++) {
      last = pulled
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(pulled).toBeGreaterThan(0)
    expect(pulled).toBeLessThan(archive.length / 4)
    open()
    expect(await tick).toBe(1)
    expect(pulled).toBe(archive.length)
    expect((await meta.getImportJobForContext(x.id))?.status).toBe("ready")
  })

  it("imports a paper sent as one gzipped .tex, and a latin-1 source as UTF-8", async () => {
    const enc = new TextEncoder()
    let source = () =>
      gzipSync(enc.encode("\\documentclass{article}\\begin{document}One file.\\end{document}"))
    const stub = arxivStub({ source: () => gzip(source()) })
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import-single", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const textOf = async (contextId: string, path: string) => {
      const detail = await (
        await app.request(`/v1/contexts/${contextId}`, { headers: as(owner.email) })
      ).json()
      expect(detail.import.status).toBe("ready")
      const paper = await meta.getByShortId(detail.documents[0].short_id)
      const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
      const manifest = JSON.parse(
        new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
      ) as { files: Record<string, { key: string }> }
      const bytes = await ctx.blobs.get(manifest.files[path]?.key ?? "")
      return new TextDecoder().decode(bytes ?? undefined)
    }
    const one = await (await importPaper(app, "2408.00003")).json()
    expect(await runImportTick(tickDeps())).toBe(1)
    expect(await textOf(one.id, "/main.tex")).toContain("One file.")

    const latin = new Uint8Array([
      ...enc.encode("\\documentclass{article}\\usepackage[latin1]{inputenc}\\begin{document}caf"),
      0xe9,
      ...enc.encode("\\end{document}"),
    ])
    source = () => gzipSync(tarSync({ "main.tex": latin, "refs.bib": new Uint8Array([0xe9]) }))
    const two = await (await importPaper(app, "2408.00004")).json()
    c.advance(60_000)
    expect(await runImportTick(tickDeps())).toBe(1)
    expect(await textOf(two.id, "/main.tex")).toContain("café")
    expect(await textOf(two.id, "/refs.bib")).toBe("é")
  })

  // A paper's implementation. The agent reads it; the person gets a link to the
  // repository on its own host and never a file listing.
  const REPO_FILES = {
    "gaussian-splatting-abc123/README.md": "# Gaussian Splatting\n\nRun `train.py`.\n",
    "gaussian-splatting-abc123/docs/index.html": "<h1>Project page</h1>",
    "gaussian-splatting-abc123/docs/site.css": "body { color: red }",
    "gaussian-splatting-abc123/train.py": "def train():\n    return 42\n",
    "gaussian-splatting-abc123/utils/loss.py": "def l1(a, b):\n    return abs(a - b)\n",
    "gaussian-splatting-abc123/.gitmodules":
      '[submodule "submodules/rasterizer"]\n\tpath = submodules/rasterizer\n\turl = https://github.com/graphdeco-inria/diff-gaussian-rasterization\n\tbranch = dr_aa\n[submodule "submodules/knn"]\n\tpath = submodules/knn\n\turl = https://bitbucket.org/bkerbl/simple-knn.git\n[submodule "submodules/walled"]\n\tpath = submodules/walled\n\turl = https://gitlab.example.org/lab/walled.git\n',
  }
  const SUB_FILES = {
    "diff-gaussian-rasterization-def456/setup.py": "from setuptools import setup\nsetup()\n",
  }
  // A host's archive of a repository, naming the commit it was made from the way git does
  // when `commit` is given.
  const repoTar = (files: Record<string, string | Uint8Array>, commit?: string) => () =>
    gzip(gzipSync(tarSync(files, commit ? { global: { comment: commit } } : {})))

  it("fetches the repository that implements a paper into the paper's own artifact", async () => {
    const ROOT_COMMIT = "4c2a1f0e9d8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c"
    const stub = arxivStub(
      {},
      {
        "graphdeco-inria/gaussian-splatting": repoTar(REPO_FILES, ROOT_COMMIT),
        "graphdeco-inria/diff-gaussian-rasterization": repoTar(SUB_FILES, "f".repeat(40)),
        // A lab's own GitLab behind an anti-bot wall: real, and common for the
        // institutional submodules a paper's repository declares.
        "lab/walled": () => new Response("<html>not a bot?</html>", { status: 406 }),
      },
    )
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import-code", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })

    const res = await app.request(
      "/v1/contexts/import/arxiv",
      jsonAs(as(owner.email), {
        url: "2406.00001",
        code_url: "https://github.com/graphdeco-inria/gaussian-splatting",
      }),
    )
    expect(res.status).toBe(201)
    const created = await res.json()
    // The paper publishes in one pass and is readable at once. Its implementation is left
    // to the next pass, handed back to the queue without spending an attempt.
    expect(await runImportTick(tickDeps())).toBe(1)
    expect(stub.calls.some((u) => u.includes("/tar.gz/"))).toBe(false)
    const between = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    expect(between.import).toMatchObject({ status: "ready", code: { status: "pending" } })
    expect(await meta.getImportJobForContext(created.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    })
    c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
    expect(await runImportTick(tickDeps())).toBe(1)

    // The repository was fetched from the host's plain archive, with no API call and no
    // token, and the submodule it declares came too.
    const archives = stub.calls.filter((u) => u.includes("/tar.gz/"))
    expect(archives).toEqual([
      "https://codeload.github.com/graphdeco-inria/gaussian-splatting/tar.gz/HEAD",
      "https://codeload.github.com/graphdeco-inria/diff-gaussian-rasterization/tar.gz/dr_aa",
    ])

    const detail = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    // The paper's own import is ready, and so is its implementation.
    expect(detail.import.status).toBe("ready")
    const job = await meta.getImportJobForContext(created.id)
    expect(job).toMatchObject({
      code_status: "ready",
      code_error: null,
      code_ref: "github.com/graphdeco-inria/gaussian-splatting",
      code_commit: ROOT_COMMIT,
    })
    // The commit is the root's, as its archive named it. A submodule's is not kept: it was
    // fetched at its declared branch, not at the commit the root pins it to.
    expect(detail.import.code.commit).toBe(ROOT_COMMIT)

    // ONE artifact still: the paper, now carrying the code under /code/.
    expect(detail.documents).toHaveLength(1)
    const paper = await meta.getByShortId(detail.documents[0].short_id)
    const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    )
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/CITATION.bib",
      "/code/.gitmodules",
      "/code/README.md",
      "/code/docs/index.html",
      "/code/docs/site.css",
      "/code/submodules/rasterizer/setup.py",
      "/code/train.py",
      "/code/utils/loss.py",
      "/fig/a.png",
      "/main.bbl",
      "/main.tex",
      "/paper.bbl",
      "/paper.tex",
      "/refs.bib",
    ])
    // The paper is still the document: a README inside the repository did not take the
    // entry, and the artifact is still a LaTeX paper.
    expect(manifest.entry).toBe("/paper.tex")
    expect(v?.content_type).toContain("latex")
    // The version says what was attached, including the branch caveat and the host it
    // would not follow.
    expect(v?.message).toContain("Attached github.com/graphdeco-inria/gaussian-splatting")
    expect(v?.message).toContain("skipped the submodule at submodules/knn")
    expect(v?.message).toContain("at their declared branch")
    // A submodule that will not come is a gap in the tree, not the end of the fetch: the
    // rest of the implementation is stored and the missing one is named.
    expect(v?.message).toContain("could not fetch the submodule at submodules/walled")
    expect(v?.message).toContain("refused an anonymous download (406)")

    // The code is stored as itself, byte for byte, so an agent asking for that path gets
    // the source rather than a rendering of it.
    expect(
      new TextDecoder().decode(
        (await ctx.blobs.get(manifest.files["/code/train.py"].key)) ?? undefined,
      ),
    ).toBe("def train():\n    return 42\n")

    // ---- and none of it is visible to a person -----------------------------------
    const short = paper?.short_id
    // The file list the artifact page renders: the paper's files, never the repository's.
    const detailJson = await (
      await app.request(`/v1/artifacts/${short}`, { headers: as(owner.email) })
    ).json()
    expect(detailJson.bundle.files.map((f: { path: string }) => f.path)).toEqual([
      "CITATION.bib",
      "fig/a.png",
      "main.bbl",
      "main.tex",
      "paper.bbl",
      "paper.tex",
      "refs.bib",
    ])
    // The machine content API's page list, the other place a path listing escapes.
    const outline = await (
      await app.request(`/v1/artifacts/${short}/content?outline=1`, { headers: as(owner.email) })
    ).json()
    expect(JSON.stringify(outline)).not.toContain("/code/")
    // Serving a file: a repository's HTML, CSS and markdown render BEFORE the paper's
    // source guard, so each has to be refused by name.
    const n = paper?.current_version
    for (const path of [
      "code/train.py",
      "code/README.md",
      "code/docs/index.html",
      "code/docs/site.css",
      "code/docs",
    ]) {
      const raw = await app.request(`/raw/${short}/v/${n}/${path}`, { headers: as(owner.email) })
      expect([raw.status, path]).toEqual([404, path])
    }
    // The paper's own page still renders, with its figure.
    const page = await app.request(`/raw/${short}/v/${n}/`, { headers: as(owner.email) })
    expect(page.status).toBe(200)
    expect(
      (await app.request(`/raw/${short}/v/${n}/fig/a.png`, { headers: as(owner.email) })).status,
    ).toBe(200)
    // And the source export is the paper's source: an implementation is not something
    // the authors wrote.
    expect(
      (await app.request(`/v1/artifacts/${short}/source.zip`, { headers: as(owner.email) })).status,
    ).toBe(404)
  })

  it("keeps the source and leaves binaries, data and media behind", async () => {
    // A repository that is mostly demo media and data, which is what a paper's repository is.
    // Real bytes, not printable ones: what makes a file media is its content.
    const bigGif = new Uint8Array(3 * 1024 * 1024)
    bigGif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00])
    for (let at = 8; at < bigGif.length; at += 65_536)
      crypto.getRandomValues(bigGif.subarray(at, Math.min(at + 65_536, bigGif.length)))
    const smallPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const stub = arxivStub(
      {},
      {
        "o/r": repoTar({
          "r-abc/train.py": "def train():\n    return 1\n",
          "r-abc/configs/base.yaml": "lr: 0.1\n",
          "r-abc/assets/demo.gif": bigGif,
          "r-abc/assets/icon.png": smallPng,
          // Text, but data: an agent reads the loader, not the points.
          "r-abc/data/points.csv": "x,y\n1,2\n",
        }),
      },
    )
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import-code-big", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), { url: "2406.00002", code_url: "https://github.com/o/r" }),
      )
    ).json()
    const base = tickDeps()
    const stored: number[] = []
    const blobs: BlobStore = {
      put: (data) => {
        stored.push(data.byteLength)
        return ctx.blobs.put(data)
      },
      get: (key) => ctx.blobs.get(key),
      writer: (size) => {
        stored.push(size)
        const writer = ctx.blobs.writer?.(size)
        if (!writer) throw new Error("the test store streams")
        return writer
      },
    }
    const deps = {
      ...base,
      blobs,
      repoCaps: { ...base.repoCaps, compressedBytes: 8 * 1024 * 1024 },
    }
    // The paper publishes in one pass, and its implementation attaches in the next.
    expect(await runImportTick(deps)).toBe(1)
    c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
    expect(await runImportTick(deps)).toBe(1)
    // What is not source is decided before it is stored, so the GIF never was.
    expect(stored).not.toContain(bigGif.byteLength)

    const detail = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    const paper = await meta.getByShortId(detail.documents[0].short_id)
    const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    )
    const code = Object.keys(manifest.files).filter((p: string) => p.startsWith("/code/"))
    // Every line of source survives, and nothing else does, however small; the largest of
    // what was left out is named.
    expect(code.sort()).toEqual(["/code/configs/base.yaml", "/code/train.py"])
    expect(v?.message).toContain("left out 3 files that are not source")
    expect(v?.message).toContain("assets/demo.gif")
    expect((await meta.getImportJobForContext(created.id))?.code_status).toBe("ready")
  })

  it("attaches an implementation to a paper already imported, then takes it away", async () => {
    const R2_COMMIT = "9d3c1f7a2b6e8d0c4a5f9e1b7c3d2a8f6e0b4c1d"
    const stub = arxivStub(
      {},
      {
        "o/r": repoTar({ "r-abc/train.py": "def train():\n    return 7\n" }),
        "o/r2": repoTar({ "r2-def/train.py": "def train():\n    return 8\n" }, R2_COMMIT),
      },
    )
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import-code-later", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await (await importPaper(app, "2406.00005")).json()
    // arXiv's gate holds every worker for the interval after a request, so each tick
    // below waits it out the way a real deployment's next tick would.
    const tick = async (blobs: BlobStore = ctx.blobs) => {
      c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
      return await runImportTick({ ...tickDeps(), blobs })
    }
    expect(await tick()).toBe(1)

    const filesOf = async () => {
      const detail = await (
        await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
      ).json()
      const paper = await meta.getByShortId(detail.documents[0].short_id)
      const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
      const manifest = JSON.parse(
        new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
      ) as { files: Record<string, { key: string; size: number }> }
      return { detail, version: v, manifest, paths: Object.keys(manifest.files).sort() }
    }
    const imported = await filesOf()
    expect(imported.paths.some((p: string) => p.startsWith("/code/"))).toBe(false)
    expect(imported.detail.import.code).toBeNull()
    // The manifest records each file's size, which is what lets the paper travel by key.
    const figure = imported.manifest.files["/fig/a.png"]
    expect(figure?.size).toBe(PNG.byteLength)

    // Attach it afterwards: the paper is not fetched again, only its metadata is.
    const before = stub.calls.length
    const attached = await (
      await app.request(
        `/v1/contexts/${created.id}/import/code`,
        jsonAs(as(owner.email), { url: "https://github.com/o/r" }),
      )
    ).json()
    expect(attached.import.code).toEqual({
      url: "https://github.com/o/r",
      status: "pending",
      error: null,
      commit: null,
    })
    // The requeued job is working on the CODE. The paper is already here, so it does not
    // report itself as being fetched from arXiv again: only `code.status` is pending.
    expect(attached.import.status).toBe("ready")
    expect(attached.import.error).toBeNull()
    // Nor is the paper read back from storage: it is published again by key, so attaching
    // the code never loads the figure it sits beside.
    const reads: string[] = []
    const counting: BlobStore = {
      put: (data) => ctx.blobs.put(data),
      get: (key) => {
        reads.push(key)
        return ctx.blobs.get(key)
      },
    }
    expect(await tick(counting)).toBe(1)
    expect(stub.calls.slice(before).filter((u) => u.includes("/src/"))).toEqual([])
    expect(reads).not.toContain(figure?.key)

    const withCode = await filesOf()
    expect(withCode.paths).toContain("/code/train.py")
    // An archive that names no commit leaves none: nothing is guessed.
    expect(withCode.detail.import.code).toMatchObject({
      status: "ready",
      error: null,
      commit: null,
    })
    expect(withCode.detail.description).toContain("Ashish Vaswani, Noam Shazeer")
    expect(withCode.version?.message).toContain("Attached github.com/o/r")
    expect(withCode.version?.author).toBe("Ashish Vaswani, Noam Shazeer")
    // The version measures what its manifest holds, the files carried by key included.
    expect(withCode.version?.size_bytes).toBe(
      Object.values(withCode.manifest.files).reduce((n, f) => n + f.size, 0),
    )

    // Attaching the SAME repository again is not a change: the job runs, sees the link it
    // already fetched, and leaves the paper on the version it is on.
    const version = withCode.version?.n
    await app.request(
      `/v1/contexts/${created.id}/import/code`,
      jsonAs(as(owner.email), { url: "https://github.com/o/r/" }),
    )
    expect(await tick()).toBe(1)
    expect((await filesOf()).version?.n).toBe(version)

    // Replacing it with another repository fetches that one, at the commit its archive names.
    await app.request(
      `/v1/contexts/${created.id}/import/code`,
      jsonAs(as(owner.email), { url: "https://github.com/o/r2" }),
    )
    expect(await tick()).toBe(1)
    const replaced = await filesOf()
    expect(replaced.version?.message).toContain("Attached github.com/o/r2")
    expect(replaced.detail.import.code).toMatchObject({
      url: "https://github.com/o/r2",
      status: "ready",
      commit: R2_COMMIT,
    })

    // Removing it republishes the paper without the code, so it stops being readable.
    const removed = await (
      await app.request(
        `/v1/contexts/${created.id}/import/code`,
        jsonAs(as(owner.email), { url: null }),
      )
    ).json()
    expect(removed.import.code).toBeNull()
    expect(await tick()).toBe(1)
    const gone = await filesOf()
    expect(gone.paths.some((p: string) => p.startsWith("/code/"))).toBe(false)
    expect(gone.paths).toContain("/paper.tex")
    expect(gone.version?.message).toBe("Removed the implementation")
    expect(gone.version?.author).toBe("Ashish Vaswani, Noam Shazeer")
    expect(await meta.getImportJobForContext(created.id)).toMatchObject({
      code_status: null,
      code_ref: null,
      code_commit: null,
    })
  })

  it("a repository that cannot be fetched leaves the paper imported and says why", async () => {
    const stub = arxivStub() // every repository archive 404s
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-code-fail", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), { url: "2406.00003", code_url: "https://github.com/o/gone" }),
      )
    ).json()
    // The paper in one pass, the repository in the next.
    expect(await runImportTick(tickDeps())).toBe(1)
    c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
    expect(await runImportTick(tickDeps())).toBe(1)

    // The paper is what the import is for: it arrived, and stays arrived.
    const detail = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.import.status).toBe("ready")
    expect(detail.name).toBe("Attention Is All You Need")
    expect(await meta.getImportJobForContext(created.id)).toMatchObject({
      status: "ready",
      code_status: "failed",
      code_error: "no such repository, or it is not public (the host answered 404)",
    })
  })

  it("refuses an implementation with more source than an import keeps, and keeps the paper", async () => {
    const repo: Record<string, string> = {}
    for (let i = 0; i < 6; i++) repo[`r-abc/pkg/mod${i}.py`] = `x = ${i}\n`
    const stub = arxivStub({}, { "o/r": repoTar(repo) })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-code-over", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), { url: "2406.00005", code_url: "https://github.com/o/r" }),
      )
    ).json()
    const base = tickDeps()
    const deps = { ...base, repoCaps: { ...base.repoCaps, files: 5 } }
    expect(await runImportTick(deps)).toBe(1)
    c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
    expect(await runImportTick(deps)).toBe(1)
    // Part of a tree would read like all of it, so none is attached, and the bound is named.
    const job = await meta.getImportJobForContext(created.id)
    expect(job).toMatchObject({ status: "ready", code_status: "failed", code_ref: null })
    expect(job?.code_error).toContain("more than the 5 source files")
  })

  it("shows a paper's implementation analysis, with the prompts that start and update it", async () => {
    const COMMIT = "5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80"
    const NEXT = "6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091"
    const train = "def train():\n    return 7\n"
    const stub = arxivStub(
      {},
      {
        "o/r": repoTar({ "r-abc/train.py": train }, COMMIT),
        "o/r2": repoTar({ "r2-def/train.py": train }, NEXT),
      },
    )
    const { app, clock: c, tickDeps } = setup("contexts-import-analysis", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(member.email) })
    const created = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), { url: "2406.00009", code_url: "https://github.com/o/r" }),
      )
    ).json()
    const analysisOf = async (who = owner) =>
      (await app.request(`/v1/contexts/${created.id}/analysis`, { headers: as(who.email) })).json()
    // An agent's tool call over MCP, the way the prompt tells an agent to publish.
    const mcp = async (token: string, name: string, args: Record<string, unknown>) => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
      const text = await res.text()
      const body = (res.headers.get("content-type") ?? "").includes("application/json")
        ? JSON.parse(text)
        : JSON.parse(
            (text.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
          )
      return { text: body?.result?.content?.[0]?.text as string, isError: !!body?.result?.isError }
    }

    // Until the implementation has arrived there is nothing to map it to.
    expect((await analysisOf()).state).toBe("unavailable")
    expect(await runImportTick(tickDeps())).toBe(1)
    c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
    expect(await runImportTick(tickDeps())).toBe(1)

    // Then a prompt that starts it, naming everything an agent has to find.
    const none = await analysisOf()
    expect(none).toMatchObject({
      state: "none",
      analysis: null,
      can_publish: true,
      implementation: { repository: "github.com/o/r", commit: COMMIT },
    })
    for (const needle of [
      created.id,
      none.paper_short_id,
      `"commit": "${COMMIT}"`,
      "http://derive.test/mcp",
    ])
      expect(none.prompts.start).toContain(needle)
    expect(none.prompts.update).toBeNull()

    // An agent does what the prompt says.
    const agent = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Mapper", role: "editor" }))
    ).json()
    const outline = JSON.parse(
      (await mcp(agent.token, "read", { short_id: none.paper_short_id })).text,
    )
    const slug = outline.pages.find((p: { path: string }) => p.path === "paper.tex")?.headings[0]
      ?.slug
    const published = await mcp(agent.token, "publish", {
      files: {
        "derive.paper-analysis.json": JSON.stringify({
          schema: "derive.paper-analysis/v1",
          context: created.id,
          based_on: null,
          paper: { short_id: none.paper_short_id, arxiv_version: 2 },
          implementation: { repository: "github.com/o/r", commit: COMMIT },
          summary: "The training loop is the paper's.",
          contributions: [
            {
              id: "c1",
              title: "Training",
              claim: "The model trains end to end.",
              paper: [{ section: `paper.tex#${slug}` }],
              details: [
                {
                  id: "c1.d1",
                  title: "The loop",
                  paper: [],
                  code: [{ path: "train.py", symbol: "def train", lines: "1-2" }],
                  status: "implemented",
                },
              ],
            },
          ],
        }),
      },
    })
    expect(published.isError).toBe(false)

    // The page shows it, each code reference opening on the host at the commit it read.
    const ready = await analysisOf()
    expect(ready).toMatchObject({
      state: "ready",
      analysis: { version: 1, agent: "Mapper", counts: { implemented: 1 } },
      prompts: { start: null },
    })
    expect(ready.analysis.contributions[0].details[0].code[0]).toEqual({
      path: "train.py",
      symbol: "def train",
      lines: "1-2",
      href: `https://github.com/o/r/blob/${COMMIT}/train.py#L1-L2`,
      pinned: true,
    })
    // A cited section reads as the paper's outline names it, numbered the way LaTeX numbers it.
    expect(ready.analysis.contributions[0].paper[0]).toEqual({
      section: `paper.tex#${slug}`,
      label: null,
      heading: "1 Intro",
    })
    for (const needle of [`short_id: "${ready.analysis.short_id}"`, "based_on 1", "catch_up"])
      expect(ready.prompts.update).toContain(needle)
    const detail = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.documents).toContainEqual(
      expect.objectContaining({ short_id: ready.analysis.short_id, role: "analysis" }),
    )

    // Once the implementation is replaced it describes code the Context no longer holds. Its
    // links still open where it looked, and the update prompt names what the Context holds now.
    await app.request(
      `/v1/contexts/${created.id}/import/code`,
      jsonAs(as(owner.email), { url: "https://github.com/o/r2" }),
    )
    c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
    expect(await runImportTick(tickDeps())).toBe(1)
    const stale = await analysisOf(member)
    expect(stale.state).toBe("stale")
    expect(stale.stale_reasons[0]).toContain("github.com/o/r2")
    expect(stale.analysis.contributions[0].details[0].code[0].href).toBe(
      `https://github.com/o/r/blob/${COMMIT}/train.py#L1-L2`,
    )
    expect(stale.prompts.update).toContain("It is out of date")
    expect(stale.prompts.update).toContain(`"commit": "${NEXT}"`)
  })

  it("refuses a link that is not a public GitHub or GitLab repository", async () => {
    const stub = arxivStub()
    const { app, tickDeps } = setup("contexts-import-code-bad", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    for (const code_url of [
      "https://bitbucket.org/o/r",
      "file:///etc/passwd",
      "https://github.com/only-an-owner",
    ]) {
      const res = await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), { url: "2406.00004", code_url }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe("not_a_repo")
    }
    // Nothing was queued, so nothing was fetched.
    expect(await runImportTick(tickDeps())).toBe(0)
  })

  it("never fetches a repository archive from a private address", async () => {
    const stub = arxivStub()
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-code-private", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), {
          url: "2406.00005",
          code_url: "https://gitlab.localhost/o/r",
        }),
      )
    ).json()

    expect(await runImportTick(tickDeps())).toBe(1)
    c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
    expect(await runImportTick(tickDeps())).toBe(1)
    expect(await meta.getImportJobForContext(created.id)).toMatchObject({
      status: "ready",
      code_status: "failed",
      code_error: "the repository host is not a public address",
    })
    expect(stub.calls.some((url) => new URL(url).hostname === "gitlab.localhost")).toBe(false)
  })

  it("rechecks repository DNS before fetching an archive", async () => {
    const stub = arxivStub()
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-code-private-dns", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const hostname = "gitlab.internal.example"
    const created = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), {
          url: "2406.00006",
          code_url: `https://${hostname}/o/r`,
        }),
      )
    ).json()

    const deps = {
      ...tickDeps(),
      addressGuard: {
        async precheck(url: string) {
          return new URL(url).hostname === hostname ? "blocked: private DNS answer" : null
        },
      },
    }
    expect(await runImportTick(deps)).toBe(1)
    c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
    expect(await runImportTick(deps)).toBe(1)
    expect(await meta.getImportJobForContext(created.id)).toMatchObject({
      status: "ready",
      code_status: "failed",
      code_error: "the repository host is not a public address",
    })
    expect(stub.calls.some((url) => new URL(url).hostname === hostname)).toBe(false)
  })

  it("hands the arXiv gate back before shrinking, so the next import fetches meanwhile", async () => {
    // A figure above the shrink floor, so the codec is entered at all.
    const stub = arxivStub({
      source: () =>
        gzip(
          gzipSync(
            tarSync({
              "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}",
              "fig/big.png": new Uint8Array(100 * 1024),
            }),
          ),
        ),
    })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-gate-free", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2406.00001")).json()
    let resume: () => void = () => {}
    const shrinking = new Promise<void>((r) => {
      resume = r
    })
    let entered: () => void = () => {}
    const enteredShrink = new Promise<void>((r) => {
      entered = r
    })
    const slow = async () => {
      entered()
      await shrinking
      return null
    }
    const caps = { compressedBytes: 64 << 20, inflatedBytes: 64 << 20, bundleBytes: 1, files: 200 }
    const tick = runImportTick({ ...tickDeps("w1"), caps, shrink: slow })
    await enteredShrink
    // The three requests are out; three seconds later another worker may take the gate
    // although w1 is still busy with the figures.
    c.advance(3_500)
    expect(
      await meta.acquireImportLease(
        "arxiv",
        "http://derive.test",
        "w2",
        new Date(c.now()).toISOString(),
        new Date(c.now() + 240_000).toISOString(),
      ),
    ).toBe(true)
    resume()
    expect(await tick).toBe(1)
    // The job then failed honestly (a 1-byte cap fits nothing), without touching the gate.
    expect((await meta.getImportJobForContext(x.id))?.error_code).toBe("too_large")
    expect((await meta.getImportLease("arxiv", "http://derive.test"))?.holder).toBe("w2")
  })

  it("stops when the Context is discarded mid-fetch, and caps a workspace's imports in flight", async () => {
    let discard: (() => Promise<void>) | null = null
    const stub = arxivStub({
      source: async () => {
        await discard?.()
        return gzip(SOURCE())
      },
    })
    const { app, meta, tickDeps } = setup("contexts-import-cancel", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2404.00001")).json()
    const org = (await meta.getContext(x.id))?.org_id ?? ""
    const artifactsBefore = (await meta.listArtifacts({ orgId: org, limit: 100 })).length
    discard = async () => {
      await app.request(`/v1/contexts/${x.id}`, { method: "DELETE", headers: as(owner.email) })
    }
    expect(await runImportTick(tickDeps())).toBe(1)
    expect(await meta.getContext(x.id)).toBeNull()
    expect(await meta.getImportJobForContext(x.id)).toBeNull()
    // The manifest went with the context; no paper was published into the void.
    expect((await meta.listArtifacts({ orgId: org, limit: 100 })).length).toBe(artifactsBefore - 1)

    discard = null
    for (const id of ["2404.00002", "2404.00003", "2404.00004"])
      expect((await importPaper(app, id)).status).toBe(201)
    const fourth = await importPaper(app, "2404.00005")
    expect(fourth.status).toBe(429)
  })

  it("shrinks a figure on the Workers tier in a browser page, sending it in slices", async () => {
    // Browser Rendering cannot run here, so the page is a stand-in that runs the shrinker's
    // page code against a stubbed canvas. What is pinned is the crossing (one figure at a
    // time, in slices, and back) and the figures that are never sent at all.
    const header = new Uint8Array(24)
    header.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ])
    const view = new DataView(header.buffer)
    view.setUint32(16, 2200)
    view.setUint32(20, 1100)
    const figure = new Uint8Array(900 * 1024)
    figure.set(header)
    const smaller = new Uint8Array(200 * 1024).fill(7)
    let drawn: number[] = []
    const page = globalThis as unknown as Record<string, unknown>
    const saved = { bitmap: page.createImageBitmap, canvas: page.OffscreenCanvas }
    page.createImageBitmap = async () => ({ width: 2200, height: 1100, close: () => {} })
    page.OffscreenCanvas = class {
      constructor(width: number, height: number) {
        drawn = [width, height]
      }
      getContext() {
        return { drawImage: () => {} }
      }
      async convertToBlob() {
        return new Blob([smaller])
      }
    }
    const evaluated: string[] = []
    let launches = 0
    const stand: ShrinkPage = {
      evaluate: async (fn, arg) => {
        evaluated.push(fn.name)
        return fn(arg)
      },
      close: async () => {},
    }
    const shrinker = browserFigureShrinker({} as never, async () => {
      launches++
      return { newPage: async () => stand, close: async () => {} }
    })
    try {
      const out = await shrinker.shrink({
        path: "/fig/wide.png",
        bytes: figure,
        maxSide: 1600,
        quality: 82,
      })
      expect(Buffer.from(out ?? new Uint8Array()).equals(Buffer.from(smaller))).toBe(true)
      expect(drawn).toEqual([1600, 800])
      // 900 KB went over in three slices.
      expect(evaluated.filter((name) => name === "pageReceive")).toHaveLength(3)
      // Never sent: a format it does not re-encode, and a figure over 80 megapixels.
      view.setUint32(16, 20_000)
      view.setUint32(20, 20_000)
      const huge = new Uint8Array(1024)
      huge.set(header)
      const sent = evaluated.length
      expect(
        await shrinker.shrink({ path: "/fig/plot.gif", bytes: figure, maxSide: 1600, quality: 82 }),
      ).toBeNull()
      expect(
        await shrinker.shrink({ path: "/fig/huge.png", bytes: huge, maxSide: 1600, quality: 82 }),
      ).toBeNull()
      expect(evaluated).toHaveLength(sent)
      expect(launches).toBe(1)
      expect(shrinker.unavailable).toBe(false)
    } finally {
      await shrinker.close()
      page.createImageBitmap = saved.bitmap
      page.OffscreenCanvas = saved.canvas
    }
  })
  it("deletes only imported papers: a Context that was not imported is not found", async () => {
    const { app, meta } = makeAuthedApp("paper-delete-guard", [owner, member], "editor")
    await app.request("/v1/me", { headers: as(owner.email) })
    const manifest = await (
      await publishAs(app, "# Instructions", { title: "Instructions" }, as(owner.email))
    ).json()
    const art = await meta.getByShortId(manifest.short_id)
    const x = await meta.createContext({
      id: "ctx_plain_guard",
      org_id: "default",
      name: "Plain",
      agent_id: "ag_plain_guard",
      manifest_artifact_id: art?.id ?? "",
      created_by: owner.id,
    })
    const res = await app.request(`/v1/contexts/${x.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(res.status).toBe(404)
    expect(await meta.getContext(x.id)).not.toBeNull()
    expect(await meta.getByShortId(manifest.short_id)).not.toBeNull()
  })
})

// ---- the same papers over MCP -------------------------------------------------------

const owner: TestUser = { id: "u_mcx_own", email: "mcxown@derive.test", name: "Owner" }
const dev: TestUser = { id: "u_mcx_dev", email: "mcxdev@derive.test", name: "Dev" }

type App = ReturnType<typeof makeAuthedApp>["app"]

// A direct tools/call over the stateless /mcp endpoint (mcp-inbox-wait's shape).
// callRaw keeps the text + isError for error assertions; call JSON-parses a
// success payload.
const callRaw = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  const out = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  const t = r?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return { text: t, isError: !!r?.isError }
}
const call = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
): Promise<any> => {
  const result = await callRaw(app, token, name, args)
  if (result.isError) throw new Error(result.text)
  return JSON.parse(result.text)
}

// find's browse/search rows are typed; the askable contexts come back as
// {type:"context"} rows — the former list_contexts payload, one per context, each

describe("imported papers over MCP — read-only, cited, never run", () => {
  it("read loads the paper package: the pointer and the citation", async () => {
    const ID = "2405.00001"
    const tex =
      "\\documentclass{article}\n\\begin{document}\n\\begin{abstract}\nAn abstract.\n\\end{abstract}\n\\section{Intro}\nHello.\n\\end{document}\n"
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/${ID}v1</id><published>2024-05-01T00:00:00Z</published><title>Reading Papers</title><summary>An abstract.</summary><author><name>Ada Lovelace</name></author><arxiv:primary_category term="cs.DL"/></entry></feed>`
    const bibtex = `@misc{lovelace2024reading,\n  title={Reading Papers},\n  author={Ada Lovelace},\n  year={2024},\n  eprint={${ID}},\n  archivePrefix={arXiv}\n}`
    const stub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const u = new URL(url)
      if (u.hostname === "export.arxiv.org") return new Response(atom)
      if (u.pathname.startsWith("/src/"))
        return new Response(gzipSync(tarSync({ "main.tex": tex })), { status: 200 })
      if (u.pathname.startsWith("/bibtex/")) return new Response(bibtex)
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch
    const made = makeAuthedApp("mcx-import", [owner, dev], "editor", { deps: { fetch: stub } })
    const { app, meta, ctx } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const ownerBot = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
    ).json()
    const queued = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(dev.email), { url: `https://arxiv.org/abs/${ID}` }),
      )
    ).json()
    // While it is on its way, read already says so.
    expect((await call(app, ownerBot.token, "read", { short_id: queued.id })).import).toMatchObject(
      { source: "arxiv", ref: ID, status: "pending" },
    )

    let t = Date.parse("2030-06-01T00:00:00.000Z")
    expect(
      await runImportTick({
        meta,
        blobs: ctx.blobs,
        bus: ctx.bus,
        notify: ctx.notify,
        background: ctx.background,
        baseUrl: "http://derive.test",
        fetch: stub,
        now: () => t,
        sleep: async (ms) => {
          t += ms
        },
        caps: {
          compressedBytes: 1024 * 1024,
          inflatedBytes: 4 * 1024 * 1024,
          bundleBytes: 4 * 1024 * 1024,
          files: 200,
        },
      }),
    ).toBe(1)

    const pkg = await call(app, ownerBot.token, "read", { short_id: queued.id })
    expect(pkg.import).toMatchObject({ source: "arxiv", ref: ID, status: "ready", version: 1 })
    // One artifact: the Context's own, named as its paper.
    expect(pkg.documents).toEqual([
      {
        short_id: queued.manifest_short_id,
        title: "Reading Papers",
        kind: "bundle",
        role: "paper",
      },
    ])
    // The summary is computed from the paper, never stored beside it.
    expect(pkg.manifest.content).toContain("# Reading Papers")
    expect(pkg.manifest.content).toContain("Ada Lovelace · arXiv:2405.00001v1")
    expect(pkg.manifest.content).toContain("## Abstract\n\nAn abstract.")
    expect(pkg.manifest.content).toContain("```bibtex\n@misc{lovelace2024reading")
    expect(pkg.manifest.content).not.toContain("\\documentclass")
    expect(pkg.context).toMatchObject({ id: queued.id, name: "Reading Papers" })

    const paper = await call(app, ownerBot.token, "read", { short_id: pkg.documents[0].short_id })
    expect(paper.entry).toBe("main.tex")
    expect(paper.citation).toEqual({ key: "lovelace2024reading", bibtex })
    expect(paper.next).toContain("\\cite{lovelace2024reading}")
    // The whole point of the source being kept: an agent asked about the method reads the
    // paper's own LaTeX, macros and all, not the prose projection a person sees.
    const body = await callRaw(app, ownerBot.token, "read", {
      short_id: pkg.documents[0].short_id,
      section: "main.tex",
    })
    expect(body.text).toContain("format: latex (source)")
    expect(body.text).toContain("\\documentclass{article}")
    expect(body.text).toContain("\\begin{abstract}")
    expect(body.text).toContain("Hello.")
  })

  it("reads the implementation beside the paper, summarised rather than listed", async () => {
    const ID = "2405.00002"
    const tex =
      "\\documentclass{article}\n\\begin{document}\n\\section{Method}\nSee the code.\n\\end{document}\n"
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/${ID}v1</id><published>2024-05-01T00:00:00Z</published><title>Splatting</title><summary>An abstract.</summary><author><name>Ada Lovelace</name></author><arxiv:primary_category term="cs.CV"/></entry></feed>`
    const COMMIT = "9fceb02d0ae598e95dc970b74767f19372d61af8"
    // A repository with more files than any outline should ever print.
    const repo: Record<string, string> = {
      "r-abc/train.py": "def train():\n    return 42\n",
      "r-abc/README.md": "# Splatting\n",
    }
    for (let i = 0; i < 140; i++) repo[`r-abc/scene/part${i}/mod.py`] = `# module ${i}\n`
    const stub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const u = new URL(url)
      if (u.hostname === "export.arxiv.org") return new Response(atom)
      if (u.pathname.startsWith("/src/"))
        return new Response(gzipSync(tarSync({ "main.tex": tex })), { status: 200 })
      if (u.pathname.startsWith("/bibtex/")) return new Response("not bibtex", { status: 404 })
      if (u.pathname.startsWith("/o/r/tar.gz/"))
        return new Response(gzipSync(tarSync(repo, { global: { comment: COMMIT } })), {
          status: 200,
        })
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch
    const made = makeAuthedApp("mcx-import-code", [owner, dev], "editor", { deps: { fetch: stub } })
    const { app, meta, ctx } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const ownerBot = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
    ).json()
    const queued = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(dev.email), {
          url: `https://arxiv.org/abs/${ID}`,
          code_url: "https://github.com/o/r",
        }),
      )
    ).json()
    let t = Date.parse("2030-06-01T00:00:00.000Z")
    const caps = {
      compressedBytes: 1024 * 1024,
      inflatedBytes: 4 * 1024 * 1024,
      bundleBytes: 4 * 1024 * 1024,
      files: 400,
    }
    const tickDeps = {
      meta,
      blobs: ctx.blobs,
      bus: ctx.bus,
      notify: ctx.notify,
      background: ctx.background,
      baseUrl: "http://derive.test",
      fetch: stub,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      caps,
      repoCaps: {
        compressedBytes: 1024 * 1024,
        inflatedBytes: 4 * 1024 * 1024,
        totalBytes: 4 * 1024 * 1024,
        files: 400,
        depth: 3,
        repos: 5,
      },
    }
    // The paper in one pass, and its implementation in the next once arXiv's gate reopens.
    expect(await runImportTick(tickDeps)).toBe(1)
    t += 3_001
    expect(await runImportTick(tickDeps)).toBe(1)

    const pkg = await call(app, ownerBot.token, "read", { short_id: queued.id })
    // The Context says what implements it, and the exact commit its files were read from.
    expect(pkg.import.code).toEqual({
      url: "https://github.com/o/r",
      status: "ready",
      commit: COMMIT,
    })
    const paper = await call(app, ownerBot.token, "read", { short_id: pkg.documents[0].short_id })
    // The paper's own pages stay the pages: 142 repository files do not bury them.
    expect(paper.entry).toBe("main.tex")
    expect(paper.pages.map((p: { path: string }) => p.path)).toEqual(["main.tex", "CITATION.bib"])
    // The implementation is a map with a count, not a listing.
    expect(paper.code).toMatchObject({ root: "code/", files: 142, more: 42 })
    expect(paper.code.paths).toHaveLength(100)
    expect(paper.code.paths).toContain("code/train.py")
    expect(paper.next).toContain("code/")

    // Any path in the repository reads, listed in that sample or not.
    const listed = await callRaw(app, ownerBot.token, "read", {
      short_id: pkg.documents[0].short_id,
      section: "code/train.py",
    })
    expect(listed.text).toContain("def train():")
    const unlisted = await callRaw(app, ownerBot.token, "read", {
      short_id: pkg.documents[0].short_id,
      section: "code/scene/part139/mod.py",
    })
    expect(unlisted.text).toContain("# module 139")

    // A path that is in neither: the error names the paper's pages and says the code is
    // there, without printing 142 paths back.
    const missing = await callRaw(app, ownerBot.token, "read", {
      short_id: pkg.documents[0].short_id,
      section: "code/nope.py",
    })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain("142 files under `code/`")
    expect(missing.text.length).toBeLessThan(500)
  })
})

// An agent maps an imported paper to its implementation and publishes that map, which the
// Context links. What pins this down is what an agent does over MCP, against the real store.
describe("an imported paper's implementation analysis, over MCP", () => {
  const ID = "2406.10001"
  const COMMIT = "4f1c0a9e8d7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a"
  const NEXT = "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9"
  const tex = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{Method}\\label{sec:method}",
    "Splats are sorted by tile before they are blended.",
    "\\begin{equation}\\label{eq:loss} L = (1-\\lambda) L_1 + \\lambda L_{ssim} \\end{equation}",
    "\\end{document}",
    "",
  ].join("\n")
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/${ID}v1</id><published>2024-06-01T00:00:00Z</published><title>Splatting</title><summary>An abstract.</summary><author><name>Ada Lovelace</name></author><arxiv:primary_category term="cs.CV"/></entry></feed>`
  const render = "import torch\n\ndef sort_tiles(splats):\n    return sorted(splats)\n"
  const ANALYSIS = "derive.paper-analysis.json"

  /** An imported paper whose implementation has arrived, and two connections of its workspace
   *  owner: one that may publish and one that may only comment. */
  const imported = async (name: string) => {
    const tar = (files: Record<string, string>, commit: string) =>
      new Response(gzipSync(tarSync(files, { global: { comment: commit } })), { status: 200 })
    const stub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const u = new URL(url)
      if (u.hostname === "export.arxiv.org") return new Response(atom)
      if (u.pathname.startsWith("/src/"))
        return new Response(gzipSync(tarSync({ "main.tex": tex })), { status: 200 })
      if (u.pathname.startsWith("/bibtex/")) return new Response("not bibtex", { status: 404 })
      if (u.pathname.startsWith("/o/r/tar.gz/"))
        return tar(
          { "r-abc/render.py": render, "r-abc/train.py": "def train():\n    pass\n" },
          COMMIT,
        )
      if (u.pathname.startsWith("/o/r2/tar.gz/")) return tar({ "r2-def/render.py": render }, NEXT)
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch
    const made = makeAuthedApp(name, [owner, dev], "editor", { deps: { fetch: stub } })
    const { app, meta, ctx } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const writer = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Mapper", role: "editor" }))
    ).json()
    const commenter = await (
      await app.request(
        "/v1/agents",
        jsonAs(as(owner.email), { name: "Reader", role: "commenter" }),
      )
    ).json()
    const queued = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(dev.email), {
          url: `https://arxiv.org/abs/${ID}`,
          code_url: "https://github.com/o/r",
        }),
      )
    ).json()
    let t = Date.parse("2030-06-01T00:00:00.000Z")
    const tick = () => {
      t += 3_001
      return runImportTick({
        meta,
        blobs: ctx.blobs,
        bus: ctx.bus,
        notify: ctx.notify,
        background: ctx.background,
        baseUrl: "http://derive.test",
        fetch: stub,
        now: () => t,
        sleep: async (ms: number) => {
          t += ms
        },
        caps: {
          compressedBytes: 1 << 20,
          inflatedBytes: 4 << 20,
          bundleBytes: 4 << 20,
          files: 400,
        },
        repoCaps: {
          compressedBytes: 1 << 20,
          inflatedBytes: 4 << 20,
          totalBytes: 4 << 20,
          files: 400,
          depth: 3,
          repos: 5,
        },
      })
    }
    // The paper in one pass, its implementation in the next.
    expect(await tick()).toBe(1)
    expect(await tick()).toBe(1)
    const token = writer.token as string
    const pkg = await call(app, token, "read", { short_id: queued.id })
    const paperShortId = pkg.documents[0].short_id as string
    const outline = await call(app, token, "read", { short_id: paperShortId })
    const slug = outline.pages.find((p: { path: string }) => p.path === "main.tex")?.headings[0]
      ?.slug as string
    const analysis = (over: Record<string, unknown> = {}) => ({
      schema: "derive.paper-analysis/v1",
      context: queued.id,
      based_on: null,
      paper: { short_id: paperShortId, arxiv_version: 1 },
      implementation: { repository: "github.com/o/r", commit: COMMIT },
      summary: "The code sorts splats by tile as the method describes.",
      contributions: [
        {
          id: "c1",
          title: "Tile-sorted blending",
          claim: "Splats are sorted by tile before they are blended.",
          paper: [{ section: `main.tex#${slug}`, label: "eq:loss" }],
          details: [
            {
              id: "c1.d1",
              title: "Sorting by tile",
              paper: [{ section: `main.tex#${slug}` }],
              code: [{ path: "render.py", symbol: "def sort_tiles", lines: "3-4" }],
              status: "implemented",
            },
          ],
        },
      ],
      open_questions: [{ id: "q1", question: "Is lambda tuned per scene?" }],
      ...over,
    })
    return {
      app,
      meta,
      contextId: queued.id as string,
      paperShortId,
      writer: token,
      writerId: writer.id as string,
      commenter: commenter.token as string,
      tick,
      analysis,
      publish: (body: unknown, extra: Record<string, unknown> = {}) =>
        callRaw(app, token, "publish", { files: { [ANALYSIS]: JSON.stringify(body) }, ...extra }),
    }
  }

  it("an agent publishes it, and the Context and its paper point the next agent to it", async () => {
    const x = await imported("mcx-analysis-link")
    expect(
      (await call(x.app, x.writer, "read", { short_id: x.contextId })).import.analysis,
    ).toBeNull()

    const out = await x.publish(x.analysis())
    expect(out.isError).toBe(false)
    const published = JSON.parse(out.text)
    expect(published.implementation_analysis).toMatchObject({
      context: x.contextId,
      paper: x.paperShortId,
    })
    // It takes its access from the paper: no world link, not listed anywhere.
    expect(published).toMatchObject({ link_role: "none", listed: "none" })
    expect(published.title).toBe("Splatting: implementation analysis")

    const pkg = await call(x.app, x.writer, "read", { short_id: x.contextId })
    expect(pkg.documents).toContainEqual({
      short_id: published.short_id,
      title: published.title,
      kind: "bundle",
      role: "analysis",
    })
    expect(pkg.import.analysis).toMatchObject({
      short_id: published.short_id,
      version: 1,
      stale: false,
      counts: { contributions: 1, details: 1, implemented: 1 },
    })
    // The paper's own outline says so too, for an agent that reads the paper first.
    expect(
      (await call(x.app, x.writer, "read", { short_id: x.paperShortId })).implementation_analysis,
    ).toEqual({ short_id: published.short_id, version: 1 })

    // The agent's work, on behalf of the person it acts for.
    const art = await x.meta.getByShortId(published.short_id)
    expect(art ? await x.meta.getVersion(art.id, 1) : null).toMatchObject({
      agent_id: x.writerId,
      author_id: owner.id,
    })
    // The page people read is written from the data, its code linked at the commit fetched.
    const page = await callRaw(x.app, x.writer, "read", {
      short_id: published.short_id,
      section: "index.md",
    })
    expect(page.text).toContain(`https://github.com/o/r/blob/${COMMIT}/render.py#L3-L4`)
  })

  it("refuses an analysis that does not hold, naming every problem, and writes nothing", async () => {
    const x = await imported("mcx-analysis-refuse")
    const refused = await x.publish(
      x.analysis({
        implementation: { repository: "https://github.com/o/r", commit: NEXT },
        contributions: [
          {
            id: "c1",
            title: "Tile-sorted blending",
            claim: "Splats are sorted by tile.",
            paper: [{ section: "main.tex#nowhere" }],
            details: [
              { id: "c1.d1", title: "a", code: [{ path: "missing.py" }], status: "implemented" },
              {
                id: "c1.d2",
                title: "b",
                code: [{ path: "render.py", symbol: "def sort_tiles", lines: "1-2" }],
                status: "implemented",
              },
            ],
          },
        ],
      }),
    )
    expect(refused.isError).toBe(true)
    for (const problem of [
      `implementation.commit must be "${COMMIT}"`,
      '"missing.py" is not a file of the implementation',
      '"def sort_tiles" does not appear in render.py at lines 1-2',
      '"main.tex#nowhere" names no section of main.tex',
    ])
      expect(refused.text).toContain(problem)
    // A shape problem is named by its place in the JSON.
    const invalid = await x.publish(x.analysis({ contributions: [] }))
    expect(invalid.text).toContain("analysis.contributions must name at least one contribution")
    expect(
      (await call(x.app, x.writer, "read", { short_id: x.contextId })).import.analysis,
    ).toBeNull()
  })

  it("keeps one analysis per Context, corrected in the open and only through MCP", async () => {
    const x = await imported("mcx-analysis-update")
    const first = JSON.parse((await x.publish(x.analysis())).text)

    // A second analysis is an update to the first.
    const second = await x.publish(x.analysis())
    expect(second.text).toContain(`already has an implementation analysis, ${first.short_id}`)

    // An update starts from the version read, says why, and drops nothing without a reason.
    const careless = await x.publish(x.analysis({ based_on: 7, open_questions: [] }), {
      short_id: first.short_id,
    })
    expect(careless.text).toContain("analysis.based_on must be 1")
    expect(careless.text).toContain("an update needs a `message`")
    expect(careless.text).toContain('"q1" is gone without a reason')

    // Text edits and a page of the agent's own do not apply to an analysis.
    const edited = await callRaw(x.app, x.writer, "publish", {
      short_id: first.short_id,
      edits: [{ old_str: "tile", new_str: "tiles" }],
    })
    expect(edited.text).toContain(`revise it by publishing the whole ${ANALYSIS}`)
    const handPage = await callRaw(x.app, x.writer, "publish", {
      short_id: first.short_id,
      files: { [ANALYSIS]: JSON.stringify(x.analysis({ based_on: 1 })), "index.md": "# Mine" },
      message: "Rewrote the page.",
    })
    expect(handPage.text).toContain("Leave out `index.md`")

    // A correction with its reason is the next version.
    const corrected = await x.publish(
      x.analysis({
        based_on: 1,
        open_questions: [],
        removed: [{ id: "q1", reason: "The paper fixes lambda at 0.2 for every scene." }],
      }),
      { short_id: first.short_id, message: "Answered q1 from the paper." },
    )
    expect(JSON.parse(corrected.text)).toMatchObject({ short_id: first.short_id, version: 2 })

    // Outside MCP nothing checks it, so nothing else may revise it; a connection that may only
    // comment is steered to a comment.
    expect((await publishAs(x.app, "# By hand", {}, as(owner.email), first.short_id)).status).toBe(
      409,
    )
    const commented = await callRaw(x.app, x.commenter, "publish", {
      short_id: first.short_id,
      files: { [ANALYSIS]: JSON.stringify(x.analysis({ based_on: 2 })) },
      message: "A suggestion.",
    })
    expect(commented.text).toContain("Leave your suggested change as a comment")
  })

  it("goes stale when the implementation moves on, and never outlives what it describes", async () => {
    const x = await imported("mcx-analysis-stale")
    const first = JSON.parse((await x.publish(x.analysis())).text)

    // The implementation is replaced: the analysis now describes code the Context no longer holds.
    await x.app.request(
      `/v1/contexts/${x.contextId}/import/code`,
      jsonAs(as(dev.email), { url: "https://github.com/o/r2" }),
    )
    expect(await x.tick()).toBe(1)
    const moved = await call(x.app, x.writer, "read", { short_id: x.contextId })
    expect(moved.import.code).toMatchObject({ url: "https://github.com/o/r2", commit: NEXT })
    expect(moved.import.analysis).toMatchObject({ short_id: first.short_id, stale: true })

    // Deleting the analysis leaves the Context without one, ready for a new one.
    const removed = await x.app.request(`/v1/artifacts/${first.short_id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(removed.ok).toBe(true)
    expect(
      (await call(x.app, x.writer, "read", { short_id: x.contextId })).import.analysis,
    ).toBeNull()
    const again = JSON.parse(
      (
        await x.publish(
          x.analysis({ implementation: { repository: "github.com/o/r2", commit: NEXT } }),
        )
      ).text,
    )

    // Deleting the paper's Context takes its analysis with it.
    const gone = await x.app.request(`/v1/contexts/${x.contextId}`, {
      method: "DELETE",
      headers: as(dev.email),
    })
    expect(gone.ok).toBe(true)
    expect(await x.meta.getByShortId(again.short_id)).toBeNull()
  })
})
