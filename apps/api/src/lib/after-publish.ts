// The side-effect chain every new live version runs, in ONE place. A version reaches
// "live" from three entry points — the HTTP publish route, the MCP publish tool, and a
// version restore — and each used to hand-copy the same fan-out. When they drift, an MCP
// publish silently skips webhooks (the exact bug this consolidation exists to prevent from
// recurring).
//
// `lint:api` forbids constructing a raw `version.published` bus event or the follower
// fan-out anywhere but this file — every publish path must route through here.

import {
  type ArtifactRecord,
  type BlobStore,
  type BundleManifest,
  DECK_CONTENT_TYPE,
  type DynamicValue,
  deriveFacts,
  dynamicValueBytes,
  emptyDynamicValue,
  FACT_GEN,
  inferredSkillRelationRefs,
  isAuthoredFactType,
  isBundleContentType,
  isHtmlLike,
  type MetaStore,
  type NewVersionData,
  newId,
  parseDynamicBindings,
  parseFacts,
  type SearchIndex,
  SKILL_CONTENT_TYPE,
  SKILL_SIDECAR_PATH,
  type VersionRecord,
  validateSkillDefinition,
} from "@derive/core"
import type { Backplane } from "../bus"
import type { WebhookEvent } from "../events"
import { log } from "../log"
import { type Summarizer, sanitizeSummary, summaryInput } from "../summarizer"
import { publishSweepEvents } from "./anchor-sweep"
import { fanOutNewContentMentions } from "./content-mentions"
import { documentStructure } from "./doc-structure-cache"
import { EMAIL_LAYOUT_FACT } from "./email-layout"
import { indexArtifactVersion, isTextType } from "./search"
import { recordThreadResolution } from "./thread-actions"
import { indexWorkflowSkillLinks } from "./workflow-skill-links"

/** The realtime + render + re-anchor core shared by every version bump (publish, restore):
 *  announce the new version so open tabs live-reload, enqueue its preview
 *  render, then re-anchor existing threads against the new content. Webhook delivery and
 *  follower fan-out are NOT here — they differ per path and live in {@link afterPublish}. */
export interface VersionBumpDeps {
  meta: MetaStore
  blobs: BlobStore
  bus: Backplane
  /** Preview render. Kept off the request path by the CALLER's `background()` (waitUntil on
   *  Workers, inline on Node), so awaiting here costs a deployment nothing and stops the write
   *  being orphaned. Optional so a caller without render access (a test) omits it. */
  notifyRender?: (a: ArtifactRecord, n: number) => void | Promise<void>
  /** The optional dense/semantic search index (Cloudflare edge). When bound, every version
   *  bump keeps it current alongside the lexical FTS — best-effort, in indexArtifactVersion. */
  search?: SearchIndex
  /** Off-hot-path escape hatch (waitUntil on Workers, inline on Node), used for the data-slot
   *  history backfill — the one bump-time job that can cost dozens of blob reads. Optional
   *  because restore reaches this without one; it just pays it inline. */
  background?: (work: Promise<unknown>) => Promise<void>
  /** Generates the one-line summary every unfurl surface describes this version with. Optional
   *  and normally ABSENT: only the edge binds a model here, so self-host publishes exactly as
   *  before and every consumer falls back to the inventory line. */
  summarize?: Summarizer
}

