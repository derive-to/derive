import {
  artifactUrl,
  DECK_TEMPLATE,
  derivedGen,
  deriveFacts,
  isDerivedFactName,
  landmarkSlice,
  landmarksOf,
  newId,
  type OutlineSection,
  outlineOf,
  sectionOf,
  toMarkdown,
  type VersionDataRecord,
  type VersionRecord,
} from "@derive/core"
import { z } from "zod"
import { BRANDPRINT_REFERENCE, BRANDPRINT_TEMPLATE } from "../brandprint-reference"
import { cleanPath } from "../lib/bundle"
import { boundSources, sourceTools } from "../lib/chat-sources"
import { clip, MAX_CHARS } from "../lib/clip"
import { pickVariant } from "../lib/collect-render"
import { assembleContextPackage } from "../lib/context-package"
import { sniffImageType } from "../lib/image"
import { baseType, isTextType, present, type ReadFormat } from "../lib/search"
import { log } from "../log"
import type { ToolContext } from "../mcp-tool-context"
import {
  clipDoc,
  DATA_SERIES_MAX,
  doc,
  err,
  FULL_DOC_MAX,
  formatLabel,
  IMAGE_INLINE_MAX,
  json,
  manifestOf,
  PAGE_MAP_MAX,
  parseLineRange,
  parseVersionRange,
  runnerOnline,
  safeJson,
  sleep,
  toBase64,
} from "../mcp-util"
import { enqueueRender } from "../previews"
import { CORE_SKILLS } from "../skills-reference.gen"

/** Does this version's KIND carry facts at all? Extraction and derivation both run on
 *  single-file HTML/markdown only (after-publish.ts), so a bundle, deck or binary carries
 *  neither asserted nor derived rows — and telling its author to embed a block is telling
 *  them to do the thing that was just silently ignored. Found by dogfooding: a bundle
 *  whose index.html DID carry a valid block still read back as "embed a block to add one". */
const kindCarriesFacts = (v: VersionRecord | null): boolean =>
  v?.content_type === "text/html" || v?.content_type === "text/markdown"

/** Why a fact is absent, said accurately — the cases the old single message merged.
 *  A `$name` can never be embedded (the author grammar rejects `$`), so "embed a block"
 *  is impossible advice for it; a bundle can't carry facts at all; everything else is the
 *  ordinary "nobody asserted this yet". `present` is what the version DOES carry, so the
 *  reply both explains the absence and shows the alternatives. */
const absenceNote = (
  name: string | null,
  v: VersionRecord | null,
  ref: string,
  present: string[] = [],
): string => {
  const also = present.length ? ` This version carries: ${present.join(", ")}.` : ""
  if (!kindCarriesFacts(v))
    return `${ref} is a ${v?.content_type === "derive/skill" ? "skill" : "bundle or non-text"} version, which carries no facts — asserted or derived. Facts are extracted from single-file HTML and markdown only, so a derive-facts block inside a bundle page is not read.`
  if (name && isDerivedFactName(name))
    return `${ref} has no "${name}". Derived facts are computed by the host, never embedded — "${name}" is absent because this version's content produced none ($outline needs two or more sections, $links needs a reference to another artifact).${also}`
  if (present.length)
    return `No facts "${name}" in ${ref} — facts: ${present.join(", ")}. Pass data:"*" to list them.`
  return `${ref} carries no facts — embed a derive-facts block to add one.`
}

/**
 * Recompute a version's derived facts from its own bytes and persist them, returning the
 * fresh set. The lazy half of derivation: publish-time covers new versions, this covers
 * every version that predates derivation (or a deriver's gen bump) — but ONLY from the
 * single-version named read, so the cost is one blob and one pass, ever, per version.
 *
 * The response is not held for the write: the derivation is pure and fast, so the VALUE
 * returns now while the rows persist through background() (waitUntil on Workers).
 *
 * The write is prefix-scoped (setDerivedVersionData) rather than a read-union-replace.
 * That is a correctness requirement, not a tidiness one: this is the SECOND writer to an
 * old version's rows, and the backfill is the first. A union built from a read taken
 * before the backfill's write would delete the author's fact it just added, and nothing
 * would restore it, because the next publish sees that fact already tracked and never
 * re-walks. Scoping the delete to `$` means no interleaving can express that loss.
 */
const lazyDeriveVersion = async (
  ctx: ToolContext["ctx"],
  artifactId: string,
  v: VersionRecord | null,
  n: number,
): Promise<VersionDataRecord[] | null> => {
  const ct = v?.content_type
  if (!v || (ct !== "text/html" && ct !== "text/markdown")) return null
  const source = await ctx.sourceText(v)
  if (source == null) return null
  const derived = deriveFacts(source, ct)
  const freshRows: VersionDataRecord[] = derived.map((s) => ({
    id: newId("vd"),
    artifact_id: artifactId,
    n,
    slot: s.slot,
    json: s.json,
    size_bytes: s.bytes,
    gen: s.gen,
    created_at: v.created_at,
  }))
  ctx.background(
    ctx.meta.setDerivedVersionData(
      artifactId,
      n,
      freshRows.map((r) => ({
        id: r.id,
        slot: r.slot,
        json: r.json,
        size_bytes: r.size_bytes,
        gen: r.gen,
      })),
    ),
  )
  return freshRows
}

