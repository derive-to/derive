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
export const parseRevision = (text: string): RevisionParse => {
  const m = text.match(/<revision>([\s\S]*?)<\/revision>/i)
  if (!m?.[1]) return { error: "no <revision> block in result" }
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
