// Block Kit for the /derive slash command's ephemeral responses (only the invoker sees them).
// Pure formatters — the route resolves the linked user, runs the visibility-scoped search /
// recent-list, and hands the hits here.

import { type ArtifactRecord, artifactUrl } from "@derive/core"
import type { SearchHit } from "./search"
import { context, mrkdwnLabel, section } from "./slack-cards"

// A `<url|text>` link with the (untrusted) title escaped so it can't break out of the link.
const artifactLink = (url: string, title: string | null, shortId: string): string =>
  `<${url}|${mrkdwnLabel(title || shortId)}>`

/** Prompt an unlinked user to link first — search must be scoped to what THEY can see, which
 *  needs the account link (there is no Derive principal for a raw Slack user otherwise). */
export const notLinkedBlocks = (baseUrl: string): unknown[] => [
  section(
    "Link your Slack account to search Derive from here — results are scoped to what *you* can see.",
  ),
  context(`<${baseUrl}/settings/notifications|Link your account in Derive settings>`),
]

/** Search results (visibility already applied by the caller). Titles link to the artifact. */
export const deriveResultsBlocks = (
  baseUrl: string,
  query: string,
  hits: SearchHit[],
): unknown[] => {
  const q = mrkdwnLabel(query, 100)
  if (hits.length === 0) return [section(`No artifacts match *${q}*.`)]
  return [
    section(`*Results for* *${q}*`),
    ...hits.map((h) => {
      const link = artifactLink(`${baseUrl}/artifacts/${h.short_id}`, h.title, h.short_id)
      return section(h.snippet ? `${link}\n${mrkdwnLabel(h.snippet, 160)}` : link)
    }),
    context("Only you can see this · results are limited to what you can access in Derive"),
  ]
}

/** Bare `/derive`: the invoker's most recent accessible artifacts. */
export const deriveRecentBlocks = (baseUrl: string, artifacts: ArtifactRecord[]): unknown[] => {
  if (artifacts.length === 0) return [section("No artifacts you can see in this workspace yet.")]
  return [
    section("*Your recent artifacts*"),
    ...artifacts.map((a) => section(artifactLink(artifactUrl(baseUrl, a), a.title, a.short_id))),
    context("Only you can see this · `/derive <query>` searches · `/derive help` lists the rest"),
  ]
}

/** `/derive settings`, run in a channel: what Derive posts here, if anything. */
export const subscriptionBlocks = (
  baseUrl: string,
  subs: {
    scope_kind: string
    scope_id: string
    /** The collection's TITLE. `scope_id` is an opaque `col_…`, which is what this card used to
     *  print — telling an admin their channel is scoped to `col_9f2ac1` and nothing more. Null
     *  for a workspace scope, and for a collection since deleted. */
    scope_title?: string | null
    events: string
    authors: string
    active: 0 | 1
  }[],
): unknown[] => {
  if (!subs.length)
    return [
      section("Derive doesn't post in this channel."),
      context("Run `/derive subscribe` here to change that."),
    ]
  return [
    section("*Derive posts here*"),
    ...subs.map((s) =>
      section(
        [
          s.scope_kind === "collection"
            ? `Collection *${mrkdwnLabel(s.scope_title ?? "(deleted)", 60)}*`
            : "The whole workspace",
          s.events === "*" ? "all events" : s.events.split(",").join(" · "),
          s.authors === "all" ? "people and agents" : `${s.authors}s only`,
          ...(s.active ? [] : ["*paused*"]),
        ].join(" — "),
      ),
    ),
    context(
      `Manage these at ${baseUrl}/settings/integrations · \`/derive unsubscribe\` stops them`,
    ),
  ]
}

/** `/derive help`. The subcommands exist only in the slash-command autocomplete otherwise, and
 *  that is one line of hint text — this is where someone who half-remembers `subscribe` can
 *  actually find out what it takes. Reached by `/derive help`, and pointed at from the footer of
 *  the search and recent cards, since those are what people land on by accident. */
export const helpBlocks = (baseUrl: string): unknown[] => [
  section("*What `/derive` can do*"),
  section(
    [
      "`/derive <query>` — search everything you can see",
      "`/derive` — your most recent artifacts",
      "`/derive subscribe [collection]` — post this channel's activity here; name a collection to narrow it",
      "`/derive unsubscribe` — stop posting here",
      "`/derive settings` — what this channel currently gets",
    ].join("\n"),
  ),
  section(
    "You can also pick *Save to Derive* from any message's shortcut menu to file it as a comment on a doc.",
  ),
  context(`Subscriptions are admin-only · manage them at ${baseUrl}/settings/integrations`),
]
