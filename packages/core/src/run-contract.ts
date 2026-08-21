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
 * it keeps a hand-copy. packages/cli/test/contract-parity.test.js holds that copy to this one.
 * This module is the definition; that test is the enforcement.
 */

/** A parsed, validated revision: the complete new source of an artifact plus its metadata. */
export interface Revision {
  /** The COMPLETE new artifact source — never a diff. */
  content: string
  /** Sets the content type; defaults to index.html when the model omits or mangles it. */
  filename: string
  /** The model's stated confidence in [0,1], or null when unstated. Informational — shown to
   *  people next to what was written, never used to gate the write. */
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

Return the WHOLE artifact source, not a diff. Your revision publishes as a new version of the
artifact — every version is kept and restorable, and the people who watch it are notified. State
your honest confidence; it is shown to people, never used to decide anything.`

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

/** Models wrap the JSON in ``` fences inside the tags often enough that every reader has to
 *  tolerate it. Shared so the three readers tolerate it IDENTICALLY — a fence one of them
 *  stripped and another did not is exactly the invisible drift these contracts exist to stop. */
const unfence = (s: string): string =>
  s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()

const blockBody = (text: string, name: "edits" | "revision"): string | null => {
  const lower = text.toLowerCase()
  const open = `<${name}>`
  const close = `</${name}>`
  const start = lower.indexOf(open)
  if (start < 0) return null
  const end = lower.indexOf(close, start + open.length)
  return end < 0 ? null : text.slice(start + open.length, end)
}

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
  const body = blockBody(text, "edits")
  if (!body) return { error: NO_EDITS_BLOCK }
  const cleaned = unfence(body)
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

/** The metadata half of a revision, normalized. Shared by every reader of the block so an
 *  attended turn, an automation run and an ask agree on what a mangled filename or a string
 *  confidence MEANS — the drift that a per-lane copy invites and nothing would notice. */
const normalizeRevision = (r: Record<string, unknown>, content: string): Revision => ({
  content,
  // A filename without an extension sets no content type, so fall back rather than publish an
  // artifact the viewer cannot render.
  filename:
    typeof r.filename === "string" && /\.[a-z0-9]+$/i.test(r.filename.trim())
      ? r.filename.trim().slice(0, 120)
      : "index.html",
  // Clamped, not rejected: a model that says 1.5 means "very sure", and failing the run over
  // it would throw away completed work. Anything non-numeric reads as UNSTATED (null) — the
  // value is informational either way, shown to people rather than gating anything.
  confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : null,
  message:
    typeof r.message === "string" && r.message.trim() ? r.message.trim().slice(0, 200) : undefined,
})

export const parseRevision = (text: string): RevisionParse => {
  const body = blockBody(text, "revision")
  if (!body) return { error: NO_REVISION_BLOCK }
  let raw: unknown
  try {
    raw = JSON.parse(unfence(body))
  } catch (e) {
    return { error: `revision JSON parse: ${(e as Error).message}` }
  }
  if (!raw || typeof raw !== "object") return { error: "revision is not an object" }
  const r = raw as Record<string, unknown>
  if (typeof r.content !== "string" || !r.content.trim())
    return { error: "content must be a non-empty string" }
  if (r.content.length > MAX_ARTIFACT_CHARS) return { error: "content is over the 2MB cap" }
  return { revision: normalizeRevision(r, r.content) }
}

// ---- the ASK variant: the same turn, where the model may choose not to write ----------------
//
// An ask is not a different contract. It is the SAME <revision> block on a turn where somebody
// is waiting, so two things change and nothing else does:
//
//   1. The block is OPTIONAL. "They asked a question" is a complete, correct turn — the attended
//      chat path has always treated a reply with no block as an ANSWER (NO_REVISION_BLOCK above),
//      and an unattended ask deserves exactly the same reading.
//   2. It carries the fields only a waiting person can use: escalate, and caveats.
//
// A parallel <answer> contract would fork the one thing that must not fork. The CLI runner has
// its own <answer> block for historical reasons and its own filesystem-backed page channel; the
// FIELDS below are the part shared with it, and packages/cli/test/ask-parity.test.js holds the
// two readers to the same reading of them.

/** The fields a SESSION turn carries that an automation run has no use for: nobody is waiting on
 *  an automation, so there is nobody to escalate to and nobody to warn. */
export interface AskFields {
  /** This needs a person. The answer still stands — it is a draft to escalate, not a refusal. */
  escalate: boolean
  escalationReason: string | null
  /** Anything the asker should treat with care. */
  caveats: string[]
  /** A page the model says it wrote TO ITS OWN DISK (`artifact: {title, path}` — the CLI
   *  runner's channel, because a coding agent in a container has a filesystem and building a
   *  large page into a file beats re-typing it into JSON).
   *
   *  Kept as its OWN field rather than folded into `revision` because it is the one thing an
   *  executor without a filesystem genuinely cannot serve. Reading it is what lets such an
   *  executor SAY SO. Dropping the key instead would lose a page the model built and report
   *  success, which is the failure this field exists to prevent. */
  pageOnDisk: { title: string; path: string } | null
}

/** One session turn's reply. */
export interface AskReply extends AskFields {
  /** The prose the asker reads. Never empty. */
  body_md: string
  /** Present when the model chose to WRITE. Null when it answered, which is not a contract
   *  miss — it is the other half of the contract. */
  revision: Revision | null
}

export type AskParse = { reply: AskReply; error?: undefined } | { reply?: undefined; error: string }

/** Appended to the system prompt for an ASK. Deliberately the same block as REVISION_CONTRACT:
 *  a reply that satisfies one satisfies the other, minus the fields nobody unattended can use. */
export const ASK_CONTRACT = `

## Output format — REQUIRED

Someone ASKED you this and is waiting for the reply. Two things can happen, and you decide which:

- They asked a QUESTION, or are thinking out loud. Answer in prose and emit NO block. Your prose
  IS the answer and nothing is written.
- They asked for a CHANGE, or for a page to be built. Answer in prose AND end your FINAL message
  with a single <revision> block of JSON, with nothing after it.

<revision>
{
  "content": "the COMPLETE new source — omit this key entirely when you are not writing",
  "filename": "index.html or notes.md — sets the content type",
  "confidence": 0.0,
  "message": "a one-line version note",
  "escalate": false,
  "escalation_reason": null,
  "caveats": ["anything the asker should treat with care"]
}
</revision>

Put the WHOLE source in "content", never a diff, and inline everything a page needs (CSS, JS,
SVG) — it renders in a sandbox that cannot fetch. Your "content" publishes as an artifact —
every version is kept and restorable. State your honest confidence; it is shown to people,
never used to decide anything.

Set "escalate" to true, with a short "escalation_reason", when this needs a person — and still
give your best answer in prose. You may send the block with no "content" at all, purely to carry
"escalate" or "caveats" alongside a prose answer.`

/** Sent when a block WAS present and could not be read. A reply with no block is never nudged:
 *  on an ask that is an answer, not a miss. */
export const ASK_NUDGE = `Your previous reply was NOT accepted — the <revision> block in it could not be read, so nothing was written. Reply now with your answer in prose, followed by a single corrected block if you meant to change something: <revision>{"content":"<the full new source>","filename":"index.html","confidence":…,"message":"…"}</revision>. If you did not mean to change anything, answer in prose with no block at all.`

/** Both output blocks, because "the prose" means the same thing whichever one a turn asked for
 *  and a large-document turn that answers in prose must not have its answer contaminated by a
 *  block it also emitted. */
/** Whatever the model said OUTSIDE the block — the prose an asker actually reads. */
export const proseOf = (text: string): string => {
  let remaining = text
  let prose = ""
  while (remaining) {
    const lower = remaining.toLowerCase()
    const revision = lower.indexOf("<revision>")
    const edits = lower.indexOf("<edits>")
    const starts = [revision, edits].filter((at) => at >= 0)
    if (!starts.length) return (prose + remaining).trim()
    const start = Math.min(...starts)
    const name = start === revision ? "revision" : "edits"
    const close = `</${name}>`
    const end = lower.indexOf(close, start)
    if (end < 0) return (prose + remaining).trim()
    prose += remaining.slice(0, start)
    remaining = remaining.slice(end + close.length)
  }
  return prose.trim()
}

/** The page-on-disk channel, read exactly as the CLI runner reads its own: inline HTML wins,
 *  an oversized inline page WITH a path falls through to the path rather than being dropped,
 *  and a nameless artifact is not one. Returns the inline source separately because inline HTML
 *  is just a revision by another name. */
const readArtifactChannel = (
  a: unknown,
): { html?: string; title: string; path?: string } | null => {
  if (!a || typeof a !== "object") return null
  const o = a as Record<string, unknown>
  if (typeof o.title !== "string" || !o.title.trim()) return null
  // Model-generated: clamped to card width, not trusted less.
  const title = o.title.trim().slice(0, 120)
  if (typeof o.html === "string" && o.html.trim() && o.html.length <= MAX_ARTIFACT_CHARS)
    return { title, html: o.html }
  if (typeof o.path === "string" && o.path.trim()) return { title, path: o.path.trim() }
  return null
}

/**
 * Read a model reply as one SESSION turn.
 *
 * Strict about the same substance parseRevision is, and forgiving about one more thing: the block
 * itself. No block is an ANSWER. A block whose `content` is absent or empty is an answer too —
 * that is how a model carries `escalate` or `caveats` on a turn that writes nothing. Only a block
 * that is PRESENT and unreadable is an error, because that is the model trying and failing the
 * contract rather than choosing not to write.
 */
export const parseAsk = (text: string): AskParse => {
  const revisionBody = blockBody(text, "revision")
  const prose = proseOf(text)
  const answered = (over: Partial<AskReply> = {}): AskParse => ({
    reply: {
      body_md: prose || "(no reply)",
      revision: null,
      escalate: false,
      escalationReason: null,
      caveats: [],
      pageOnDisk: null,
      ...over,
    },
  })
  if (!revisionBody) return answered()
  let raw: unknown
  try {
    raw = JSON.parse(unfence(revisionBody))
  } catch (e) {
    return { error: `revision JSON parse: ${(e as Error).message}` }
  }
  if (!raw || typeof raw !== "object") return { error: "revision is not an object" }
  const r = raw as Record<string, unknown>
  if (typeof r.content === "string" && r.content.length > MAX_ARTIFACT_CHARS)
    return { error: "content is over the 2MB cap" }

  // A page built with the CLI's artifact channel. Inline HTML IS a revision — "the complete
  // source of a page" is the only thing a revision ever was — so it folds in rather than
  // becoming a second way to say the same thing. A path cannot fold in: it names a file on an
  // executor's disk, so it rides out separately for a caller that can serve it (or explain).
  const channel = readArtifactChannel(r.artifact)
  const content =
    typeof r.content === "string" && r.content.trim() ? r.content : (channel?.html ?? null)
  const fields: AskFields = {
    // Strictly the boolean. A truthy string must NOT escalate: escalation routes an answer to a
    // person, and a model that wrote "false" would otherwise page somebody.
    escalate: r.escalate === true,
    escalationReason: typeof r.escalation_reason === "string" ? r.escalation_reason : null,
    caveats: Array.isArray(r.caveats) ? r.caveats.filter((x) => typeof x === "string") : [],
    pageOnDisk: channel?.path ? { title: channel.title, path: channel.path } : null,
  }
  if (content === null) return answered(fields)
  const revision = normalizeRevision(
    // An inline page has no filename of its own; its title is not one either (it is prose, and
    // a title with a dot in it would set a content type by accident). HTML is what it is.
    channel?.html === content && typeof r.filename !== "string"
      ? { ...r, filename: "page.html" }
      : r,
    content,
  )
  const responseBody = typeof r.body_md === "string" && r.body_md.trim() ? r.body_md.trim() : prose
  return {
    reply: { ...fields, body_md: responseBody || revision.message || "(no reply)", revision },
  }
}