export function registerReadTool(tc: ToolContext): void {
  const {
    server,
    ctx,
    bpProfile,
    profileArt,
    reach,
    notFound,
    wsArg,
    num,
    staleNote,
    actingFor,
    ownerId,
    resolveWs,
    askableContexts,
  } = tc

  // READ CONTENT --------------------------------------------------------------
  server.registerTool(
    "read",
    {
      description:
        "Read an artifact's CONTENT by short_id — or a CONTEXT's package by its ctx_ id/name (manifest inline, skills as pointers; `use` gives it work instead). A small doc returns whole; a LARGE doc returns its heading OUTLINE first — call again with a `section` slug (or a `lines` range) for just that part. Markdown by default; a styled HTML page is FLATTENED to text here, so pass render:'top' or 'full' to SEE it as a viewer does (do this after publishing a designed page to catch visual breakage). Bundle: omit `section` for the page list, then pass a page path (optionally `page.html#slug`). Pass format:'html' for the exact source (required BEFORE publish `edits`), or a past `version` for history. For what CHANGED or the comment threads, use catch_up instead.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        short_id: z
          .string()
          .describe(
            "The artifact's short id, e.g. nk0dsral. Also a CONTEXT id (ctx_…) or name — loads that package, not a document. Also a Brandprint URI — derive://brandprint/reference or /template (the static build guide), /profile (this workspace's live brand profile), or /<short_id> (a source doc) — a CORE SKILL URI (derive://skills/<name>, as the instructions index lists them), or derive://decks/template (the deck starter), so the strings the instructions name are readable here even where MCP resources aren't.",
          ),
        section: z
          .string()
          .optional()
          .describe(
            'What to read. Single-file doc: a heading slug from the outline (e.g. rollout-plan), or a region ref like "@2" from a headless page\'s map. Bundle: a page path (agentic-loop.html), optionally with a slug (agentic-loop.html#risks). Pass "*" (or "page.html#*" for a bundle page) to force the full (clipped) document/page. Omit it: small docs/pages return whole, large ones return their outline or region map.',
          ),
        format: z
          .enum(["markdown", "html", "text"])
          .optional()
          .describe(
            "markdown (default): HTML converted to structured Markdown — headings, lists, tables, code fences; Markdown sources return as-is. html: the exact stored source — read this BEFORE publish `edits` on an HTML artifact (edits match raw source). text: flat visible text, exactly what comment `quote`s anchor against.",
          ),
        lines: z
          .string()
          .optional()
          .describe(
            'Windowed read: a 1-indexed inclusive line range of the body in the chosen format — "40-120", "40" (one line), or "40-" (to the end). Windows a single-file doc, or one bundle page named by a bare `section` path. Pair with format:"html" to window the exact source before an edit. Skips the outline; still capped.',
          ),
        render: z
          .enum(["top", "full", "marked"])
          .optional()
          .describe(
            'SEE the published page instead of reading its text — what a viewer actually sees, catching visual breakage (a failed font, a broken layout) no text read can. "top": the 1200x630 crop (fastest, what an og:image unfurl shows). "full": the whole page, fullPage screenshot — catches below-the-fold breakage "top" misses. "marked": "full" again with the region map\'s @N refs drawn on it — pairs with a no-heading page\'s region map so what you SEE lines up with what you READ. All three computed a few seconds after each publish; pass alone (optionally with `version`).',
          ),
        wait: num("wait", { int: true, min: 1, max: 30 })
          .optional()
          .describe(
            "With `render`: when the screenshot isn't computed yet (a publish is seconds old), block up to this many seconds (max 30) for it to land instead of returning the not-ready message. Returns at once when it's already ready or has failed.",
          ),
        version: num("version").optional().describe("Defaults to the current version."),
        data: z
          .string()
          .optional()
          .describe(
            'A version\'s structured DATA slot: the JSON a `derive-data` block on the page stored under this name (see the publishing skill), so you can read back data you published instead of re-parsing old markup. Pass "*" to list the facts this version carries. Reads the current version unless `version` is set.',
          ),
        versions: z
          .string()
          .optional()
          .describe(
            'With `data`: read that slot across a RANGE of versions in ONE call — the trend read. "1-30", "12" (one), "20-" (to the current version), or "all". Versions are the time axis, so this answers "how did this change over time" without fetching each version. Returns oldest first; versions that carry no such slot are simply absent, and the response says how many.',
          ),
        workspace: wsArg,
      },
    },
    async ({
      short_id,
      section,
      format,
      version,
      lines,
      render,
      wait,
      data,
      versions,
      workspace,
    }) => {
      const fmt: ReadFormat = format ?? "markdown"
      // `derive://brandprint/*` URIs are readable through `read`, not only as MCP
      // resources — the exact strings the server instructions name, reachable by every
      // client even where resource support is weak or was never negotiated (the failure
      // this fixes: a session that connected before the Brandprint existed caches "no
      // resources" for its whole life). `reference`/`template` are the static build guide;
      // `profile` is the live brand profile; any other segment is a source-doc short_id
      // that falls through to the normal read path (so `section`/`lines`/`version` work).
      // `derive://skills/<name>` resolves the same way, so the core-skill strings the
      // instructions index names are readable through `read` even where MCP resources
      // aren't — same response shape as the Brandprint reference below.
      // `derive://sources` and `derive://sources/<id>` — the connections this workspace has
      // DECLARED for chat, and one server's tool catalog. Served here rather than as generated
      // tool definitions because MCP schemas are large and the chat surface has a size budget:
      // an index costs a line per connection, a catalog is fetched only when the turn actually
      // needs it. Same disclosure shape the skills index uses, applied to tool schemas.
      //
      // boundSources is the enforcement point, so an undeclared connection is not merely absent
      // from the index — asking for it by id returns nothing either.
      const SRC = "derive://sources"
      if (short_id === SRC || short_id.startsWith(`${SRC}/`)) {
        const ws = await resolveWs(workspace)
        if ("error" in ws) return err(ws.error)
        const bound = await boundSources(ctx.meta, ws.org, actingFor?.id ?? ownerId)
        const id = short_id === SRC ? "" : short_id.slice(SRC.length + 1)
        if (!id) {
          if (bound.length === 0)
            return json({
              uri: short_id,
              sources: [],
              note: "No connected sources are available to chat here. An admin declares them in workspace settings; connecting a server does not by itself expose it to a conversation.",
            })
          return json({
            uri: short_id,
            sources: bound.map((b: { id: string; toolkit: string; kind: string }) => ({
              id: b.id,
              name: b.toolkit,
              kind: b.kind,
              read: `derive://sources/${b.id}`,
            })),
            note: "Read one to see its tools, then invoke with the call tool.",
          })
        }
        const { tools } = await sourceTools(
          ctx.meta,
          ws.org,
          actingFor?.id ?? ownerId,
          ctx.deps.encryptionKey,
          id,
        )
        if (tools.length === 0)
          return err(
            `No source "${id}" is available to chat here. Read derive://sources for the ones that are.`,
          )
        return json({
          uri: short_id,
          source: id,
          // Descriptions and schemas are SERVER-SUPPLIED text. They are data for the model to
          // read, never instructions to follow — the same footing as a document's contents.
          tools: tools.map((t) => ({
            name: t.def.name,
            description: t.def.description,
            params: t.def.params,
          })),
        })
      }
      const SK = "derive://skills/"
      if (short_id.startsWith(SK)) {
        const name = short_id.slice(SK.length)
        const skill = CORE_SKILLS.find((s) => s.name === name)
        if (!skill)
          return err(
            `No core skill "${name}". Available: ${CORE_SKILLS.map((s) => s.name).join(", ")}.`,
          )
        return json({ uri: short_id, mimeType: "text/markdown", content: skill.body })
      }
      // The deck starter, resolved here as well as via MCP resources — the skill that
      // points at it is read through this same tool on clients without resource support,
      // so a steer to it must never be a dead link.
      if (short_id.startsWith("derive://decks/")) {
        if (short_id !== "derive://decks/template")
          return err(
            `No deck resource "${short_id}". The starter is derive://decks/template; the guide is derive://skills/decks.`,
          )
        return json({ uri: short_id, mimeType: "text/html", content: DECK_TEMPLATE })
      }
      // A CONTEXT id or name loads the PACKAGE rather than a document: manifest inline,
      // skills and sources as pointers. Same gate as asking — askableContexts is the
      // per-human canUserAskContext check `find` uses — so reading can never surface a
      // context the caller could not already see, and no second access path exists.
      // Returns null when this ref is not a context the caller can reach, so the artifact
      // path stays in charge: only a `ctx_` id short-circuits, and a bare NAME is tried
      // only after the artifact lookup misses (below), so a context can never shadow a doc.
      const contextPackage = async () => {
        if (!actingFor)
          return err(
            "Contexts need a signed-in user. Reconnect with an OAuth login to read or use them.",
          )
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const rows = await askableContexts(t.org, actingFor.id)
        const hit =
          rows.find(({ x }) => x.id === short_id) ??
          rows.find(({ x }) => x.name.toLowerCase() === short_id.trim().toLowerCase())
        if (!hit) return null
        const pkg = await assembleContextPackage(
          ctx.meta,
          hit.x,
          hit.manifest,
          (v) => ctx.sourceText(v),
          runnerOnline(hit.x),
        )
        return json({
          ...pkg,
          how: "The package, opened progressively: the manifest is loaded; skills and sources are pointers — read one by its short_id when a task needs it. To have the context DO work instead, use({context, instruction}).",
        })
      }
      if (short_id.startsWith("ctx_")) {
        const pkg = await contextPackage()
        return (
          pkg ??
          err(
            `No context "${short_id}" you can reach here. Call find to list the contexts you may use.`,
          )
        )
      }
      const BP = "derive://brandprint/"
      let docId = short_id
      if (short_id.startsWith(BP)) {
        const seg = short_id.slice(BP.length)
        if (seg === "reference")
          return json({ uri: short_id, mimeType: "text/markdown", content: BRANDPRINT_REFERENCE })
        if (seg === "template")
          return json({ uri: short_id, mimeType: "text/html", content: BRANDPRINT_TEMPLATE })
        if (seg === "profile") {
          if (!(bpProfile?.state === "live" && profileArt))
            return err(
              "This workspace has no live brand profile yet. Read derive://brandprint/reference and derive://brandprint/template, build the profile, then publish it to derive://brandprint/profile (an Admin's first publish there scaffolds the fact; it lands as a proposal a human approves).",
            )
          const pv = await ctx.meta.getVersion(profileArt.id, profileArt.current_version)
          const body = pv ? await ctx.sourceText(pv) : null
          return json({
            uri: short_id,
            mimeType: "text/html",
            version: profileArt.current_version,
            content: body ?? "",
          })
        }
        docId = seg
      }
      const r = await reach(docId, workspace)
      if (r && "error" in r) return err(r.error)
      // A bare name that matches no artifact may still name a CONTEXT — tried only here,
      // after the artifact lookup, so a context named like a doc can never shadow it.
      if (!r) return (await contextPackage()) ?? notFound(docId)
      const a = r.a
      const n = version ?? a.current_version
      if (n < 1 || n > a.current_version)
        return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
      const v = await ctx.meta.getVersion(a.id, n)
      if (!v) return err(`Version ${n} of "${short_id}" is unavailable.`)
      const url = artifactUrl(ctx.deps.baseUrl, a)

      // The render rung: the version's screenshot, so an agent SEES what it shipped.
      // The preview pipeline computes all three variants per publish (previews.ts);
      // this surfaces whichever one was asked for. Each lives on its own
      // key/status/error triple, so "full"/"marked" failing never blocks "top" (the
      // OG crop og:image unfurls depend on) and vice versa.
      if (render) {
        if (section || lines)
          return err(
            "`render` is a view of the whole version — pass it alone (with `version` for history).",
          )
        const label =
          render === "top"
            ? "the top of the page, 1200x630"
            : render === "full"
              ? "the whole page"
              : "the whole page, with the region map's @N refs drawn on it"
        let variant = pickVariant(v, render)
        // SELF-HEAL on read: a dead-lettered render (a transient storage/browser
        // error that exhausted its retries) used to demand a no-op republish just to
        // re-render. Re-queue it right here instead — reset the variant to pending so
        // the wait loop below can collect the fresh result in this same call, and so
        // a second read doesn't double-enqueue a still-failed-looking row. Bounded:
        // one re-queue per read call; the job keeps its own MAX_ATTEMPTS dead-letter.
        let requeued = false
        // ONLY for the CURRENT version. The render worker discards a job whose version has
        // been superseded (previews.ts marks it done without rendering it), so re-queueing
        // an older one would flip `failed` to `pending` PERMANENTLY: nothing ever renders
        // it, and the heal can't fire again because it only triggers on `failed`. That
        // trades an honest error message for "not ready yet, try again shortly" forever.
        // An old version keeps its failure, which is the truthful answer.
        if (variant.status === "failed" && n === a.current_version) {
          await enqueueRender(ctx.meta, a.id, n)
          if (render === "top")
            await ctx.meta.setVersionPreview(a.id, n, { preview_status: "pending" })
          else await ctx.meta.setVersionPreviewVariant(a.id, n, render, { status: "pending" })
          variant = { ...variant, status: "pending" }
          requeued = true
        }
        // Long-poll: the screenshot lands a few seconds after a publish. When it's neither
        // ready nor failed and the caller passed `wait`, block up to that many seconds
        // (max 30), re-reading the version, before returning the not-ready message — a
        // bounded retry loop so the agent gets the render in one call after a fresh push.
        if (wait && !(variant.status === "ready" && variant.key) && variant.status !== "failed") {
          const deadline = Date.now() + Math.min(Math.max(wait, 0), 30) * 1000
          while (
            Date.now() < deadline &&
            !(variant.status === "ready" && variant.key) &&
            variant.status !== "failed"
          ) {
            await sleep(Math.min(1500, Math.max(0, deadline - Date.now())))
            const refreshed = await ctx.meta.getVersion(a.id, n)
            if (refreshed) variant = pickVariant(refreshed, render)
          }
        }
        if (variant.status === "ready" && variant.key) {
          const shot = await ctx.blobs.get(variant.key)
          if (shot) {
            if (shot.length > IMAGE_INLINE_MAX)
              return json({
                short_id,
                version: n,
                render: "ready",
                bytes: shot.length,
                note: `Too large to inline over MCP — open ${url} to view the page.`,
              })
            return {
              content: [
                {
                  type: "text" as const,
                  text: `render:${render} of "${short_id}" v${n} — ${label} (${shot.length} bytes), as a viewer sees it. The source is untouched; use read/search for the text.`,
                },
                {
                  type: "image" as const,
                  data: toBase64(shot),
                  // SNIFFED, not assumed. Every variant is PNG today, but this used to be
                  // hardcoded, so the label was a claim about the pipeline rather than a
                  // reading of the bytes — and it would go quietly wrong the day any
                  // variant is stored in another format.
                  mimeType: sniffImageType(shot) ?? "image/png",
                },
              ],
            }
          }
        }
        if (variant.status === "failed")
          return err(
            `The render:${render} of "${short_id}" v${n} failed${requeued ? " again on a re-queued attempt" : ""}${variant.error ? ` (${variant.error})` : ""} — the page may still be fine; open ${url} to check. ` +
              // Only the current version re-renders: the worker discards a job for a
              // superseded one, so promising a retry here would be advice that silently
              // does nothing. Say what actually works instead.
              (n === a.current_version
                ? "Reading again re-queues a fresh render."
                : `This is an old version, and only v${a.current_version} re-renders — read it without \`version\` to retry.`),
          )
        if (requeued)
          return err(
            `The render:${render} of "${short_id}" v${n} had failed (${variant.error ?? "transient error"}) — a fresh render was just re-queued. Call read again with \`wait\` (seconds, max 30) to collect it.`,
          )
        return err(
          `The render:${render} of "${short_id}" v${n} isn't ready yet — screenshots are computed a few seconds after publish. Try again shortly, or pass \`wait\` (seconds, max 30) to block for it.`,
        )
      }
      // The data rung: a version's structured facts, queried instead of re-parsed. A
      // whole-version view like `render`, so it can't combine with a within-doc selector.
      if (data !== undefined) {
        if (section || lines || render)
          return err(
            "`data` reads a version's stored facts — pass it alone (with `version` for history), not with section/lines/render.",
          )
        // The TREND read: one slot across a range of versions, in one call and one query.
        // Versions are already the time axis, so this is the whole reason facts exist —
        // "how did this move over thirty days" without fetching thirty versions.
        if (versions !== undefined) {
          if (data === "*")
            return err(
              'Name a single slot to read across versions (data:"checks"); `data:"*"` lists one version\'s facts.',
            )
          const range = parseVersionRange(versions, a.current_version)
          if (!range)
            return err(
              `Bad \`versions\` "${versions}" for "${short_id}" (it has 1..${a.current_version}) — use "1-30", "12", "20-", or "all".`,
            )
          const rows = await ctx.meta.getVersionDataSeries(
            a.id,
            data,
            range.from,
            range.to,
            DATA_SERIES_MAX + 1,
          )
          const truncated = rows.length > DATA_SERIES_MAX
          const kept = truncated ? rows.slice(0, DATA_SERIES_MAX) : rows
          const span = range.to - range.from + 1
          const missing = span - kept.length
          return json({
            short_id,
            fact: data,
            versions: `${range.from}-${range.to} of ${a.current_version}`,
            count: kept.length,
            series: kept.map((r) => ({
              n: r.n,
              at: r.created_at,
              // Stored JSON was validated at publish, so the parsed value is the useful
              // shape; the raw text is the honest fallback if a row ever predates that.
              data: safeJson(r.json),
            })),
            ...(truncated
              ? {
                  note: `More than ${DATA_SERIES_MAX} versions in this range carry "${data}" — this is the oldest ${DATA_SERIES_MAX}. Narrow the range (e.g. versions:"${range.to - DATA_SERIES_MAX + 1}-${range.to}") for the most recent.`,
                }
              : missing > 0
                ? {
                    // A derived name is never "omitted": nobody embeds it. Series reads
                    // serve STORED rows only (a 200-version series must not become 200
                    // blob reads), so old versions are simply underived until each is
                    // read singly — which is the honest instruction to give here.
                    note: isDerivedFactName(data)
                      ? `${missing} version(s) in this range have no stored "${data}". Derived facts fill on a single-version read (read the version without \`versions\`), never in a series — a series must not trigger one derivation per version.`
                      : `${missing} version(s) in this range carry no "${data}" slot — they predate facts or omitted the block.`,
                  }
                : {}),
          })
        }
        if (data === "*") {
          const rows = await ctx.meta.getVersionData(a.id, n)
          return json({
            short_id,
            version: n,
            // One artifact's own inventory is not the adoption surface, so derived rows
            // list here — marked, never mistakable for the author's. The WORKSPACE
            // catalog (find data:"*") is the adoption substrate and excludes them.
            facts: rows.map((r) => ({
              fact: r.slot,
              bytes: r.size_bytes,
              ...(isDerivedFactName(r.slot) ? { derived: true } : {}),
            })),
            ...(rows.length ? {} : { note: absenceNote(null, v, `Version ${n} of "${short_id}"`) }),
          })
        }
        let rows = await ctx.meta.getVersionData(a.id, n, data)
        // LAZY DERIVATION — bounded to exactly here, the single-version named read. A
        // $name that is missing (version predates derivation) or stale (its gen predates
        // THAT deriver's current generation — per-slot, so a $stats bump never re-derives
        // the corpus's $links) recomputes from the version's own bytes: one blob, one
        // pass, value returned now, rows persisted off the response. Series reads and the
        // raw routes serve stored rows only — a 200-version series must never become 200
        // blob reads in one request, and anonymous traffic must not command compute.
        let lazyFilled = false
        if (isDerivedFactName(data) && (!rows[0] || rows[0].gen !== derivedGen(data))) {
          const fresh = await lazyDeriveVersion(ctx, a.id, v, n)
          if (fresh) {
            rows = fresh.filter((r) => r.slot === data)
            lazyFilled = true
          }
        }
        const row = rows[0]
        if (!row) {
          const all = await ctx.meta.getVersionData(a.id, n)
          return err(
            absenceNote(
              data,
              v,
              `"${short_id}" v${n}`,
              all.map((r) => r.slot),
            ),
          )
        }
        // The consumption instrument: the meter counts EMISSION, and adoption is
        // emission AND consumption. One line answers "does anyone query any of this"
        // for the whole layer at once — the same tripwire pattern (#574's
        // derived_view_read) that is the only reason #433 ever got a schedule.
        log.info("fact_read", {
          name: row.slot,
          derived: isDerivedFactName(row.slot),
          surface: "read",
          lazy_fill: lazyFilled,
        })
        const stale = staleNote()
        return json({
          short_id,
          version: n,
          fact: row.slot,
          data: safeJson(row.json),
          ...(stale ? { note: stale } : {}),
        })
      }
      const manifest = await manifestOf(ctx, v)

      if (!manifest) {
        // Single-file artifact.
        const src = (await ctx.sourceText(v)) ?? ""
        const ct = v.content_type
        const meta = {
          short_id,
          title: a.title,
          version: `${n}${n === a.current_version ? " (current)" : ""}`,
          kind: a.kind,
          format: formatLabel(ct, fmt),
          url,
        }
        if (lines) {
          if (section && section !== "*")
            return err("Pass `lines` OR `section`, not both — windowing applies to the whole doc.")
          const body = present(src, ct, fmt)
          const all = body.split("\n")
          const range = parseLineRange(lines, all.length)
          if (!range)
            return err(
              `Bad \`lines\` "${lines}" for "${short_id}" v${n} (1..${all.length}) — use "40-120", "40", or "40-".`,
            )
          const windowed = all.slice(range.from - 1, range.to).join("\n")
          return doc(
            {
              ...meta,
              lines: `${range.from}-${range.to} of ${all.length}`,
              chars: windowed.length,
            },
            clip(windowed),
          )
        }
        // Region read: "@N" pulls the Nth landmark region from the page map, so a
        // headless page's map is directly readable, not just orientation.
        const regionRef = section?.match(/^@(\d+)$/)
        if (regionRef) {
          const idx = Number(regionRef[1])
          const slice = landmarkSlice(src, idx)
          if (slice === null) {
            const count = landmarksOf(src, ct).length
            return err(
              count
                ? `No region @${idx} in "${short_id}" — it has ${count} region(s), @1..@${count}. Read with no \`section\` for the map.`
                : `"${short_id}" has no landmark regions — read a heading \`section\`, a \`lines\` range, or the whole doc.`,
            )
          }
          const body = present(slice, ct, fmt)
          const count = landmarksOf(src, ct).length
          return doc(
            { ...meta, section: `@${idx} of ${count} regions`, chars: body.length },
            clip(body),
          )
        }
        if (section && section !== "*") {
          const slice = sectionOf(src, ct, section)
          if (slice === null) {
            const slugs = outlineOf(src, ct).map((s) => s.slug)
            return err(
              slugs.length
                ? `No section "${section}" in "${short_id}" v${n} — sections: ${slugs.join(", ")}.`
                : `"${short_id}" has no headings to section by — read it whole (omit \`section\`).`,
            )
          }
          // Also feeds clipDoc's steer below — a single section can itself be huge
          // (e.g. the last one, which runs to </body>), so it needs the same
          // MAX_CHARS ceiling the whole-doc path gets, not an unbounded return.
          const outline = outlineOf(src, ct)
          const i = outline.findIndex((s) => s.slug === section)
          const body = present(slice, ct, fmt)
          return doc(
            {
              ...meta,
              section: `${section} (${i + 1} of ${outline.length})`,
              chars: body.length,
            },
            clipDoc(body, outline),
          )
        }
        // Tripwire (evidence for the derived-view cache decision, #433): time the
        // HTML→markdown conversion on the whole-doc read path — the exact recompute that
        // PR would cache — and log source size + cost + whether it crosses that PR's
        // 150K-char gate. One line, no schema; a week of these numbers says whether the
        // cache is worth landing or closing. Only for HTML sources (markdown `present` is
        // a near-noop and would just be log noise).
        const tConv = Date.now()
        const body = present(src, ct, fmt)
        if (baseType(ct) === "text/html")
          log.info("derived_view_read", {
            short_id,
            chars: src.length,
            ms: Date.now() - tConv,
            fmt,
            gate_150k: src.length >= 150_000,
          })
        if (!section && body.length > FULL_DOC_MAX) {
          const outline = outlineOf(src, ct)
          if (outline.length)
            return json({
              short_id,
              title: a.title,
              kind: a.kind,
              version: n,
              source: ct,
              format: fmt,
              doc_chars: body.length,
              url,
              sections: outline,
              next: 'Large document — call read again with a `section` slug for just that part, or section:"*" for the full clipped text. To revise it, publish with `edits` instead of resending content.',
            })
          // No headings — a designed, headless HTML page (dashboard, card grid) still
          // has landmark structure. Return that map so the agent can search/window in
          // rather than blindly dumping a clipped wall of text.
          const regions = landmarksOf(src, ct)
          if (regions.length)
            return json({
              short_id,
              title: a.title,
              kind: a.kind,
              version: n,
              source: ct,
              format: fmt,
              doc_chars: body.length,
              url,
              regions: regions
                .slice(0, PAGE_MAP_MAX)
                .map((region, i) => ({ ref: `@${i + 1}`, ...region })),
              ...(regions.length > PAGE_MAP_MAX
                ? { more_regions: regions.length - PAGE_MAP_MAX }
                : {}),
              next: 'This page has no headings — it is mapped by region above. Read a region directly with its `ref` (e.g. section:"@1"), or `search` for a term. section:"*" forces the full clipped text.',
            })
          // Truly unstructured — fall through to a plain (clipped) return, reusing the
          // already-computed (empty) outline instead of asking again.
          return doc({ ...meta, chars: body.length }, clipDoc(body, outline))
        }
        // Under FULL_DOC_MAX: clipDoc's MAX_CHARS ceiling is far above this body's
        // size, so it can never truncate — skip computing an outline it won't use.
        const outline = body.length > MAX_CHARS ? outlineOf(src, ct) : []
        return doc({ ...meta, chars: body.length }, clipDoc(body, outline))
      }

      // Bundle.
      const pages = Object.keys(manifest.files).map(cleanPath)
      if (!section) {
        // Outline: every page, plus sizes + headings for the shallowest text pages
        // (each costs a blob read — the manifest has no sizes — so cap the sweep).
        const textPages = pages
          .filter((p) => isTextType(manifest.files[p]?.type ?? manifest.files[`/${p}`]?.type ?? ""))
          .sort((x, y) => x.split("/").length - y.split("/").length || x.localeCompare(y))
        const entry = cleanPath(manifest.entry)
        const inspect = [entry, ...textPages.filter((p) => p !== entry)].slice(0, 25)
        // The blob reads are independent — fetch them all at once instead of one
        // round trip at a time (up to 25 pages, otherwise serialized latency).
        const detailEntries = await Promise.all(
          inspect.map(
            async (p): Promise<[string, { chars: number; headings: OutlineSection[] }] | null> => {
              const file = manifest.files[p] ?? manifest.files[`/${p}`]
              if (!file) return null
              const bytes = await ctx.blobs.get(file.key)
              if (!bytes) return null
              const text_ = new TextDecoder().decode(bytes)
              return [
                p,
                {
                  chars: toMarkdown(text_, file.type).length,
                  headings: outlineOf(text_, file.type),
                },
              ]
            },
          ),
        )
        const detail = new Map(detailEntries.filter((e) => e !== null))
        return json({
          short_id,
          title: a.title,
          kind: "bundle",
          version: n,
          entry,
          url,
          pages: pages.map((p) => {
            const type = manifest.files[p]?.type ?? manifest.files[`/${p}`]?.type
            const d = detail.get(p)
            return {
              path: p,
              type,
              ...(d
                ? {
                    chars: d.chars,
                    headings: d.headings.map((h) => ({
                      slug: h.slug,
                      level: h.level,
                      text: h.text,
                    })),
                  }
                : {}),
            }
          }),
          next: "Call read again with a `section` (a page path above, optionally page.html#slug for one heading's part) for content.",
        })
      }

      // A page (optionally page#slug — split on the LAST '#'). "#*" forces the
      // page's full (clipped) content, the same bypass single-file section:"*" is.
      const hash = section.lastIndexOf("#")
      const pagePath = hash > 0 ? section.slice(0, hash) : section
      const rawSlug = hash > 0 ? section.slice(hash + 1) : null
      const slug = rawSlug === "*" ? null : rawSlug
      const forceFull = rawSlug === "*"
      const file = manifest.files[pagePath] ?? manifest.files[`/${cleanPath(pagePath)}`]
      if (!file) return err(`No page "${pagePath}" in "${short_id}". Pages: ${pages.join(", ")}.`)
      const bytes = await ctx.blobs.get(file.key)

      // An image page is an IMAGE, not text: inline it as a real image block (small
      // ones), or point at the served URL. Never decode PNG bytes as a string.
      if (baseType(file.type).startsWith("image/")) {
        const pageUrl = `${ctx.deps.baseUrl}/raw/${short_id}/v/${n}/${cleanPath(pagePath)}`
        const size = bytes?.length ?? 0
        if (!bytes || size > IMAGE_INLINE_MAX)
          return json({
            short_id,
            section: cleanPath(pagePath),
            type: file.type,
            bytes: size,
            url: pageUrl,
            note: "Too large to inline over MCP — open the url to view it.",
          })
        return {
          content: [
            {
              type: "text" as const,
              text: `${cleanPath(pagePath)} (${file.type}, ${size} bytes) — served at ${pageUrl}`,
            },
            { type: "image" as const, data: toBase64(bytes), mimeType: baseType(file.type) },
          ],
        }
      }

      const raw = bytes ? new TextDecoder().decode(bytes) : ""
      const isText = isTextType(file.type)
      const meta = {
        short_id,
        title: a.title,
        version: `${n}${n === a.current_version ? " (current)" : ""}`,
        kind: "bundle",
        url,
        type: file.type,
      }
      if (lines) {
        if (slug)
          return err("Pass `lines` OR a #slug, not both — windowing applies to a whole page.")
        const pageBody = isText ? present(raw, file.type, fmt) : raw
        const all = pageBody.split("\n")
        const range = parseLineRange(lines, all.length)
        if (!range)
          return err(
            `Bad \`lines\` "${lines}" for "${cleanPath(pagePath)}" (1..${all.length}) — use "40-120", "40", or "40-".`,
          )
        const windowed = all.slice(range.from - 1, range.to).join("\n")
        return doc(
          {
            ...meta,
            section: cleanPath(pagePath),
            lines: `${range.from}-${range.to} of ${all.length}`,
            chars: windowed.length,
          },
          clip(windowed),
        )
      }
      if (slug) {
        if (!isText)
          return err(`"${pagePath}" is ${file.type} — heading sections only apply to text pages.`)
        const slice = sectionOf(raw, file.type, slug)
        if (slice === null) {
          const slugs = outlineOf(raw, file.type).map((s) => s.slug)
          return err(
            slugs.length
              ? `No section "${slug}" in "${pagePath}" — sections: ${slugs.join(", ")}.`
              : `"${pagePath}" has no headings to section by — read the whole page.`,
          )
        }
        const outline = outlineOf(raw, file.type)
        const body = present(slice, file.type, fmt)
        return doc(
          {
            ...meta,
            section: `${cleanPath(pagePath)}#${slug}`,
            format: formatLabel(file.type, fmt),
            chars: body.length,
          },
          clipDoc(body, outline),
        )
      }
      // css/js/json/etc always return source — conversion only applies to text pages.
      const body = isText ? present(raw, file.type, fmt) : raw
      // Same outline-first threshold the single-file path applies: a bundle page can
      // be just as large as a standalone doc, so it gets the same treatment instead
      // of only ever cutting at the much higher MAX_CHARS ceiling below.
      if (isText && !slug && !forceFull && body.length > FULL_DOC_MAX) {
        const outline = outlineOf(raw, file.type)
        if (outline.length)
          return json({
            short_id,
            title: a.title,
            kind: "bundle",
            version: n,
            section: cleanPath(pagePath),
            source: file.type,
            format: fmt,
            doc_chars: body.length,
            url,
            sections: outline,
            next: `Large page — call read again with \`section\` set to "${cleanPath(pagePath)}#slug" for just that part, or "${cleanPath(pagePath)}#*" for the full clipped text.`,
          })
        const regions = landmarksOf(raw, file.type)
        if (regions.length)
          return json({
            short_id,
            title: a.title,
            kind: "bundle",
            version: n,
            section: cleanPath(pagePath),
            source: file.type,
            format: fmt,
            doc_chars: body.length,
            url,
            regions: regions.slice(0, PAGE_MAP_MAX),
            ...(regions.length > PAGE_MAP_MAX
              ? { more_regions: regions.length - PAGE_MAP_MAX }
              : {}),
            next: `This page has no headings — it is mapped by region above. Use \`search\` to find a term, then read with \`lines:"from-to"\` to window that part, or "${cleanPath(pagePath)}#*" for the full clipped text.`,
          })
        return doc(
          { ...meta, section: cleanPath(pagePath), chars: body.length },
          clipDoc(body, outline),
        )
      }
      const outline = isText && body.length > MAX_CHARS ? outlineOf(raw, file.type) : []
      return doc(
        {
          ...meta,
          section: cleanPath(pagePath),
          format: isText ? formatLabel(file.type, fmt) : file.type,
          chars: body.length,
        },
        clipDoc(body, outline),
      )
    },
  )
}
