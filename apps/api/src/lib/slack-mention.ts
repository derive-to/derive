// @Derive IN SLACK, anywhere the bot is invited.
//
// Its sibling is the Slack THREAD lane (slack-comments.ts): that one answers where a Derive
// comment thread is already mirrored, so the document is known and the answer is a comment. This
// one has no mirrored thread and no document, so it answers about the WORKSPACE with tools and
// skills, records the thread as one attended job, and settles with a threaded Slack reply.
//
// What makes it Slack-specific is only the three questions Slack cannot answer for us: WHO is
// asking (a Slack user id is not a principal), WHICH workspace this channel belongs to (one
// Slack team can back several), and WHERE the answer goes (a thread, not a channel).

import {
  type ArtifactRecord,
  artifactUrl,
  DERIVE_AGENT_ID,
  type JobRecord,
  type MetaStore,
  newId,
} from "@derive/core"
import type { Backplane } from "../bus"
import { log } from "../log"
import { liveChatArrival, refusalMessage } from "./chat-gate"
import { buildChatTools } from "./chat-tools"
import { runChatTurn } from "./chat-turn"
import { isServerNote } from "./jobs"
import type { ModelSource } from "./model-library"
import { slackUserEmail, updateSlackMessage } from "./slack"
import { mrkdwnBody } from "./slack-cards"
import { postWithRecovery, resolveBotToken } from "./slack-delivery"
import { CHAT_UNVERIFIED_NOTE, chatSeatFor, isVerifiedLink } from "./slack-identity"

/** How much of a Slack thread the turn is given. A mention usually arrives with a little
 *  context above it and the answer belongs to that, not to the channel's whole day. */
const THREAD_CONTEXT = 12

/** How long a Slack turn holds its job before the reaper may call it lost. Far past any turn
 *  ceiling, so only a crashed request ever reaches it. */
const SLACK_TURN_LEASE_MS = 10 * 60 * 1000

/** The Slack thread a job answers, from its meta_json, or null. */
const slackThreadOf = (raw: string | null): string | null => {
  if (!raw) return null
  try {
    return (JSON.parse(raw) as { slack_thread?: string }).slack_thread ?? null
  } catch {
    return null
  }
}

/** The Slack message ts recorded on an asker message, or null. Tolerates unparseable meta:
 *  a missing marker means "not seen", which costs a duplicate at worst and never a lost turn. */
export const parseSlackTs = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  try {
    return (JSON.parse(raw) as { slack?: { ts?: string } }).slack?.ts ?? null
  } catch {
    return null
  }
}

/** How long a failed identity lookup is trusted before we ask Slack again. Long enough that
 *  nobody gets a wall of identical prompts, short enough that somebody who joins Derive
 *  tomorrow starts working without intervention. Linking short-circuits it entirely: a link
 *  row replaces the miss and is checked first. */
export const MISS_TTL_MS = 24 * 60 * 60 * 1000

/**
 * What a stored identity row tells us to do next.
 *
 * Pure, and exported, because these three branches are the whole behaviour and the lane around
 * them needs Slack, a model and a store to exercise. The decision is the part that can be wrong
 * in a way nobody notices: too eager and we re-ask Slack about somebody on every message, too
 * sticky and a person who joined Derive yesterday is silently written off for ever.
 *
 *   "use"       a real link — resolve the seat from it.
 *   "silent"    a miss we recorded recently. Say nothing; they have already been told.
 *   "look"      no row, an aged-out miss, or a stamp we cannot read. Ask Slack again.
 *
 * A null or unparseable `checked_at` deliberately reads as "look": erring toward one extra
 * lookup beats erring toward somebody the bot has quietly stopped answering.
 */
export const identityVerdict = (
  known: { origin: string; checked_at: string | null } | null,
  now: number,
): "use" | "silent" | "look" => {
  if (!known) return "look"
  if (known.origin !== "miss") return "use"
  const at = known.checked_at ? Date.parse(known.checked_at) : Number.NaN
  const elapsed = now - at
  // Bounded at BOTH ends. Only checking the upper bound means a stamp written ahead of us —
  // clock skew between writer and reader, or a corrupt far-future date — reads as permanently
  // fresh and silences this person for ever. A negative elapsed is not evidence of anything,
  // so it costs one extra lookup instead.
  return elapsed >= 0 && elapsed < MISS_TTL_MS ? "silent" : "look"
}

export interface SlackMentionPayload {
  teamId: string
  channel: string
  /** The mention message's own ts — the thread root when it is not itself a reply. */
  ts: string
  threadTs?: string
  userId: string
  text: string
}