export const emitVersionBump = async (
  deps: VersionBumpDeps,
  artifact: ArtifactRecord,
  version: VersionRecord,
  preparedSource?: string,
  previousSearchSource?: { source: string; contentType: string | null; title: string | null },
  dynamicSeedFrom?: number,
): Promise<NewVersionData[]> => {
  const { meta, blobs, bus, notifyRender } = deps
  bus.publish(artifact.id, { type: "version.published", n: version.n, message: version.message })
  await notifyRender?.(artifact, version.n)
  await publishSweepEvents(meta, blobs, bus, artifact.id, version, preparedSource)
  // Keep the workspace search index current for the new live version. Best-effort:
  // a search-index hiccup must never fail a publish that already succeeded, so log
  // and move on — the artifact re-indexes on its next publish (and the backfill
  // sweep is the safety net for anything missed).
  try {
    await indexArtifactVersion(
      meta,
      blobs,
      artifact,
      version,
      deps.search,
      preparedSource,
      previousSearchSource,
    )
  } catch (err) {
    log.error("search index update failed", { artifact: artifact.id, err: String(err) })
  }
  // Extract this version's structured facts into queryable rows. Sibling to search
  // indexing — same "every publish/restore" reach, same best-effort
  // contract (a hiccup must never fail a publish that already went live). The publish
  // response already advises about any UNstored slot via publishAdvisories; this is the
  // persistence half, and both call the one parser so they can't disagree.
  let storedRows: NewVersionData[] = []
  try {
    storedRows = await extractVersionData(meta, blobs, version, deps.background, preparedSource)
  } catch (err) {
    log.error("data-slot extraction failed", { artifact: artifact.id, err: String(err) })
  }
  // Give this version its dynamic tables and figures their START POINT: each binding the
  // document declares gets a slot seeded from the previous version's latest value (or
  // from the inline placeholder for a brand-new name). Same best-effort contract as the
  // facts pass above: a hiccup here must never fail a publish that already went live, and
  // a page whose slot is missing renders its placeholder rather than nothing.
  try {
    await seedDynamicSlots(meta, blobs, version, dynamicSeedFrom, preparedSource)
  } catch (err) {
    log.error("dynamic slot seeding failed", { artifact: artifact.id, err: String(err) })
  }
  // Skill relations are a query index over immutable bundle bytes, not another definition.
  // Run on every canonical version bump (publish, restore, agent edit) so no surface can drift.
  try {
    await indexSkillVersion(meta, blobs, artifact, version)
  } catch (err) {
    log.error("skill relation indexing failed", {
      artifact: artifact.id,
      n: version.n,
      err: String(err),
    })
  }
  // A Workflow's Context refs resolve to exact Skill pins. Materialize those links on
  // every version bump so the graph and every Skill can navigate to each other without
  // relying on a one-off migration or parsing human prose in the browser.
  try {
    await indexWorkflowSkillLinks(meta, blobs, artifact, version, storedRows)
  } catch (err) {
    log.error("workflow skill link indexing failed", {
      artifact: artifact.id,
      n: version.n,
      err: String(err),
    })
  }
  // What this version SAYS, for the cards that describe it to someone who has not opened it.
  // Third sibling of the two above and the same contract in every respect: a failure logs and
  // the publish stands, because a link preview is never worth failing a write that already
  // succeeded. Off the hot path via `background` — on Workers that is waitUntil; on Node it
  // awaits, which costs nothing there because Node binds no summarizer.
  if (deps.summarize) {
    const work = summarizeVersion(
      meta,
      blobs,
      deps.summarize,
      artifact,
      version,
      preparedSource,
    ).catch((err) =>
      log.error("version summary failed", {
        artifact: artifact.id,
        n: version.n,
        err: String(err),
      }),
    )
    await (deps.background ? deps.background(work) : work)
  }
  return storedRows
}

