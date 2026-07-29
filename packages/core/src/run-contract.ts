import type { DocEdit } from "./doc-text"
/**
 * The RUN CONTRACT: what an automation run must return, and how that reply is read.
 *
 * There are two executors — the CLI runner (a coding agent in a container) and, next, an
 * in-Worker agent loop — and the plan's open question was whether the second forks this or
 * shares it. It shares it, because a fork stops the two substrates being comparable: if
 * "runs in a container" and "runs in a Worker" accept different replies or parse them
 * differently, they quietly become different products and routing between them on cost stops
 * being a routing decision and becomes a behaviour change.
 *
 * The CLI cannot import this module at runtime (it is a dependency-free published package), so
 * it keeps a hand-copy — exactly like decideWrite. packages/cli/test/contract-parity.test.js
 * holds that copy to this one. This module is the definition; that test is the enforcement.
 */

/** A parsed, validated revision: the complete new source of an artifact plus its metadata. */
export interface Revision {
  /** The COMPLETE new artifact source — never a diff. */
  content: string
  /** Sets the content type; defaults to index.html when the model omits or mangles it. */
  filename: string
  /** The model's stated confidence in [0,1], or null when unstated. Null never auto-publishes. */
  confidence: number | null
  /** A one-line version note, capped. */
  message?: string
}

/** Both branches name both keys so a caller can write `parse(t).revision?.content` without
 *  narrowing first — which is how the CLI's JS callers already use its copy, and the shape a
 *  TS-only union would have quietly diverged from. */
export type RevisionParse =
  | { revision: Revision; error?: undefined }
  | { revision?: undefined; error: string }

/** 2MB of artifact source. A model that "returns the whole document" on a runaway loop would
 *  otherwise write megabytes through the publish path before anything noticed. */
export const MAX_ARTIFACT_CHARS = 2_000_000

/** Appended to the system prompt. This exact text is what the container executor sends, so the
 *  two substrates ask for the same thing in the same words — a reply that satisfies one must
 *  satisfy the other. */
export const REVISION_CONTRACT = `

## Output format — REQUIRED

You are running an AUTOMATION: you maintain a Derive artifact on a trigger, you are not answering a
person. Do what the instruction asks — if source tools are listed, pull from them — then end your
FINAL message with a single <revision> block of JSON and NOTHING after it. A reply without the
block is discarded and nothing is written.

<revision>
{
  "content": "the COMPLETE new source of the artifact",
  "filename": "index.html or notes.md — sets the content type",
  "confidence": 0.0,
  "message": "a one-line version note"
}
</revision>

Return the WHOLE artifact source, not a diff. Derive decides how the write lands — publish,
propose, or record — from the automation's settings and your confidence; that is never your call.`

/**
 * The EDITS contract — the same job as REVISION_CONTRACT, sized for a document that cannot be
 * returned whole.
 *
 * A revision's reply is bounded by the DOCUMENT; an edit's is bounded by the CHANGE. That is the
 * entire reason this exists: past roughly 30KB a full-source reply hits the token ceiling, and
 * every edit fails identically whether it changes a word or rewrites the page. Search/replace has
 * no such relationship to document size.
 *
 * Deliberately the same shape as the coding Edit tool (old_str/new_str/occurrence), because models
 * are already good at it and already know how to recover from a miss.
 */
export const EDITS_CONTRACT = `

## Output format — REQUIRED

This document is TOO LARGE to return in full, so do not try. Reply with a single <edits> block of
JSON and NOTHING after it, describing only what should CHANGE.

<edits>
{
  "edits": [
    { "old_str": "text to find, copied EXACTLY from the source", "new_str": "text to put in its place" }
  ],
  "confidence": 0.0,
  "message": "a one-line version note"
}
</edits>

Rules that decide whether this applies at all:
- "old_str" must appear EXACTLY ONCE. Include enough surrounding text to make it unique — a bare
  tag or a common word will match many times and be rejected.
- Copy "old_str" byte for byte from the source, including whitespace and markup. It is matched
  literally, not fuzzily.
- If a phrase is intentionally repeated, add "occurrence": N (1-based) to say which one.
- Keep each "old_str" as small as it can be while staying unique. You are not being asked for
  context, you are being asked for the change.
- To ADD a section, anchor on the text it should follow and put both the anchor and the new
  content in "new_str".

Either every edit applies or none does — a partial document is never written.`

/** Sent when the model replied without a usable <edits> block, or when applying them failed.
 *  `detail` carries applyEdits' own diagnostic, which explains WHY a match failed (not merely
 *  that it did) — that is what lets the second attempt actually succeed. */
export const editsNudge = (detail: string): string =>
  `Your previous reply was NOT applied: ${detail}\n\nReply now with ONLY a corrected <edits> block and nothing else. Copy old_str byte for byte from the source shown above, and include enough surrounding text that it appears exactly once.`

