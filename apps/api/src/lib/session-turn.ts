// ONE TURN of a session that is ABOUT an artifact — the whole of "chat with a derive".
//
// The shape is deliberately small: read the doc, ask the model, and if it came back with a
// revision, write it. There is no queue, no claim, no capability token and no runner here,
// because all of that machinery exists to survive nobody watching, and the person who typed
// the message is watching. See the design doc (derive.to 8205agbp).
//
// What it DOES share with the unattended lane is every decision that must not drift: the run
// contract (what to ask for, how to read it), the autonomy gate (how a write lands), and the
// cost accounting. Those are imported from core, not re-implemented.

import {
  type ArtifactRecord,
  addCostUsd,
  decideWrite,
  MAX_ARTIFACT_CHARS,
  NO_REVISION_BLOCK,
  NUDGE_LIMIT,
  newId,
  parseRevision,
  REVISION_CONTRACT,
  REVISION_NUDGE,
  type Selector,
  type SessionMessageRecord,
  type SessionRecord,
  toMicroUsd,
} from "@derive/core"
import { log } from "../log"
import { type AfterPublishDeps, afterPublish } from "./after-publish"
import type { AgentLoopInput } from "./agent-loop"

export interface TurnDeps extends AfterPublishDeps {
  callModel: AgentLoopInput["callModel"]
}

/** What a turn did, for the transcript and the ledger. `reply` is always present —
 *  even a failed turn owes the person who is sitting there an answer. */
export interface TurnResult {
  reply: string
  outcome: "published" | "proposed" | "answered" | "failed"
  /** The version number written, or the proposal id filed. Null when nothing landed. */
  wrote: { kind: "version"; n: number } | { kind: "proposal"; id: string } | null
  costMicroUsd: number | null
}

const sourceOf = async (
  deps: TurnDeps,
  artifact: ArtifactRecord,
): Promise<{ text: string; version: number } | null> => {
  const v = await deps.meta.getVersion(artifact.id, artifact.current_version)
  if (!v) return null
  const bytes = await deps.blobs.get(v.blob_key)
  if (!bytes) return null
  return { text: new TextDecoder().decode(bytes).slice(0, MAX_ARTIFACT_CHARS), version: v.n }
}

/** The transcript, oldest first, as plain chat turns. The artifact's source is NOT
 *  folded in here — it is a separate, clearly-labelled block, so a message that happens
 *  to contain markup can never be mistaken for the document. */
const asTurns = (msgs: SessionMessageRecord[]): { role: "user" | "assistant"; content: string }[] =>
  msgs.map((m) => ({
    role: m.author_kind === "asker" ? ("user" as const) : ("assistant" as const),
    content: m.body_md,
  }))

/**
 * Run one turn against `artifact`, writing through the gate. Never throws: a turn that
 * fails still returns a reply, because the transcript is what the person is looking at
 * and an empty conversation is a worse failure than an honest error message.
 */
export const runSessionTurn = async (
  deps: TurnDeps,
  input: {
    session: SessionRecord
    subject: Extract<Selector, { kind: "artifact" }>
    artifact: ArtifactRecord
    transcript: SessionMessageRecord[]
    flags: { agentKillswitch: boolean; agentAutoEnabled: boolean }
    /** The human this turn acts for — follower fan-out and version authorship. */
    onBehalf: { id: string; name: string } | null
  },
): Promise<TurnResult> => {
  const src = await sourceOf(deps, input.artifact)
  if (!src)
    return {
      reply: "I could not read this document's current contents, so I have not changed anything.",
      outcome: "failed",
      wrote: null,
      costMicroUsd: null,
    }

  const system = `You are helping someone edit a document they are looking at right now.

If they are asking you to CHANGE the document, reply with the revision block described below.
If they are asking a QUESTION, or thinking out loud, just answer them in prose — do NOT emit a
revision block, and do not change the document. Most messages are one or the other; decide which.

${REVISION_CONTRACT}

The document's current source follows, and its filename is ${input.artifact.short_id}.

--- BEGIN DOCUMENT ---
${src.text}
--- END DOCUMENT ---`

  let cost: number | null = null
  let text = ""
  const turns = asTurns(input.transcript)
  for (let attempt = 0; attempt <= NUDGE_LIMIT; attempt++) {
    try {
      const res = await deps.callModel({
        system,
        messages:
          attempt === 0 ? turns : [...turns, { role: "user" as const, content: REVISION_NUDGE }],
        tools: [],
      })
      cost = addCostUsd(cost, res.costUsd)
      text = res.text
    } catch (err) {
      log.error("model call failed", { session: input.session.id, err: String(err) })
      return {
        reply: "I could not reach the model just now. Nothing has been changed — try again.",
        outcome: "failed",
        wrote: null,
        costMicroUsd: toMicroUsd(cost),
      }
    }
    const parsed = parseRevision(text)
    if (parsed.revision) return await land(deps, input, parsed.revision, src.version, cost)
    // NO revision block is a legitimate answer here, unlike an unattended run: the person may
    // simply have asked a question. Only a block that was PRESENT but malformed earns a nudge —
    // that is the model trying and failing the contract, rather than choosing not to edit.
    if (parsed.error === NO_REVISION_BLOCK) {
      const prose = text.replace(/<revision>[\s\S]*?<\/revision>/gi, "").trim()
      return {
        reply: prose || "(no reply)",
        outcome: "answered",
        wrote: null,
        costMicroUsd: toMicroUsd(cost),
      }
    }
  }
  return {
    reply:
      "I tried to revise the document but could not produce a valid revision. Nothing has changed.",
    outcome: "failed",
    wrote: null,
    costMicroUsd: toMicroUsd(cost),
  }
}

