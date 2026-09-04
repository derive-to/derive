// ONE TURN of a session that is ABOUT an artifact — the whole of "chat with a derive".
//
// The shape is deliberately small: read the doc, ask the model, and if it came back with a
// revision, write it. There is no queue, no claim, no capability token and no runner here,
// because all of that machinery exists to survive nobody watching, and the person who typed
// the message is watching. See the design doc (derive.to 8205agbp).
//
// What it DOES share with the unattended lane is every decision that must not drift: the run
// contract (what to ask for, how to read it), the nudge policy and the cost accounting. Those
// are lib/turn-core.ts, which the loop substrate runs too.
// This file is what is genuinely attended about an attended turn: the document comes from the
// store rather than a claim, and the write goes to the store rather than over HTTP.

import {
  type ArtifactRecord,
  MAX_ARTIFACT_CHARS,
  NUDGE_LIMIT,
  newId,
  type Revision,
  type Selector,
  type SessionMessageRecord,
  type SessionRecord,
  toMicroUsd,
} from "@derive/core"
import { log } from "../log"
import { type AfterPublishDeps, afterPublish } from "./after-publish"
import type { AgentLoopInput } from "./agent-loop"
import { DEFAULT_MAX_TURNS } from "./agent-loop"
import { BillingBlockedError } from "./billing"
import type { ChatToolSurface } from "./chat-tools"
import { DERIVE_AGENT_NAME, DERIVE_AUTHOR_ID } from "./principal-kind"
import {
  documentContext,
  documentContract,
  documentName,
  type LandingPort,
  runTurn,
  suggestionText,
  type TurnOutcome,
} from "./turn-core"

export interface TurnDeps extends AfterPublishDeps {
  callModel: AgentLoopInput["callModel"]
  /** The billing gate — threaded through exactly like `meta`/`blobs` arrive, so the one
   *  branch that actually lands a live publish (landInProcess) can refuse it. A blocked
   *  or raced turn writes nothing, so only the live-publish branch checks this. */
  billingBlocked: (orgId: string) => Promise<{ code: string; message: string } | null>
}

/** What a turn did, for the transcript and the ledger. `reply` is always present —
 *  even a failed turn owes the person who is sitting there an answer. `commented`
 *  means the drafted change was surfaced in the reply and the document not touched. */
export interface TurnResult {
  reply: string
  outcome: "published" | "commented" | "answered" | "failed"
  /** The version number written. Null when nothing landed on the document. */
  wrote: { kind: "version"; n: number } | null
  costMicroUsd: number | null
}