/** Read a model reply into edits, forgiving about shape and strict about substance — same stance
 *  as parseRevision. An empty or malformed list is an error, never a silent no-op. */
export const parseEdits = (
  text: string,
):
  | { edits: DocEdit[]; confidence: number | null; message?: string; error?: undefined }
  | {
      edits?: undefined
      confidence?: undefined
      message?: undefined
      error: string
    } => {
  const m = text.match(/<edits>([\s\S]*?)<\/edits>/i)
  if (!m?.[1]) return { error: NO_EDITS_BLOCK }
  const cleaned = m[1]
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch (e) {
    return { error: `edits JSON parse: ${(e as Error).message}` }
  }
  if (!raw || typeof raw !== "object") return { error: "edits is not an object" }
  const o = raw as Record<string, unknown>
  const list = Array.isArray(o.edits) ? o.edits : null
  if (!list?.length) return { error: "edits must be a non-empty array of {old_str, new_str}" }
  const out: DocEdit[] = []
  for (const [i, e] of list.entries()) {
    if (!e || typeof e !== "object") return { error: `edit ${i + 1} is not an object` }
    const x = e as Record<string, unknown>
    if (typeof x.old_str !== "string" || x.old_str === "")
      return { error: `edit ${i + 1}: old_str must be a non-empty string` }
    if (typeof x.new_str !== "string")
      return { error: `edit ${i + 1}: new_str must be a string (use "" to delete)` }
    const occ = typeof x.occurrence === "number" ? { occurrence: x.occurrence } : {}
    out.push({ old_str: x.old_str, new_str: x.new_str, ...occ })
  }
  const conf = typeof o.confidence === "number" ? o.confidence : Number(o.confidence)
  return {
    edits: out,
    confidence: Number.isFinite(conf) ? conf : null,
    message: typeof o.message === "string" ? o.message : undefined,
  }
}

/** The `error` value meaning no <edits> block was present at all. */
export const NO_EDITS_BLOCK = "no <edits> block in result"

/** Above this many characters of source, a full-document reply will not fit in a normal model
 *  reply, so the turn asks for edits instead. Set well below the real ceiling (~30KB at 8k
 *  tokens): the reply also carries prose, and a document just under the limit that fails is a
 *  worse experience than one comfortably over it that uses edits. */
export const EDITS_THRESHOLD_CHARS = 12_000

/** Sent when a reply arrived without the block: one more chance, asking for the block alone. */
export const REVISION_NUDGE = `Your previous reply was NOT accepted — it did not end with the required <revision> block, so nothing was written. Reply now with ONLY that block and nothing else: <revision>{"content":"<the full new artifact source>","filename":"index.html","confidence":…,"message":"…"}</revision>.`

/**
 * Read a model reply into a validated Revision, or an error explaining what was wrong.
 *
 * Every branch is deliberately forgiving about SHAPE and strict about SUBSTANCE: models wrap the
 * block in ``` fences, mangle the filename, or state confidence as a string. None of those is
 * worth discarding real work over. What is never guessed is `content` — an empty or missing
 * content means the run produced nothing, and inventing a fallback would publish silence.
 */
/** The `error` value meaning the reply carried NO block at all, as opposed to a malformed
 *  one. Exported because an attended caller (chat) treats "chose not to revise" as a perfectly
 *  good answer and must be able to tell it apart from "tried and failed" — without
 *  string-matching a message that could later be reworded. */
export const NO_REVISION_BLOCK = "no <revision> block in result"

export const parseRevision = (text: string): RevisionParse => {
  const m = text.match(/<revision>([\s\S]*?)<\/revision>/i)
  if (!m?.[1]) return { error: NO_REVISION_BLOCK }
  const cleaned = m[1]
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch (e) {
    return { error: `revision JSON parse: ${(e as Error).message}` }
  }
  if (!raw || typeof raw !== "object") return { error: "revision is not an object" }
  const r = raw as Record<string, unknown>
  if (typeof r.content !== "string" || !r.content.trim())
    return { error: "content must be a non-empty string" }
  if (r.content.length > MAX_ARTIFACT_CHARS) return { error: "content is over the 2MB cap" }
  // A filename without an extension sets no content type, so fall back rather than publish an
  // artifact the viewer cannot render.
  const filename =
    typeof r.filename === "string" && /\.[a-z0-9]+$/i.test(r.filename.trim())
      ? r.filename.trim().slice(0, 120)
      : "index.html"
  return {
    revision: {
      content: r.content,
      filename,
      // Clamped, not rejected: a model that says 1.5 means "very sure", and failing the run over
      // it would throw away completed work. Anything non-numeric reads as UNSTATED (null), which
      // the autonomy gate treats as never-auto-publish.
      confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : null,
      message:
        typeof r.message === "string" && r.message.trim()
          ? r.message.trim().slice(0, 200)
          : undefined,
    },
  }
}