export const indexSkillVersion = async (
  meta: MetaStore,
  blobs: BlobStore,
  artifact: ArtifactRecord,
  version: VersionRecord,
): Promise<void> => {
  if (version.content_type !== SKILL_CONTENT_TYPE) return
  const manifestBytes = await blobs.get(version.blob_key)
  if (!manifestBytes) throw new Error("skill manifest blob missing")
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
  const skillKey = manifest.files[manifest.entry]?.key
  if (!skillKey) throw new Error("SKILL.md missing from skill manifest")
  const skillBytes = await blobs.get(skillKey)
  if (!skillBytes) throw new Error("SKILL.md blob missing")
  const sidecarKey = manifest.files[SKILL_SIDECAR_PATH]?.key
  const sidecarBytes = sidecarKey ? await blobs.get(sidecarKey) : null
  const checked = validateSkillDefinition(
    new TextDecoder().decode(skillBytes),
    sidecarBytes ? new TextDecoder().decode(sidecarBytes) : null,
  )
  if (checked.errors.length > 0) throw new Error(checked.errors.join("; "))
  const declared = Object.entries(checked.sidecar?.relations ?? {}).flatMap(([kind, refs]) =>
    (refs ?? []).map((ref) => ({ kind: kind as "requires" | "extends" | "recommends", ref })),
  )
  const skillMd = new TextDecoder().decode(skillBytes)
  const inferred = inferredSkillRelationRefs(skillMd)
  const targetIds = [
    ...new Set([...declared.map(({ ref }) => ref.id), ...inferred.map((ref) => ref.id)]),
  ]
  const targets = await meta.getByShortIds(targetIds)
  const byShortId = new Map(targets.map((target) => [target.short_id, target]))
  const relations = []
  for (const { kind, ref } of declared) {
    const target = byShortId.get(ref.id)
    if (!target || target.org_id !== artifact.org_id) {
      log.warn("skill relation target unavailable", {
        artifact: artifact.id,
        n: version.n,
        target: ref.id,
      })
      continue
    }
    const targetVersion = await meta.getVersion(target.id, ref.version)
    if (targetVersion?.content_type !== SKILL_CONTENT_TYPE) {
      log.warn("skill relation target version is not a Skill", {
        artifact: artifact.id,
        n: version.n,
        target: ref.id,
        target_version: ref.version,
      })
      continue
    }
    relations.push({
      id: newId("skr"),
      org_id: artifact.org_id,
      source_artifact_id: artifact.id,
      source_version: version.n,
      target_artifact_id: target.id,
      target_version: ref.version,
      kind,
    })
  }
  // Explicit sidecar relationships carry authored semantics and always win. A plain link in
  // SKILL.md becomes the intentionally weaker `references` edge, pinned to the linked version
  // when present and otherwise to the target's current version at publication time.
  const declaredTargets = new Set(declared.map(({ ref }) => ref.id))
  for (const ref of inferred) {
    const target = byShortId.get(ref.id)
    if (!target || target.id === artifact.id || target.org_id !== artifact.org_id) continue
    if (declaredTargets.has(ref.id)) continue
    const targetVersionNumber = ref.version ?? target.current_version
    const targetVersion = await meta.getVersion(target.id, targetVersionNumber)
    if (targetVersion?.content_type !== SKILL_CONTENT_TYPE) continue
    relations.push({
      id: newId("skr"),
      org_id: artifact.org_id,
      source_artifact_id: artifact.id,
      source_version: version.n,
      target_artifact_id: target.id,
      target_version: targetVersionNumber,
      kind: "references" as const,
    })
  }
  await meta.replaceSkillRelations(artifact.org_id, artifact.id, version.n, relations)
}

/** sha256 of the exact text handed to the model, hex. Web Crypto only — this runs on Workers
 *  (see lib/capability-token.ts for the same constraint). */
const srcHash = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Generate and store this version's summary, or record why not.
 *
 * The hash gate is what makes this affordable rather than merely possible. Agents republish
 * constantly and most publishes do not change what a document is ABOUT — a typo fix, a
 * re-render, a formatting pass. Comparing the model input against the previous version's stored
 * hash turns those into a copy-forward, so the model is paid for a change in meaning rather than
 * for a change in bytes.
 *
 * It compares against n-1 ONLY, which is deliberate and does have a hole: restoring an older
 * version republishes content that matched some version further back, and that misses. Closing
 * it would mean either a walk or an index on the hash, and a restore is rare enough that one
 * model call is the cheaper answer than either.
 *
 * Every exit logs its reason. "The card says nothing and I cannot tell why" is exactly the shape
 * of bug that cost a day on the unfurl ladder, and one line naming the rung is what prevents it.
 */
