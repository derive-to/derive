// @Derive IN SLACK, anywhere the bot is invited — the fourth arrival on the same turn.
//
// Its sibling is the Slack THREAD lane (slack-comments.ts): that one answers where a Derive
// comment thread is already mirrored, so the document is known and the answer is a comment. This
// one has no mirrored thread and no document, so it is the WORKSPACE chat wearing Slack — the
// same session, the same tools, the same skills — and its settle is a threaded Slack reply.
//
// What makes it Slack-specific is only the three questions Slack cannot answer for us: WHO is
// asking (a Slack user id is not a principal), WHICH workspace this channel belongs to (one
// Slack team can back several), and WHERE the answer goes (a thread, not a channel).

import { type ArtifactRecord, type MetaStore, newId } from "@derive/core"
import type { Backplane } from "../bus"
import { log } from "../log"
import { overBudget } from "./budget"
import { buildChatTools } from "./chat-tools"
import { runChatTurn } from "./chat-turn"
import type { ModelCatalog } from "./model-catalog"
import { postWithRecovery, resolveBotToken } from "./slack-delivery"

/** How much of a Slack thread the turn is given. A mention usually arrives with a little
 *  context above it and the answer belongs to that, not to the channel's whole day. */
const THREAD_CONTEXT = 12

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
  models: ModelCatalog
  encryptionKey: string | undefined
  ctx: Parameters<typeof buildChatTools>[0]
  chatAllowlist?: string[]
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
  const re = new RegExp(
    `https?://${host.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/artifacts/([\\w-]+)`,
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
  const linkedFor = async (orgId: string) => {
    const link = await meta.getSlackUserLinkBySlackId(p.teamId, p.userId).catch(() => null)
    if (!link) return null
    const seat = await meta.getMembership(orgId, link.user_id).catch(() => null)
    if (!seat) return null
    const user = (await meta.getUsers([link.user_id]).catch(() => []))[0]
    return { id: link.user_id, name: user?.name ?? "someone", role: seat.role }
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

  /** Reply in the thread the mention is in. Never throws: a failed post must not fail the
   *  event handler, which Slack would then retry. */
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

  const asker = await linkedFor(install.org_id)
  if (!asker) {
    await say(
      `Link your Derive account to ask me here — I answer with *your* permissions, so I need to know who you are. ${deps.baseUrl}/settings/integrations`,
    )
    return quiet("asker not linked")
  }

  // The same gates every other chat arrival walks.
  const settings = await meta.getOrgSettings(install.org_id).catch(() => null)
  if (!settings?.chatBeta) return quiet("chat not enabled")
  if (deps.chatAllowlist?.length && !deps.chatAllowlist.includes(install.org_id))
    return quiet("workspace not allowlisted")
  if (await overBudget(meta, install.org_id, asker.id).catch(() => false)) {
    await say("This workspace has reached its monthly model budget, so I cannot answer right now.")
    return quiet("over budget")
  }
  const model = deps.models.resolve(null)
  if (!model) return quiet("no model configured")

  const question = questionFrom(p.text, bot.install.bot_user_id)
  if (!question) {
    await say("Ask me something in the same message and I will answer it here.")
    return quiet("empty question")
  }

  // ONE SESSION PER THREAD, so a follow-up mention continues the conversation instead of
  // starting a new one — and so the transcript is readable on /chat, which is what makes an
  // answer that outgrows Slack portable rather than stranded.
  const dedupe = `slack:${p.teamId}:${p.channel}:${p.threadTs ?? p.ts}`
  // Reuses `listChatSessions` rather than adding a by-key lookup: it is this person's own
  // sessions in this workspace, newest first and already capped, so the scan is bounded by the
  // page size and needs no new store method on three dialects.
  const existing = (await meta.listChatSessions(install.org_id, asker.id, 50).catch(() => [])).find(
    (x) => x.dedupe_key === dedupe,
  )

  let sessionId: string
  if (existing) {
    await meta.appendFollowupReopen({
      id: newId("sm"),
      session_id: existing.id,
      author_kind: "asker",
      author_id: asker.id,
      body_md: question,
    })
    sessionId = existing.id
  } else {
    const created = await meta.createSessionWithMessage(
      {
        id: newId("ses"),
        context_id: null,
        context_version: null,
        org_id: install.org_id,
        asker_id: asker.id,
        dedupe_key: dedupe,
        // A Derive link in the message pins the document; otherwise the workspace is the ground.
        subject_ref: null,
      },
      { id: newId("sm"), author_kind: "asker", author_id: asker.id, body_md: question },
      "open",
    )
    sessionId = created.session.id
  }

  const session = await meta.getSession(sessionId)
  if (!session) return quiet("session vanished")

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

  const tools = buildChatTools(deps.ctx, {
    org: install.org_id,
    user: { id: asker.id, name: asker.name },
    seatRole: asker.role,
  })
  const res = await runChatTurn(
    { model },
    {
      session,
      transcript: [
        ...(await meta.listSessionMessages(sessionId)).slice(0, -1).slice(-THREAD_CONTEXT),
        {
          id: "pending",
          session_id: sessionId,
          author_kind: "asker",
          author_id: asker.id,
          body_md: grounded,
          meta: null,
          created_at: new Date().toISOString(),
        },
      ],
      tools,
      workspaceName:
        (await meta.getWorkspace(install.org_id).catch(() => null))?.name ?? "this workspace",
      asker: { name: asker.name },
      skills: tools.skills,
    },
  )

  // The transcript is the record on every other lane, so it is here too: the Slack message is a
  // rendering of the answer, not the answer itself. That is what makes the /chat link work.
  await meta.addSessionMessage(
    {
      id: newId("sm"),
      session_id: sessionId,
      author_kind: "agent",
      author_id: "derive",
      body_md: res.reply,
      meta: JSON.stringify({ outcome: res.outcome, model: res.model, via: "slack" }),
    },
    res.outcome === "failed" ? "failed" : "answered",
  )

  await say(`${res.reply}\n\n<${deps.baseUrl}/chat?session=${sessionId}|Continue in Derive>`)
  return { status: "answered" }
}
