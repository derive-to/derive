// Discovery surfaces for the connected Slack app: link unfurls, the `/derive` slash
// command, and the App Home tab. All three show an artifact OUTSIDE the notify() event
// stream, so they read a small self-contained summary and resolve the workspace from the
// Slack `team_id` (via getSlackInstallByTeam) rather than a Derive session. Kept out of
// routes/slack.ts so the route file stays a thin wiring layer over testable functions.

import type { ArtifactRecord, MetaStore, SlackInstallRecord } from "@derive/core"
import { artifactUrl, parseRef } from "@derive/core"
import { decryptSecret } from "./crypto"
import { publishSlackHomeView, unfurlSlackLink } from "./slack"
import {
  type ArtifactSummary,
  homeView,
  searchResultBlocks,
  shareCard,
  unfurlCard,
} from "./slack-cards"
import { postWithRecovery } from "./slack-delivery"

export interface DiscoveryDeps {
  meta: MetaStore
  baseUrl: string
  encryptionKey: string | undefined
}

// Only artifacts the world link already exposes. Invite-only (link_role "none") and
// password-locked stay opaque (Q-E1: suppress) — even the title could be sensitive, and a
// channel post is public to everyone in the channel. Same gate as routes/embeds.ts.
const isShareable = (a: ArtifactRecord): boolean => a.link_role !== "none" && !a.password_hash

const summarize = (baseUrl: string, a: ArtifactRecord): ArtifactSummary => ({
  short_id: a.short_id,
  title: a.title,
  url: artifactUrl(baseUrl, a),
  kind: a.kind,
  version: a.current_version,
  updatedAt: a.updated_at ?? undefined,
})

/** Extract a Derive artifact short id from a shared URL (`…/artifacts/<slug>-<shortId>`). */
export const refFromUrl = (url: string): string | null => {
  try {
    const m = new URL(url).pathname.match(/\/artifacts\/([^/?#]+)/)
    return m?.[1] ? parseRef(m[1]).shortId : null
  } catch {
    return null
  }
}

const tokenFor = (install: SlackInstallRecord, key: string | undefined): string | null =>
  key ? decryptSecret(install.bot_token, key) : null

/** link_shared → chat.unfurl. Preview each shared artifact link this workspace owns and is
 *  entitled to describe; skip everything else, so a bad link just stays a plain URL. */
export const handleLinkShared = async (
  deps: DiscoveryDeps,
  teamId: string | undefined,
  event: { channel?: string; message_ts?: string; links?: { url?: string }[] },
): Promise<void> => {
  if (!teamId || !event.channel || !event.message_ts || !event.links?.length) return
  const install = await deps.meta.getSlackInstallByTeam(teamId)
  const token = install && tokenFor(install, deps.encryptionKey)
  if (!install || !token) return
  const unfurls: Record<string, { blocks: unknown[] }> = {}
  for (const l of event.links) {
    const shortId = l.url ? refFromUrl(l.url) : null
    if (!shortId || !l.url) continue
    const a = await deps.meta.getByShortId(shortId)
    if (!a || a.org_id !== install.org_id || !isShareable(a)) continue
    unfurls[l.url] = unfurlCard(summarize(deps.baseUrl, a))
  }
  if (Object.keys(unfurls).length)
    await unfurlSlackLink(token, { channel: event.channel, ts: event.message_ts, unfurls })
}

/** app_home_opened → views.publish. A linked user gets a greeting + recent artifacts; an
 *  unlinked user gets a prompt to link from Derive settings. Best-effort. */
export const handleAppHomeOpened = async (
  deps: DiscoveryDeps,
  teamId: string | undefined,
  event: { user?: string; tab?: string },
): Promise<void> => {
  if ((event.tab && event.tab !== "home") || !teamId || !event.user) return
  const install = await deps.meta.getSlackInstallByTeam(teamId)
  const token = install && tokenFor(install, deps.encryptionKey)
  if (!install || !token) return
  const linkRow = await deps.meta.getSlackUserLinkBySlackId(install.org_id, event.user)
  let linkedName: string | null = null
  if (linkRow?.status === "confirmed") {
    const [u] = await deps.meta.getUsers([linkRow.user_id])
    linkedName = u?.name ?? u?.username ?? "there"
  }
  const recent = await deps.meta.listArtifacts({ orgId: install.org_id, limit: 5 })
  const view = homeView({
    linkedName,
    items: recent.filter((a) => isShareable(a)).map((a) => summarize(deps.baseUrl, a)),
    baseUrl: deps.baseUrl,
  })
  await publishSlackHomeView(token, event.user, view)
}

/** Post an artifact's card into a channel (shared `/derive share` + Share-button path). Only
 *  shareable visibilities; auto-joins a public channel. Returns whether it posted. */
export const shareArtifact = async (
  deps: DiscoveryDeps,
  install: SlackInstallRecord,
  channel: string,
  shortId: string,
): Promise<boolean> => {
  const token = tokenFor(install, deps.encryptionKey)
  const a = await deps.meta.getByShortId(shortId)
  if (!token || !a || a.org_id !== install.org_id || !isShareable(a)) return false
  const card = shareCard(summarize(deps.baseUrl, a))
  const res = await postWithRecovery(
    deps.meta,
    install.org_id,
    token,
    { channel, text: card.text, blocks: card.blocks },
    { autoJoin: true, textFallback: true },
  )
  return res.ok
}

/** The Slack response body a `/derive` slash command replies with (all ephemeral). */
export interface SlashResult {
  response_type: "ephemeral"
  text?: string
  blocks?: unknown[]
}

/** Parse + handle `/derive [find] <query>` and `/derive share <ref>`. Find returns an
 *  ephemeral result list with Share buttons; share posts the card and confirms. */
export const handleSlashCommand = async (
  deps: DiscoveryDeps,
  form: { team_id?: string; channel_id?: string; text?: string },
): Promise<SlashResult> => {
  const install = form.team_id ? await deps.meta.getSlackInstallByTeam(form.team_id) : null
  if (!install)
    return { response_type: "ephemeral", text: "This Slack workspace isn't connected to Derive." }

  const raw = (form.text ?? "").trim()
  const [verb, ...rest] = raw.split(/\s+/)
  const arg = rest.join(" ").trim()

  if (verb?.toLowerCase() === "share" && arg) {
    const shortId = refFromUrl(arg) ?? parseRef(arg).shortId
    const ok = !!form.channel_id && (await shareArtifact(deps, install, form.channel_id, shortId))
    return {
      response_type: "ephemeral",
      text: ok ? "Shared to this channel." : "Couldn't share that artifact (not found or private).",
    }
  }

  const query = verb?.toLowerCase() === "find" ? arg : raw
  const results = await deps.meta.listArtifacts({
    orgId: install.org_id,
    q: query || undefined,
    limit: 20,
  })
  const shareable = results.filter((a) => isShareable(a)).slice(0, 5)
  return {
    response_type: "ephemeral",
    blocks: searchResultBlocks(
      query,
      shareable.map((a) => summarize(deps.baseUrl, a)),
      install.org_id,
    ),
  }
}