const summarizeVersion = async (
  meta: Pick<MetaStore, "setVersionSummary" | "getVersion">,
  blobs: BlobStore,
  summarizer: Summarizer,
  artifact: ArtifactRecord,
  version: VersionRecord,
  preparedSource?: string,
): Promise<void> => {
  const skip = (reason: string) =>
    log.info("version summary skipped", { artifact: artifact.id, n: version.n, reason })
  // Bundles and binary uploads have no prose to summarize. `isTextType` is the same predicate
  // search indexing uses, so a new text-ish kind (the deck type was one) is handled in one place.
  if (!isTextType(version.content_type)) return skip("not a text version")
  let source = preparedSource
  if (source === undefined) {
    const bytes = await blobs.get(version.blob_key)
    if (!bytes) return skip("blob missing")
    source = new TextDecoder().decode(bytes)
  }
  const text = summaryInput(source, version.content_type)
  if (!text) return skip("too little prose to summarize")

  const hash = await srcHash(text)
  // Only the immediately previous version is consulted. Walking further back would catch a
  // revert-to-two-ago, at the cost of a read per version on every publish forever; one read
  // covers the case this exists for (a republish that changes nothing that matters).
  const prev = version.n > 1 ? await meta.getVersion(artifact.id, version.n - 1) : null
  if (prev?.summary && prev.summary_src_hash === hash) {
    await meta.setVersionSummary(artifact.id, version.n, {
      summary: prev.summary,
      summary_src_hash: hash,
    })
    return skip("unchanged since previous version, copied forward")
  }

  const raw = await summarizer.summarize({ title: artifact.title, text })
  // Sanitized HERE rather than inside the summarizer: this is where every implementation of that
  // port converges on one column, so it is the only place the invariant can actually be held.
  // The value is derived from document content and reaches SVG markup, an HTML attribute and
  // Slack mrkdwn downstream.
  const summary = raw ? sanitizeSummary(raw) : null
  if (!summary) return skip("model returned nothing usable")
  await meta.setVersionSummary(artifact.id, version.n, { summary, summary_src_hash: hash })
  log.info("version summary generated", {
    artifact: artifact.id,
    n: version.n,
    chars: summary.length,
  })
}

/** Extract a single-file HTML/markdown version's facts and persist them (see
 *  @derive/core data-facts). Decks may carry the one operational fact their export path
 *  consumes (`email-layout`); arbitrary authored deck facts stay excluded. Writes only when at
 *  least one slot parsed — a fresh version has no prior rows, so there is nothing to clear when
 *  it has none. */
const extractVersionData = async (
  meta: Pick<MetaStore, "setVersionData" | "getVersionData" | "getVersion">,
  blobs: BlobStore,
  version: VersionRecord,
  background?: (work: Promise<unknown>) => Promise<void>,
  preparedSource?: string,
): Promise<NewVersionData[]> => {
  const ct = version.content_type
  // AUTHORED facts stay HTML/markdown only. DERIVED facts also cover decks.
  //
  // A deck types as `text/x-derive-deck`, so this literal check excluded it from the whole
  // facts pipeline — correct while every fact was author-embedded (a deck is a deck, not a
  // place to park numbers), and wrong the moment `$map` shipped, because a deck's structure
  // is exactly what a map is for. Found on the preview: a freshly published deck carried no
  // $map at all. Same second-order blast radius the sniff fix documented — typing decks
  // correctly moves them off every path that asks `content_type === "text/html"`.
  const authored = isAuthoredFactType(ct)
  if (!authored && !isHtmlLike(ct)) return []
  let source = preparedSource
  if (source === undefined) {
    const bytes = await blobs.get(version.blob_key)
    if (!bytes) return []
    source = new TextDecoder().decode(bytes)
  }
  const baseType = ct.split(";")[0]?.trim()
  const facts = authored
    ? parseFacts(source, ct).facts
    : baseType === DECK_CONTENT_TYPE
      ? parseFacts(source, "text/html").facts.filter((fact) => fact.slot === EMAIL_LAYOUT_FACT)
      : []
  // Derived facts ($outline/$links/$stats) ride the same pass over bytes already decoded:
  // the host's mechanical reading, in the namespace the author grammar can't reach. They
  // are cache entries with names — recomputable, never counted, never rewarded — so each
  // row carries ITS OWN deriver's generation, not the extraction grammar's and not a
  // host-wide one (a shared constant would make a $stats change invalidate every $links row).
  let structure: ReturnType<typeof documentStructure> | undefined
  try {
    structure = documentStructure(version.blob_key, source, ct)
  } catch {
    // Ambiguous structure omits $map exactly as before. Other derived facts still persist.
  }
  const derived = deriveFacts(source, ct, { structure })
  const rows = [
    ...facts.map((s) => ({
      id: newId("vd"),
      slot: s.slot,
      json: s.json,
      size_bytes: s.bytes,
      gen: FACT_GEN,
    })),
    ...derived.map((s) => ({
      id: newId("vd"),
      slot: s.slot,
      json: s.json,
      size_bytes: s.bytes,
      gen: s.gen,
    })),
  ]
  if (rows.length === 0) return []
  // ONE setVersionData call: it is a full replace, so asserted and derived must land
  // together or the second write erases the first — the same union trap the backfill
  // below documents for itself.
  await meta.setVersionData(version.artifact_id, version.n, rows)
  if (facts.length === 0) return rows
  // Off the hot path where the caller can: the walk-back costs a blob read per version.
  // ASSERTED names only — old versions get their derived rows lazily on first read, so a
  // backfill walk never pays derivation for versions nobody asks about.
  const backfill = backfillNewSlots(
    meta,
    blobs,
    version,
    facts.map((s) => s.slot),
  )
  await (background ? background(backfill) : backfill)
  return rows
}