export interface SlackMentionDeps {
  meta: MetaStore
  bus: Backplane
  baseUrl: string
  /** Read PER TURN (lib/model-library.ts), not held: this sender is built once at boot, and a
   *  held catalog would answer every future mention with the model the process started with. */
  models: ModelSource
  encryptionKey: string | undefined
  ctx: Parameters<typeof buildChatTools>[0]
  chatAllowlist?: string[]
  /**
   * The ask limiter, keyed HERE by the Slack person rather than by the request's actor.
   *
   * Every other chat arrival is an HTTP request from a signed-in human, so `limited(c, …)`
   * keys on them naturally. A Slack event is a webhook from Slack's own infrastructure: the
   * request actor is Slack, so the usual keying would put every channel in one bucket and let
   * one noisy person throttle the whole workspace.
   *
   * It matters more here than anywhere else, because the other ceiling does not bite: a
   * gateway deploy has no per-workspace model plan, so `overBudget` reads no limit and returns
   * false. Without this, a mention loop spends the operator's key with nothing in the way.
   */
  askLimiter?: ((key: string) => Promise<{ ok: boolean; retryAfter?: number }>) | null
}

/** Strip the `<@BOT>` token(s) so the model reads the question, not Slack's wire format. */
export const questionFrom = (text: string, botUserId: string | null): string =>
  (botUserId ? text.replaceAll(`<@${botUserId}>`, " ") : text).replace(/\s+/g, " ").trim()

/**
 * A Derive artifact named in the message — the closest thing Slack has to a subject.
 *
 * Slack wraps pasted URLs as `<url>` or `<url|label>`, so match inside the angle brackets. The
 * short_id is the LAST path segment's trailing token, which is how every Derive URL is shaped
 * (`/artifacts/pricing-faq-8myxva5b`).
 */
export const artifactRefIn = (text: string, baseUrl: string): string | null => {
  const host = baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  // Escaped properly: the previous character class was malformed and escaped NOTHING, so every
  // `.` in the host stayed a wildcard and a lookalike host (`derive-prXderive-toXworkersXdev`)
  // matched. Bounded by the org check below either way, but a host match that is not a host
  // match is the kind of wrong that grows a second bug later.
  // Escaped properly. The previous character class was malformed and escaped NOTHING, so every
  // `.` in the host stayed a wildcard and a lookalike host (`derive-prXderive-toXworkersXdev`)
  // matched — bounded by the org check below, but a host match that is not a host match is the
  // kind of wrong that grows a second bug later.
  //
  // The slug class is spelled out rather than `\w`: this is a TEMPLATE literal, where `\w` is
  // not a recognised escape and collapses to a bare `w` — which silently narrows the pattern to
  // two characters and stops matching any real short id. (Caught by running it, not reading it.)
  const re = new RegExp(
    `https?://${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/artifacts/([A-Za-z0-9_-]+)`,
    "i",
  )
  const m = re.exec(text)
  if (!m?.[1]) return null
  const slug = m[1]
  const tail = slug.split("-").pop() ?? slug
  return /^[a-z0-9]{6,12}$/i.test(tail) ? tail : null
}

/**
 * Serve one @Derive mention from Slack. Never throws — this runs off the event ack, and a
 * failure has to reach the person in the thread rather than a log nobody reads.
 */
