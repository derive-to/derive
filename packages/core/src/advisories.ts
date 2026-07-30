// Publish advisories: checks over just-published content, returned with the publish
// response (response text reaches agents far more reliably than tool descriptions
// do). The REST route carries them as a field; both MCP servers fold them into
// their notes. Advisories NEVER block or fail a publish — they exist because the
// silent-breakage shapes below each actually shipped and were only caught by
// looking at the render afterward: correct-by-construction beats
// correct-by-vigilance.

import {
  missingDataSlotAdvisory,
  parseDataSlots,
  shapeOfJson,
  slotDriftAdvisories,
} from "./data-slots"
import type { BlobStore } from "./ports"
import { needsReflow } from "./reflow"

/** Advisory strings for a just-published single file — empty when nothing to say. */
export const publishAdvisories = (content: string, contentType: string): string[] => {
  const out: string[] = []

  // Structured data slots that couldn't be stored (bad name, invalid JSON, oversize,
  // duplicate, over the per-version cap). The SAME parser persists the good slots in the
  // version-bump chain, so what's advised here and what's stored can never disagree.
  out.push(...parseDataSlots(content, contentType).advisories)

  // A page full of figures with no slot: the nudge that keeps slots from depending on the
  // author remembering. Last, so it never crowds out something that is actually wrong.
  const noSlot = missingDataSlotAdvisory(content, contentType)
  if (noSlot) out.push(noSlot)

  // A temporary asset UPLOAD url (the mint-and-curl target) embedded as if it were
  // the permanent asset URL — it expires in minutes, so every image breaks shortly
  // after publish. The permanent `url` (or `ref`) comes back from the upload itself.
  if (/\/v1\/assets\/t\//.test(content))
    out.push(
      "The content embeds a temporary asset UPLOAD url (…/v1/assets/t/…), which expires in " +
        "minutes — embed the permanent `url` (or `ref`) returned by the upload instead.",
    )

  // HTML page markup stored as markdown: the markdown renderer strips/escapes
  // <style>/<head> content, so the page shows its CSS as visible text. (The type
  // sniffer catches page-shaped OPENERS; this catches page markup deeper in a
  // markdown-typed doc.)
  if (contentType === "text/markdown" && /<style[\s>]|<meta\s+name=["']viewport["']/i.test(content))
    out.push(
      "Stored as markdown, but the content contains HTML page markup (<style>/<meta viewport>) — " +
        'if this is a styled page, republish with filename:"index.html" so it renders as HTML.',
    )

  // A page with no viewport meta gets the mobile-reflow injection, whose media
  // caps can fight an intentional layout (see reflow.ts).
  if (contentType === "text/html" && needsReflow(content))
    out.push(
      'This page has no <meta name="viewport">, so Derive injects mobile-reflow CSS ' +
        "(its media caps can fight intentional layouts; data-reflow-exempt on an element " +
        "opts a component out). Declare your own viewport meta to skip the injection.",
    )

  // Large inlined base64 usually means binaries were pasted through a tool call
  // instead of staged via /v1/assets. The threshold keeps icon-sized data URIs quiet.
  let base64Chars = 0
  for (const m of content.matchAll(/data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)/g))
    base64Chars += (m[1] ?? "").length
  if (base64Chars > 16 * 1024)
    out.push(
      `~${Math.round(base64Chars / 1024)}KB of inline base64 data URIs — upload binaries ` +
        "(images, woff2 fonts) to POST /v1/assets and reference the returned URLs instead: " +
        "base64 carried through a tool call costs tokens and can be silently mistranscribed.",
    )

  return out
}

/** How many embedded blob refs the existence check verifies per publish — a
 *  gallery page must not turn one publish into a hundred store lookups. */
const BLOB_CHECK_CAP = 12

/** Matches an embedded content-addressed asset URL (absolute or relative) and
 *  captures the 64-hex key; the extension is display sugar, the key is the ref. */
const BLOB_REF = /\/blob\/([0-9a-f]{64})(?:\.[a-z0-9]+)?/gi

/** Total referenced asset weight past which a page is worth mentioning. Roughly "this
 *  costs a second on a slow connection", not "this is wrong" — plenty of pages should be
 *  heavy, and the point is that the author knows, not that they change it. */
const HEAVY_PAGE_BYTES = 1024 * 1024

/**
 * What the assets this page references cost every viewer, every load. Sibling to
 * {@link missingBlobAdvisory} (same I/O shape, same cap, same never-throws contract),
 * and deliberately advisory rather than a transform: these are the USER'S bytes, so
 * Derive names the cost instead of quietly re-encoding someone's image.
 *
 * Silent under the threshold. Never throws — a store hiccup must not fail a publish.
 */
export const heavyAssetsAdvisory = async (
  content: string,
  assets: { getAsset(hash: string): Promise<{ size_bytes: number } | null> },
): Promise<string | null> => {
  try {
    const keys = [
      ...new Set([...content.matchAll(BLOB_REF)].map((m) => (m[1] as string).toLowerCase())),
    ].slice(0, BLOB_CHECK_CAP)
    if (!keys.length) return null
    const rows = await Promise.all(keys.map((k) => assets.getAsset(k)))
    const total = rows.reduce((sum, r) => sum + (r?.size_bytes ?? 0), 0)
    if (total < HEAVY_PAGE_BYTES) return null
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`
    const found = rows.filter(Boolean).length
    return (
      `This page references ${mb(total)} of images across ${found} asset(s), which every ` +
      `viewer downloads on every load. Nothing is re-encoded (they are your bytes) — but if ` +
      `any were exported at twice the density they display at, halving that is the lever: it ` +
      `cut Derive's own renders ~78%, where re-encoding bought 15%.`
    )
  } catch {
    return null
  }
}

/**
 * Slot shapes that drifted from the previous version — the quiet way a trend read goes
 * wrong. Needs I/O (the previous version's stored rows), so it sits with the other I/O
 * advisories rather than in the pure pass. Silent on a first version, a new slot, or a
 * slot that simply went away; those are ordinary authoring.
 *
 * Never throws: a store hiccup must not fail a publish that already went live.
 */
export const slotShapeDriftAdvisories = async (
  content: string,
  contentType: string,
  artifactId: string,
  previousVersion: number,
  meta: {
    getVersionData(
      artifactId: string,
      n: number,
      slot?: string,
    ): Promise<{ slot: string; json: string }[]>
  },
): Promise<string[]> => {
  if (previousVersion < 1) return []
  try {
    const { slots } = parseDataSlots(content, contentType)
    if (!slots.length) return []
    const prior = await meta.getVersionData(artifactId, previousVersion)
    if (!prior.length) return []
    return slotDriftAdvisories(
      slots.map((s) => ({ slot: s.slot, json: s.json })),
      prior.map((p) => ({ slot: p.slot, shape: shapeOfJson(p.json) })),
    )
  } catch {
    return []
  }
}

/** The one advisory that needs I/O: embedded /blob/ URLs whose bytes don't exist —
 *  a hand-typed or mistranscribed hash renders as a 404 image. Only runs when the
 *  store can answer cheaply (`has` is a stat/HEAD); a store without `has` skips the
 *  check rather than falling back to body reads. Returns null when all refs
 *  resolve. Never throws — a store hiccup must not fail the publish. */
export const missingBlobAdvisory = async (
  content: string,
  blobs: BlobStore,
): Promise<string | null> => {
  if (!blobs.has) return null
  const has = blobs.has.bind(blobs)
  try {
    const keys = [
      ...new Set([...content.matchAll(BLOB_REF)].map((m) => (m[1] as string).toLowerCase())),
    ]
    // CONCURRENT, not sequential: this is awaited on the publish response path, and on
    // S3/R2 each `has` is a signed HEAD over the network. Serially a 12-ref page would
    // add twelve round trips (~1s) to every publish; together they cost the slowest one.
    const checked = keys.slice(0, BLOB_CHECK_CAP)
    const present = await Promise.all(checked.map((key) => has(key)))
    const missing = checked.filter((_, i) => !present[i])
    if (!missing.length) return null
    return (
      `${missing.length} embedded asset URL(s) reference blobs that don't exist ` +
      `(${missing.map((k) => `${k.slice(0, 12)}…`).join(", ")}) — those images will 404. ` +
      "Upload the bytes via the assets endpoint and embed the returned permanent url."
    )
  } catch {
    return null
  }
}