/** Seed every dynamic slot a just-published version declares (see @derive/core
 *  dynamic-data.ts). `seedFrom` names the version whose LATEST data starts this one;
 *  a publish copies forward from n-1, a restore from the version being restored, so a
 *  restore of v3 as v7 starts v7 from v3's final numbers. Insert-if-absent throughout:
 *  a replayed bump (the amend path re-runs this for the same n) and a write that raced
 *  the seed both leave the row that exists alone. */
const seedDynamicSlots = async (
  meta: Pick<MetaStore, "getDynamicSlot" | "insertDynamicSlot" | "appendDynamicRevision">,
  blobs: BlobStore,
  version: VersionRecord,
  seedFrom: number | undefined,
  preparedSource?: string,
): Promise<void> => {
  const ct = version.content_type
  // Bundles carry no bindings (their blob is a manifest), so skip the blob read entirely.
  if (isBundleContentType(ct)) return
  let source = preparedSource
  if (source === undefined) {
    const bytes = await blobs.get(version.blob_key)
    if (!bytes) return
    source = new TextDecoder().decode(bytes)
  }
  const { bindings } = parseDynamicBindings(source, ct)
  if (bindings.length === 0) return
  const from = seedFrom ?? version.n - 1
  const at = new Date().toISOString()
  for (const binding of bindings) {
    const prev =
      from >= 1 ? await meta.getDynamicSlot(version.artifact_id, from, binding.name) : null
    const carried = prev && prev.kind === binding.kind
    const value: DynamicValue = carried
      ? (JSON.parse(prev.json) as DynamicValue)
      : (binding.seed ?? emptyDynamicValue(binding.kind))
    const json = JSON.stringify(value)
    const row = {
      id: newId("dyn"),
      artifact_id: version.artifact_id,
      n: version.n,
      name: binding.name,
      kind: binding.kind,
      json,
      size_bytes: dynamicValueBytes(value),
      revision: 0,
      updated_by_id: "system",
      updated_by_name: "Derive",
      updated_at: at,
    }
    const inserted = await meta.insertDynamicSlot(row)
    if (!inserted) continue
    await meta.appendDynamicRevision({
      id: newId("dynrev"),
      artifact_id: row.artifact_id,
      n: row.n,
      name: row.name,
      revision: 0,
      json,
      size_bytes: row.size_bytes,
      actor_id: "system",
      actor_name: "Derive",
      note: carried ? `seeded from v${from}` : "seeded from the document",
      created_at: at,
    })
  }
}

/** Versions walked back when a fact first appears. Bounded because each one costs a blob
 *  read: enough to cover a month of daily publishing, short of scanning an artifact with
 *  a thousand versions on a whim. */
const BACKFILL_MAX_VERSIONS = 50

/**
 * When a fact appears on an artifact for the FIRST time, extract it from the versions
 * that came before.
 *
 * Extraction runs at publish, so without this a fact's series begins the day it was added
 * and the history is silently lost — the first sharp edge anyone adding a fact to a real
 * artifact meets, and the one that made this repo's own fourteen-version demo come back
 * empty. The blocks were usually already in those older pages (a page that carried its
 * figures before facts existed still carries them); nothing had ever read them.
 *
 * Fires only on the transition — a fact present in the previous version is already being
 * tracked, so an ordinary republish does no extra work. Merges rather than replaces, since
 * setVersionData is a full replace and an older version may already have other facts.
 * Best-effort and bounded: this must never fail or noticeably slow a publish that already
 * went live.
 */