export const handleSlackMention = async (
  deps: SlackMentionDeps,
  p: SlackMentionPayload,
): Promise<{ status: string }> => {
  const { meta } = deps
  const quiet = (status: string) => {
    log.info("slack mention not answered", { team: p.teamId, channel: p.channel, status })
    return { status }
  }

  const installs = await meta.listSlackInstallsByTeam(p.teamId).catch(() => [])
  if (installs.length === 0) return quiet("no install")

  // WHO. A Slack user id is not a Derive principal: the turn acts as the asker, reads with
  // their permissions and spends against their workspace, so an unlinked account has nobody to
  // act as. They are told how to fix it rather than ignored.
  const seatFor = async (orgId: string, userId: string) => {
    const seat = await meta.getMembership(orgId, userId).catch(() => null)
    if (!seat) return null
    const user = (await meta.getUsers([userId]).catch(() => []))[0]
    return { id: userId, name: user?.name ?? "someone", role: seat.role }
  }

  /**
   * An EXPLICIT link wins, then the Slack profile's email.
   *
   * Requiring a link first was correct about the principal and wrong about the friction: the
   * whole point of answering in Slack is that somebody is already there, and "go to a settings
   * page and come back" is exactly the moment they stop. Email is the identifier both systems
   * already hold, and a Slack profile email was verified by the workspace's own directory.
   *
   * It is a FALLBACK, not a replacement. An explicit link is a deliberate statement about who
   * somebody is and survives an email change; this only runs when there is none. Membership is
   * still checked either way, so resolving an identity never grants access on its own — a
   * matched email with no seat in this workspace is still nobody here.
   */
  /**
   * WHO IS ASKING — optimistically, and quietly once we know we cannot tell.
   *
   * An explicit link always wins: it is a deliberate statement about identity and survives an
   * email change. Absent one, the Slack profile email resolves the seat, because the point of
   * answering in Slack is that somebody is already there and "go to a settings page and come
   * back" is exactly where they stop. Email is the identifier both systems already hold and the
   * workspace's own directory verified. Never a display name — those are neither unique nor
   * stable nor hard to set to somebody else's.
   *
   * A MISS IS REMEMBERED, on the same row, so a person we cannot place is asked once rather than
   * on every message, and we stop calling Slack about them. It ages out (MISS_TTL_MS) so a Derive
   * account created tomorrow starts working on its own, and any success replaces it outright —
   * self-healing, no cleanup job.
   *
   * Returns the seat, or a reason: "unknown" (tell them how to fix it) vs "recent-miss" (already
   * told them; say nothing).
   */
  const linkedFor = async (
    orgId: string,
    botToken: string,
  ): Promise<
    | { seat: Awaited<ReturnType<typeof seatFor>>; verified: boolean }
    | { seat: null; why: "unknown" | "recent-miss" }
  > => {
    const known = await meta.getSlackIdentityState(p.teamId, p.userId).catch(() => null)
    const verdict = identityVerdict(known, Date.now())
    if (verdict === "use" && known) {
      const seat = await seatFor(orgId, known.user_id)
      // `verified` travels with the seat because the turn's POWERS depend on it, not just its
      // name: an email match says who somebody probably is, and only a deliberate link lets us
      // act as them. See lib/slack-identity.ts.
      if (seat) return { seat, verified: isVerifiedLink(known) }
      // A link to somebody with no seat HERE is not a miss about their identity — they may well
      // be a member of another workspace on this team — so it is not remembered.
      return { seat: null, why: "unknown" }
    }
    if (verdict === "silent") return { seat: null, why: "recent-miss" }

    const email = await slackUserEmail(botToken, p.userId)
    const user = email ? await meta.findUserByEmail(email).catch(() => null) : null
    const seat = user ? await seatFor(orgId, user.id) : null
    await meta
      .setSlackUserLink({
        id: known?.id ?? newId("sul"),
        org_id: orgId,
        // Empty on a miss: there is nobody to point at, which is why the filtered accessors
        // never hand this row to code that would try to use it.
        user_id: seat?.id ?? "",
        team_id: p.teamId,
        slack_user_id: p.userId,
        origin: seat ? "email" : "miss",
        created_at: known?.created_at ?? new Date().toISOString(),
        checked_at: new Date().toISOString(),
      })
      .catch(() => {})
    // Resolved by email, which is exactly what this branch just recorded: enough to answer as
    // them, never enough to write as them.
    return seat ? { seat, verified: false } : { seat: null, why: "unknown" }
  }

  // WHICH WORKSPACE. One Slack team can back several Derive workspaces, so the channel's own
  // subscription is the answer when it has one; a single install is unambiguous on its own.
  let candidates = installs
  if (installs.length > 1) {
    const subscribed: (typeof installs)[number][] = []
    for (const i of installs) {
      const subs = await meta.listSlackSubscriptions(i.org_id).catch(() => [])
      if (subs.some((s) => s.channel_id === p.channel)) subscribed.push(i)
    }
    if (subscribed.length) candidates = subscribed
  }
  const install = candidates[0]
  if (!install) return quiet("no workspace for this channel")

  const bot = await resolveBotToken(meta, install.org_id, deps.encryptionKey)
  if (!bot) return quiet("slack not connected")

  /**
   * Reply in the thread the mention is in.
   *
   * ESCAPED, because this text is MODEL OUTPUT and Slack's mrkdwn is not inert: `<!channel>`
   * notifies everyone in the channel, and `<url|label>` renders a link whose visible text need
   * not match where it points. A model's reply is shaped by the documents it just read, so a
   * document anybody in the workspace can edit would otherwise be able to ping a channel or
   * plant a disguised link. escapeMrkdwn neutralises the three characters that make those
   * possible; our own continue-link is appended AFTER escaping, so it still renders.
   *
   * Never throws: a failed post must not fail the event handler, which Slack would retry.
   */
  const say = async (text: string) => {
    await postWithRecovery(meta, install.org_id, bot.token, {
      channel: p.channel,
      threadTs: p.threadTs ?? p.ts,
      text,
    }).catch((e) =>
      log.warn("slack mention reply failed", { error: e instanceof Error ? e.message : String(e) }),
    )
  }

  // STILL AMBIGUOUS ⇒ refuse rather than guess. Answering as the wrong workspace would read
  // someone else's documents into this channel, which is the one mistake here that matters —
  // and it is invisible to the person reading the answer, which is what makes it worse than
  // saying nothing. Said out loud, with the fix, rather than logged.
  if (candidates.length > 1) {
    await say(
      "This channel is tied to more than one Derive workspace, so I do not know which one you mean. Subscribe it to one of them with `/derive settings` and mention me again.",
    )
    return quiet("ambiguous workspace")
  }

  const resolved = await linkedFor(install.org_id, bot.token)
  const asker = resolved.seat
  if (!asker) {
    if ("why" in resolved && resolved.why === "recent-miss") return quiet("asker not linked (told)")
    // SAY IT ONCE. Somebody a bot ignores will keep asking — that is the normal thing to do —
    // and answering every message with the same paragraph turns a one-time setup step into a
    // wall of identical text. They are told, clearly, with a link that works; after that the
    // miss row above keeps us quiet until it ages out or they fix it.
    await say(
      `I answer with *your* permissions, so I need to know who you are. ` +
        `<${deps.baseUrl}/settings/notifications|Link your Derive account> and ask me again.\n\n` +
        `If your Slack email already matches your Derive account, linking is not needed — ` +
        `check that the two match.`,
    )
    return quiet("asker not linked")
  }

  // EVERY RUNG, ONCE (lib/chat-gate.ts). Keyed on the Slack PERSON: the request actor here is
  // Slack itself, so the usual actor keying would put a whole workspace in one bucket.
  const gate = await liveChatArrival(
    {
      meta,
      models: deps.models,
      chatAllowlist: deps.chatAllowlist,
      askLimiter: deps.askLimiter,
    },
    {
      org: install.org_id,
      userId: asker.id,
      rateKey: `slack:${p.teamId}:${p.userId}`,
    },
  )
  if (!gate.ok) {
    // A person is watching the thread, so a refusal is SAID. The two that leak nothing about a
    // workspace they may not belong to are the only ones worth staying quiet about.
    if (gate.reason !== "not_enabled" && gate.reason !== "not_allowlisted")
      await say(refusalMessage(gate.reason))
    return quiet(gate.reason)
  }
  const { settings, model } = gate

  const question = questionFrom(p.text, bot.install.bot_user_id)
  if (!question) {
    await say("Ask me something in the same message and I will answer it here.")
    return quiet("empty question")
  }

  // ONE JOB PER THREAD, so a follow-up mention continues the conversation instead of starting a
  // new one, and so the turn's cost lands on job.cost_micro_usd where the monthly budget reads
  // it. The job is attended (someone is waiting in the thread, and this request serves it), on
  // the built-in Derive rather than an agent row, and private to the asker (routes/jobs.ts).
  const thread = `slack:${p.teamId}:${p.channel}:${p.threadTs ?? p.ts}`
  const lease = () => new Date(Date.now() + SLACK_TURN_LEASE_MS).toISOString()
  // This person's own recent Derive jobs in this workspace, newest first and capped, so the
  // scan is bounded by the page size and needs no by-key store method on three dialects.
  let existing = (
    await meta
      .listJobs({
        orgId: install.org_id,
        agentId: DERIVE_AGENT_ID,
        askedBy: asker.id,
        kind: ["ask"],
        limit: 50,
      })
      .catch(() => [])
  ).find((j) => slackThreadOf(j.meta_json) === thread)

  let created: JobRecord | null = null
  if (!existing) {
    try {
      created = await meta.createJob({
        id: newId("job"),
        org_id: install.org_id,
        agent_id: DERIVE_AGENT_ID,
        kind: "ask",
        instruction: question,
        asked_by: asker.id,
        // The asker's: a personal budget counts only their jobs, the pool's counts every job.
        payer_id: asker.id,
        attended: 1,
        // A Derive link in the message is named in the question below; otherwise the
        // workspace is the ground.
        subject_json: null,
        meta_json: JSON.stringify({ via: "slack", slack_thread: thread }),
        // Two first deliveries racing would otherwise open two jobs for one thread: the
        // open-job dedupe index lets one win, and the loser continues the winner's job.
        dedupe_key: thread,
      })
    } catch (error) {
      existing = (await meta.findOpenJobByDedupe(DERIVE_AGENT_ID, asker.id, thread)) ?? undefined
      if (!existing) throw error
    }
  }

  let job: JobRecord | null
  if (existing) {
    // SLACK DELIVERS AT LEAST ONCE. A redelivery (30s/1min/5min later, routinely on another
    // isolate) lands here, finds the thread's job, and would append the same question again:
    // a second paid turn and a second answer posted into the thread. The thread key does not
    // stop it, deliberately, so follow-ups continue one conversation.
    //
    // So the guard is the Slack message ts, scanned off the transcript (the same shape the
    // ingest path uses, slack-comments.ts). It is DB state, which is what makes it survive the
    // retry landing somewhere else. The marker is written IN THE SAME insert as the message:
    // written afterwards, a retry racing the first attempt would not see it.
    const already = (await meta.listJobMessages(existing.id).catch(() => [])).some(
      (m) => parseSlackTs(m.meta_json) === p.ts,
    )
    if (already) return quiet("duplicate slack delivery")
    job = existing
  } else if (created) {
    job = created
  } else {
    return quiet("job not opened")
  }
  await meta.addJobMessage({
    id: newId("jm"),
    job_id: job.id,
    author_kind: "asker",
    author_id: asker.id,
    body_md: question,
    meta_json: JSON.stringify({ slack: { ts: p.ts } }),
  })
  // Running under a lease while this request serves it: a crash mid-turn leaves the job to
  // lapse to `lost` (the reaper's rule for attended jobs) rather than read as running for ever.
  const startedAt = new Date().toISOString()
  job = await meta.updateJob(job.id, {
    status: "running",
    started_at: startedAt,
    finished_at: null,
    needs_json: null,
    lease_until: lease(),
  })
  if (!job) return quiet("job vanished")
  const jobId = job.id
  /** Settle the thread's job. Best effort: the answer in Slack matters more than the row. */
  const settleJob = async (status: "succeeded" | "failed", costMicroUsd: number | null) => {
    if (costMicroUsd) await meta.addJobCost(jobId, costMicroUsd).catch(() => null)
    await meta
      .updateJob(
        jobId,
        { status, finished_at: new Date().toISOString(), lease_until: null },
        { status: "running", started_at: startedAt },
      )
      .catch((e) => log.warn("slack mention job settle failed", { job: jobId, error: String(e) }))
  }

  // A document named in the message is the strongest available ground, so say so in the
  // question rather than modelling it as a subject: this lane's tools can read it by short_id,
  // which is exactly what the finding skill tells the model to do.
  const ref = artifactRefIn(p.text, deps.baseUrl)
  let named: ArtifactRecord | null = null
  if (ref) named = await meta.getByShortId(ref).catch(() => null)
  const grounded =
    named && named.org_id === install.org_id
      ? `${question}\n\n(The person linked this document: ${named.title ?? named.short_id} — short_id ${named.short_id}.)`
      : question

  // SAY SOMETHING IMMEDIATELY, because a turn takes seconds and Slack gives no other signal.
  //
  // There is no bot "typing" API on the Events API — the RTM typing event is not available to
  // apps, and assistant.threads.setStatus only exists inside Assistant threads. So the honest
  // equivalent is a placeholder that BECOMES the answer: posted now, rewritten in place by
  // chat.update when the turn settles. One message, not two, so the thread does not collect
  // "thinking…" litter next to every reply.
  //
  // Best-effort on purpose. If this post fails the turn still runs and answers with a fresh
  // message — losing the progress hint costs nothing, whereas failing the question costs the
  // answer. `pending` therefore stays null on any error and the tail falls back to posting.
  const pending = await postWithRecovery(meta, install.org_id, bot.token, {
    channel: p.channel,
    threadTs: p.threadTs ?? p.ts,
    text: "_Derive is thinking…_",
  })
    .then((r) => (r.ok && r.ts ? { channel: r.channel ?? p.channel, ts: r.ts } : null))
    .catch(() => null)

  /** Replace the placeholder with the real text, or post it if there is no placeholder to
   *  replace. Every exit below goes through this, so no thread is left reading "thinking…". */
  const settle = async (text: string) => {
    if (!pending) return await say(text)
    await updateSlackMessage(bot.token, { channel: pending.channel, ts: pending.ts, text }).catch(
      async (e) => {
        log.warn("slack placeholder update failed", { error: String(e) })
        await say(text)
      },
    )
  }

  // FROM HERE ON, SOMEONE IS WAITING IN A THREAD. runChatTurn does not throw, but the writes
  // around it can (a dropped connection mid-settle, a store error), and the failure mode that
  // costs the most trust is silence: the bot was mentioned in front of the channel and simply
  // never spoke. So the tail answers even when it fails.
  try {
    // The whole enforcement for this lane: an email-matched asker acts at `viewer`, and the
    // tools take their ceiling from the seat, so every write stops without a check of its own.
    // Reads are untouched. See lib/slack-identity.ts for why, and for the note below.
    const actingRole = chatSeatFor(resolved.verified, gate.seatRole)
    const tools = buildChatTools(deps.ctx, {
      org: install.org_id,
      user: { id: asker.id, name: asker.name },
      seatRole: actingRole,
      flags: { agentWrites: settings.agentWrites },
    })
    const res = await runChatTurn(
      { model },
      {
        jobId,
        transcript: [
          ...(await meta.listJobMessages(jobId))
            .filter((m) => !isServerNote(m))
            .slice(0, -1)
            .slice(-THREAD_CONTEXT),
          { author_kind: "asker", body_md: grounded },
        ],
        tools,
        workspaceName:
          (await meta.getWorkspace(install.org_id).catch(() => null))?.name ?? "this workspace",
        asker: {
          name: asker.name,
          role: actingRole,
          // The clamp is silent from inside the turn, so the reason travels with it — see
          // CHAT_UNVERIFIED_NOTE for what goes wrong when it does not.
          ...(resolved.verified ? {} : { note: CHAT_UNVERIFIED_NOTE }),
        },
        skills: tools.skills,
      },
    )

    // The transcript is the record: the Slack message is a rendering of the answer, not the
    // answer itself. `model` and `model_ms` feed the operator's model timings.
    await meta.addJobMessage({
      id: newId("jm"),
      job_id: jobId,
      author_kind: "agent",
      author_id: DERIVE_AGENT_ID,
      body_md: res.reply,
      meta_json: JSON.stringify({
        outcome: res.outcome,
        model: res.model,
        model_ms: res.modelMs,
        via: "slack",
      }),
    })
    await settleJob(res.outcome === "failed" ? "failed" : "succeeded", res.costMicroUsd)

    // AN ANSWER IS PROSE, not a label, so it goes through mrkdwnBody rather than escapeMrkdwn:
    // the model writes markdown, and escaping alone left `**bold**` as asterisks and every
    // citation as literal `[Title](/artifacts/x)` — the most useful part of an answer rendered
    // as punctuation.
    //
    // Citations are ROOT-RELATIVE by design (the agent cites by path, knowing no hostname), and
    // mrkdwnBody only linkifies absolute http(s) targets — correctly, since a relative href
    // means nothing in Slack. So they are absolutised against this instance FIRST. The pattern
    // stays strict for the same reason it is strict in the web renderer: a leading slash then an
    // alphanumeric admits /artifacts/x and excludes both `javascript:` and the protocol-relative
    // `//evil.com`.
    const withLinks = res.reply.replace(
      /\]\((\/[A-Za-z0-9][\w\-./?=&#%]*)\)/g,
      (_m, path: string) => `](${deps.baseUrl}${path})`,
    )
    // The page the question was about, when the message named one, is where to carry on; a
    // question about the whole workspace has no page to send anyone to.
    const onward =
      named && named.org_id === install.org_id
        ? `\n\n<${artifactUrl(deps.baseUrl.replace(/\/$/, ""), named)}|Open in Derive>`
        : ""
    await settle(`${mrkdwnBody(withLinks)}${onward}`)
  } catch (e) {
    log.error("slack mention turn failed", {
      team: p.teamId,
      channel: p.channel,
      error: e instanceof Error ? e.message : String(e),
    })
    // Through settle, so a crash REPLACES "thinking…" rather than leaving it there for ever —
    // a placeholder that never resolves reads as a hung bot, which is worse than an error.
    await settle("Something went wrong on my side, so I have not answered that. Try me again.")
    await settleJob("failed", null)
    return quiet("turn failed")
  }
  return { status: "answered" }
}