const land = async (
  deps: TurnDeps,
  input: Parameters<typeof runSessionTurn>[1],
  revision: { content: string; filename: string; confidence: number | null; message?: string },
  baseVersion: number,
  cost: number | null,
): Promise<TurnResult> => {
  // THE GATE, not the model, decides how this lands. `mode` rides on the subject selector,
  // so the person's edit-vs-suggest preference is the same field that says what the session
  // is about — one field, and the two can never disagree.
  const decision = decideWrite({
    autonomy: input.subject.mode === "publish" ? "auto" : "suggest",
    confidence: revision.confidence,
    flags: input.flags,
    // Nothing external was read: the model saw this document and this conversation, both of
    // which the asker can already see. Taint returns the moment a turn can call a tool.
    tainted: false,
  })
  // No `shadow` branch: `autonomy` here is only ever `auto` or `suggest` (derived from the
  // subject's mode), and decideWrite returns `shadow` only for autonomy `shadow`. Shadow is an
  // unattended-run concept — filing nothing at all makes no sense when someone is waiting for
  // a reply — so the case is unreachable rather than unhandled.

  const bytes = new TextEncoder().encode(revision.content)
  const blobKey = await deps.blobs.put(bytes)
  const contentType = revision.filename.endsWith(".md") ? "text/markdown" : "text/html"
  const author = input.onBehalf?.name ?? "Derive"

  // A human published while the model was thinking. Demote rather than clobber: their write
  // is the one that was reviewed by a person, and the turn's answer becomes a proposal against
  // what they wrote. The check is cheap and re-reads the artifact deliberately.
  const fresh = await deps.meta.getArtifactById(input.artifact.id)
  const raced = !!fresh && fresh.current_version !== baseVersion

  if (decision === "proposal" || raced) {
    const proposal = await deps.meta.createProposal({
      id: newId("p"),
      artifact_id: input.artifact.id,
      blob_key: blobKey,
      content_type: contentType,
      kind: input.artifact.kind,
      message: revision.message ?? null,
      author,
      author_id: input.onBehalf?.id ?? null,
      on_behalf_of: input.onBehalf?.id ?? null,
      base_version: baseVersion,
    })
    return {
      reply: raced
        ? `${revision.message || "Done."}\n\n(Someone published while I was working, so I filed this as a proposal instead of editing.)`
        : revision.message || "Done — filed as a proposal.",
      outcome: "proposed",
      wrote: { kind: "proposal", id: proposal.id },
      costMicroUsd: toMicroUsd(cost),
    }
  }

  const version = await deps.meta.addVersion(input.artifact.id, {
    id: newId("v"),
    blob_key: blobKey,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    author,
    author_id: input.onBehalf?.id ?? null,
    source: "api",
    message: revision.message ?? null,
    name: null,
  })
  // Same post-publish work as any other write — webhooks, realtime, re-anchor — so a chat
  // edit is indistinguishable downstream from one made in the editor. That is the point.
  await afterPublish(deps, input.artifact, version, {
    isNew: false,
    onBehalf: input.onBehalf?.id ?? null,
  })
  return {
    reply: revision.message || `Done — published v${version.n}.`,
    outcome: "published",
    wrote: { kind: "version", n: version.n },
    costMicroUsd: toMicroUsd(cost),
  }
}