const backfillNewSlots = async (
  meta: Pick<MetaStore, "setVersionData" | "getVersionData" | "getVersion">,
  blobs: BlobStore,
  version: VersionRecord,
  slotNames: string[],
): Promise<void> => {
  if (version.n <= 1 || slotNames.length === 0) return
  try {
    const previous = await meta.getVersionData(version.artifact_id, version.n - 1)
    const alreadyTracked = new Set(previous.map((r) => r.slot))
    const fresh = new Set(slotNames.filter((s) => !alreadyTracked.has(s)))
    if (fresh.size === 0) return

    const oldest = Math.max(1, version.n - BACKFILL_MAX_VERSIONS)
    let filled = 0
    for (let n = version.n - 1; n >= oldest; n--) {
      const old = await meta.getVersion(version.artifact_id, n)
      if (!old) continue
      const ct = old.content_type
      if (ct !== "text/html" && ct !== "text/markdown" && !isHtmlLike(ct)) continue
      const bytes = await blobs.get(old.blob_key)
      if (!bytes) continue
      const found = parseFacts(new TextDecoder().decode(bytes), ct).facts.filter((s) =>
        fresh.has(s.slot),
      )
      if (!found.length) continue
      // Union with whatever that version already has: setVersionData replaces the row set.
      const existing = await meta.getVersionData(version.artifact_id, n)
      const have = new Set(existing.map((r) => r.slot))
      const additions = found.filter((s) => !have.has(s.slot))
      if (!additions.length) continue
      await meta.setVersionData(version.artifact_id, n, [
        ...existing.map((r) => ({
          id: r.id,
          slot: r.slot,
          json: r.json,
          size_bytes: r.size_bytes,
          gen: r.gen,
        })),
        ...additions.map((s) => ({
          id: newId("vd"),
          slot: s.slot,
          json: s.json,
          size_bytes: s.bytes,
          gen: FACT_GEN,
        })),
      ])
      filled++
    }
    // Say what was recovered and how far back it reached. On Workers this runs inside
    // waitUntil, whose budget can end it mid-walk: the result is a SHORTER history, never a
    // wrong one, but without this line a truncated backfill and a complete one look
    // identical afterwards. `truncated` marks the case where an older version may still be
    // unfilled because the cap, not the content, stopped the walk.
    if (filled)
      log.info("data-slot backfill", {
        artifact: version.artifact_id,
        facts: [...fresh],
        versions_filled: filled,
        oldest_scanned: oldest,
        truncated: oldest > 1,
      })
  } catch (err) {
    log.error("data-slot backfill failed", { artifact: version.artifact_id, err: String(err) })
  }
}

export interface AfterPublishDeps extends VersionBumpDeps {
  notify: (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) => Promise<void>
  /** Run after-response work off the hot path (webhook enqueue, follower fan-out). */
  background: (work: Promise<unknown>) => Promise<void>
  /** The deployment origin for document-body mention emails. Optional only for focused
   * store-level callers; every app entry point supplies it. */
  baseUrl?: string
}

export interface AfterPublishOpts {
  /** First version of a brand-new artifact — gates the one-time follower fan-out (a
   *  republish must not re-notify followers on every edit). */
  isNew: boolean
  /** The human behind the publish (a session user, or an agent's registrant). Their
   *  followers are the ones who care; null for a truly headless publish. */
  onBehalf: string | null
  /** Thread ids to resolve in the same call (a live publish that fixes feedback). The
   *  caller has already validated these belong to `artifact`. */
  resolves?: string[]
  /** The ACTING principal's id — an agent's own id, not the human it acts for. Distinct from
   *  `onBehalf` on purpose: `version.author_id` is the on-behalf-of human (routes/artifacts.ts
   *  says so explicitly, "never an agent principal"), so using it to classify the actor made
   *  every agent publish look human and sent it to the "people only" channels while the
   *  "agents only" ones got nothing. Null for a headless publish. */
  actorId?: string | null
  /** The acting principal's display name, recorded with `actorId` on every thread this
   *  publish resolves. */
  actorName?: string | null
  /** Exact trusted source that produced this single-file version. Publish callers already
   *  hold it, so the bump pipeline can index, derive, sweep, and notify without reading the
   *  new multi-megabyte blob back from storage. Omit for restores, bundles, and any caller
   *  without the bytes; every consumer retains its exact blob fallback. */
  preparedSource?: string
  /** Previous exact source captured while materializing an edit. Search can skip all index
   *  work when its bounded projection and title are unchanged. */
  previousSearchSource?: { source: string; contentType: string | null; title: string | null }
  /** The version whose latest dynamic data seeds this one. Omitted (every ordinary
   *  publish): the previous version. A restore passes the restored version's number, so
   *  the new version starts from the numbers that version ended with. */
  dynamicSeedFrom?: number
}