type TurnInput = {
  session: SessionRecord
  subject: Extract<Selector, { kind: "artifact" }>
  artifact: ArtifactRecord
  transcript: SessionMessageRecord[]
  /**
   * Why this turn may NOT write the document, when it may not — resolved fresh by the route,
   * per turn. Absent means the write publishes live, like any other write. This is plain
   * standing, not a policy machine: the workspace switch is off, the document is locked, or
   * the asker's own role cannot publish here. Either way the model still drafts, and the
   * draft surfaces in the reply rather than being dropped.
   */
  writeBlock?: "switch" | "locked" | "role"
  /**
   * READ-ONLY tools, so a conversation about this document can reach the rest of the workspace
   * ("what did the roadmap say about this?") without leaving the rail.
   *
   * Deliberately read-only, and that is the whole design of this lane: the DOCUMENT's write goes
   * through the revision contract and the landing port below, which is what handles the mid-turn
   * race, the write-standing check and the post-publish fan-out. Handing this turn a `publish`
   * tool as well would give one document two write paths that decide differently — the exact
   * drift turn-core exists to prevent. Reach is additive; writing is not.
   *
   * Absent (undefined) ⇒ no tools, exactly as this lane ran before.
   */
  tools?: ChatToolSurface
  /** The skill index for those tools — one line each in the prompt, bodies read on demand. */
  skills?: { name: string; summary: string }[]
  /** The human this turn acts for — follower fan-out and version authorship. */
  onBehalf: { id: string; name: string } | null
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

/** What to tell the person when the turn produced nothing. The classification is the turn core's
 *  and shared; the WORDING is this lane's, because somebody is reading it. */
const apologyFor = (failure: NonNullable<TurnOutcome["failure"]>): string => {
  // Truncation is not a connectivity problem, and "try again" is advice that cannot work: the
  // reply did not fit and will not fit next time either. Reachable now only for a SMALL document
  // — anything large takes the edits contract, whose reply is bounded by the CHANGE — so "ask for
  // a smaller change" is honest advice here in a way it was not when it meant a 53KB page.
  if (failure.reason === "truncated")
    return "That reply was cut off before it finished, so nothing has been changed. Try asking for a smaller change."
  if (failure.reason === "model")
    return "I could not reach the model just now. Nothing has been changed — try again."
  if (failure.reason === "write") {
    // landInProcess throws BillingBlockedError with the billing copy verbatim when the write
    // is refused for billing, not a real write failure — turn-core's catch tags that onto
    // `billingBlocked`, so surface the exact message (actionable: an owner can fix it at the
    // billing URL) rather than the generic "try again", which would be dishonest advice here
    // since retrying changes nothing until the plan is fixed.
    if (failure.billingBlocked) return failure.error
    return "I could not save that change, so nothing has been written."
  }
  // The contract's own diagnostic when it had one — an edit that missed knows WHICH anchor
  // missed, and "nearest match was…" is the difference between a shrug and something the person
  // can act on.
  return (
    failure.reply ??
    "I tried to revise the document but could not produce a valid revision. Nothing has changed."
  )
}

/**
 * Run one turn against `artifact`, landing any write it produces. Never throws: a turn that
 * fails still returns a reply, because the transcript is what the person is looking at
 * and an empty conversation is a worse failure than an honest error message.
 */
export const runSessionTurn = async (deps: TurnDeps, input: TurnInput): Promise<TurnResult> => {
  const src = await sourceOf(deps, input.artifact)
  if (!src)
    return {
      reply: "I could not read this document's current contents, so I have not changed anything.",
      outcome: "failed",
      wrote: null,
      costMicroUsd: null,
    }

  // ANSWERABLE, which is the one way an attended contract differs from a run's: a reply with no
  // block is a perfectly good answer to a question, not a failure to follow the contract. The
  // whole-document-vs-edits choice is shared with the run lane and lives in turn-core.
  const contract = documentContract(src.text, true)

  const system = `You are helping someone edit a document they are looking at right now.

If they are asking you to CHANGE the document, reply with the revision block described below.
If they are asking a QUESTION, or thinking out loud, just answer them in prose — do NOT emit a
revision block, and do not change the document. Most messages are one or the other; decide which.

${contract.text}
${
  input.tools?.tools.length
    ? `\nYou can also look things up elsewhere in this workspace with: ${input.tools.tools
        .map((t) => t.name)
        .join(", ")}. Cite anything you use as a markdown link, [Title](/artifacts/<short_id>).${
        input.skills?.length
          ? `\nSkills carry the procedure — read one when you need it:\n${input.skills
              .map((sk) => `- ${sk.name} — ${sk.summary} — read derive://skills/${sk.name}`)
              .join("\n")}`
          : ""
      }\n`
    : ""
}
${documentContext(src.text, documentName(input.artifact.short_id, input.artifact.current_content_type), input.artifact.current_content_type ?? "text/html", !!input.tools?.tools.length)}`

  const out = await runTurn({
    system,
    messages: asTurns(input.transcript),
    contract,
    callModel: deps.callModel,
    tools: input.tools?.tools ?? [],
    executeTool: input.tools?.execute,
    // WITHOUT TOOLS nothing can extend the turn, so one attempt plus the single shared nudge is
    // the whole budget. WITH them the model needs room to look something up before it answers,
    // and the ceiling becomes the shared one every other tool-using lane runs on (which also
    // brings the announced last turn and the tool-output budget with it).
    maxTurns: input.tools?.tools.length ? DEFAULT_MAX_TURNS : NUDGE_LIMIT + 1,
    land: landInProcess(deps, input, src.version),
  })

  if (out.failure) {
    log.warn("attended turn produced nothing", {
      session: input.session.id,
      reason: out.failure.reason,
      error: out.failure.error,
    })
    return {
      reply: apologyFor(out.failure),
      outcome: "failed",
      wrote: null,
      costMicroUsd: toMicroUsd(out.costUsd),
    }
  }
  return {
    reply: out.reply || "(no reply)",
    outcome: out.outcome,
    // The in-process port only ever writes a version; every other WroteRef kind belongs
    // to the loop's create-a-new-one landing, which chat has no route to (it is always
    // ABOUT a document).
    wrote: out.wrote?.kind === "version" ? out.wrote : null,
    costMicroUsd: toMicroUsd(out.costUsd),
  }
}

/** The blocked write's reply: the drafted change, surfaced where the person already is. The
 *  lead names the actual reason, because "I did not change it" without one reads as a bug. */
const suggestionReply = (revision: Revision, why: "raced" | "switch" | "locked" | "role"): string =>
  suggestionText(revision, {
    lead: {
      raced:
        "Someone published a new version while I was working, so I did not write over it. Here is what I drafted:",
      switch:
        "This workspace has agent writes switched off, so I have not changed the document. Here is the change I drafted:",
      locked: "This document is locked, so I have not changed it. Here is the change I drafted:",
      role: "You can comment on this document but not publish to it, so I have not changed it. Here is the change I suggest:",
    }[why],
    tooBig: {
      raced:
        "The full draft is too large to paste here — ask again and I will redo it against the new version.",
      switch:
        "The full draft is too large to paste here. Switch agent writes back on and ask again, and I will apply it.",
      locked:
        "The full draft is too large to paste here. Unlock the document and ask again, and I will apply it.",
      role: "The full draft is too large to paste here. Someone who can publish to this document can ask for the same change.",
    }[why],
  })

/**
 * The ATTENDED landing: straight into the store, because this IS the API and the person is
 * waiting on the round trip. The loop substrate's port does the same job over HTTP; the split
 * is at lib/turn-core.ts's LandingPort and nowhere else.
 */
const landInProcess =
  (deps: TurnDeps, input: TurnInput, baseVersion: number): LandingPort =>
  async (revision: Revision) => {
    const bytes = new TextEncoder().encode(revision.content)
    // KEEP THE DOCUMENT'S OWN FORMAT. Deriving this from the model's filename silently converted
    // a Markdown doc to HTML the moment the model omitted or mangled the name — parseRevision
    // falls back to `index.html`, which is right when CREATING an artifact and wrong when editing
    // one. The result rendered as raw unformatted text, and nothing reported an error. An edit
    // changes content; the format is the document's, not the model's. Falls back to the filename
    // only for a document that somehow has no recorded type.
    const contentType =
      input.artifact.current_content_type ??
      (revision.filename.endsWith(".md")
        ? "text/markdown"
        : revision.filename.endsWith(".tex")
          ? "text/x-latex"
          : "text/html")
    const author = input.onBehalf?.name ?? "Derive"

    // A human published while the model was thinking. Surface rather than clobber: their write
    // is the one a person just made, and this turn's revision was drafted against a version
    // that is no longer current. The check is cheap and re-reads the artifact deliberately.
    const fresh = await deps.meta.getArtifactById(input.artifact.id)
    const raced = !!fresh && fresh.current_version !== baseVersion

    if (input.writeBlock || raced) {
      // Nothing is written. The drafted change surfaces in the reply — the person is
      // right here, and the transcript is the record — so the suggestion is never lost
      // and the document is never touched. A standing block outranks the race in the
      // wording: "ask again" is only honest advice when asking again could land.
      return {
        outcome: "commented",
        wrote: null,
        note: suggestionReply(revision, input.writeBlock ?? "raced"),
      }
    }

    // This is the branch that lands the live publish (the branch above writes nothing, which
    // stays free) — gated here, after the org is known and before any bytes are recorded as a
    // version. A refused write throws, same as landOverHttp's failed-request idiom
    // (lib/substrate-loop.ts): the turn reports it as a failed write rather than a settled one.
    const blocked = await deps.billingBlocked(input.artifact.org_id)
    if (blocked) throw new BillingBlockedError(blocked.message)

    const blobKey = await deps.blobs.put(bytes)
    const version = await deps.meta.addVersion(input.artifact.id, {
      id: newId("v"),
      blob_key: blobKey,
      content_type: contentType,
      size_bytes: bytes.byteLength,
      author,
      author_id: input.onBehalf?.id ?? null,
      // The built-in chat agent did the work, on the asker's behalf.
      agent_id: DERIVE_AUTHOR_ID,
      agent_name: DERIVE_AGENT_NAME,
      source: "api",
      message: revision.message ?? null,
      name: null,
    })
    // Same post-publish work as any other write — webhooks, realtime, re-anchor — so a chat
    // edit is indistinguishable downstream from one made in the editor. That is the point.
    await afterPublish(deps, input.artifact, version, {
      isNew: false,
      onBehalf: input.onBehalf?.id ?? null,
      // This revision was written by the Derive agent, even though its attribution belongs to
      // the human it serves. Leave actorId null so an intentional `@human` in the live body is
      // a real handoff, not suppressed as that human mentioning themself.
      actorId: null,
    })
    return {
      outcome: "published",
      wrote: { kind: "version", n: version.n },
      note: revision.message || `Done — published v${version.n}.`,
    }
  }