/**
 * Everything that must happen after a publish makes a version live, canonicalized so the
 * HTTP route, the MCP tool, and restore can't drift: fire the `version.published` webhook,
 * fan out to the publisher's followers (new + human + public only), resolve any threads
 * named in the call, then run the shared realtime/render/re-anchor bump. Returns the thread
 * ids and stored data rows, so publish receipts need no immediate read-back.
 */
export const afterPublish = async (
  deps: AfterPublishDeps,
  artifact: ArtifactRecord,
  version: VersionRecord,
  opts: AfterPublishOpts,
): Promise<{ resolved: string[]; storedRows: NewVersionData[] }> => {
  const { meta, bus, notify, background } = deps
  await notify(artifact, "version.published", {
    version: version.n,
    message: version.message,
    author: version.author,
    actor_id: opts.actorId ?? null,
  })
  // Fan out to the publisher's followers: "someone you follow published X". Gated to a
  // known HUMAN behind the publish (an agent publish fans out to the followers of the
  // person it acts for), a publicly-listed artifact (a follow never surfaces a private
  // title), and a NEW artifact only. In the background so a popular author's fan-out never
  // adds to publish latency.
  if (opts.isNew && opts.onBehalf && artifact.listed === "public") {
    const behalf = opts.onBehalf
    background(fanOutToFollowers(meta, behalf, artifact))
  }
  // A live publish that fixes feedback resolves those threads directly.
  const resolved: string[] = []
  for (const threadId of opts.resolves ?? []) {
    await meta.setThreadState(artifact.id, threadId, "resolved")
    await recordThreadResolution(
      meta,
      artifact.id,
      threadId,
      "resolved",
      // The id alone is still a record (a headless publish has neither).
      opts.actorId || opts.actorName
        ? { id: opts.actorId ?? null, name: opts.actorName ?? null }
        : null,
      version.n,
    )
    bus.publish(artifact.id, { type: "comment.resolved", thread_id: threadId, state: "resolved" })
    resolved.push(threadId)
  }
  const storedRows = await emitVersionBump(
    deps,
    artifact,
    version,
    opts.preparedSource,
    opts.previousSearchSource,
    opts.dynamicSeedFrom,
  )
  // Source mentions are derived from the just-published bytes, never trusted from a client
  // payload. Run after the canonical version bump and isolate every delivery branch inside the
  // fan-out, so an outage cannot fail, roll back, or delay a live document edit.
  await background(
    fanOutNewContentMentions(
      { meta, blobs: deps.blobs, bus, baseUrl: deps.baseUrl },
      artifact,
      version,
      opts.actorId ?? null,
      opts.preparedSource,
    ).catch((err) =>
      log.warn("content mention fan-out failed", {
        artifact: artifact.id,
        version: version.n,
        surface: "prepare",
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
  )
  return { resolved, storedRows }
}

const fanOutToFollowers = async (
  meta: MetaStore,
  authorId: string,
  artifact: ArtifactRecord,
): Promise<void> => {
  const [author] = await meta.getUsers([authorId])
  if (!author) return
  const followers = await meta.listFollowers(author.id, 200)
  // One bulk insert for the whole fan-out, not a createNotification per follower.
  await meta.createNotifications(
    followers
      .filter((follower) => follower.id !== author.id)
      .map((follower) => ({
        id: newId("ntf"),
        user_id: follower.id,
        actor: author.name ?? author.username ?? "Someone",
        kind: "publish",
        artifact_id: artifact.id,
        artifact_short_id: artifact.short_id,
        artifact_title: artifact.title,
        thread_id: "",
        comment_id: "",
        preview: artifact.title ?? "published something new",
      })),
  )
}
