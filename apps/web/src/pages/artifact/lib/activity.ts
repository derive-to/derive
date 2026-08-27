import type { Artifact, Comment, ReviewRound } from "@/api"
import { groupThreads } from "./layout"

/**
 * The activity stream — the artifact rail's one chronological feed, built from the
 * records the page already holds: versions, comment threads, and review rounds. Pure, so
 * the grouping is unit-tested like `bucketThreads` and the component only renders.
 *
 * Who did what comes from the records, never from a name: a version carries its `agent`,
 * a round its requester's name and kind, a comment its author's kind, a resolved thread
 * its resolution. The stream reads them; it never guesses.
 *
 * The grammar (see docs/design-system.md → "Activity rail"):
 *  - a comment thread is a CARD, shown in full;
 *  - everything else is ONE LINE: consecutive actions by one actor on one day fold into a
 *    "turn" ("Ada published v9–v11 · +2"), which opens to its rows and their detail;
 *  - replies and resolutions that landed after the viewer's last visit get a row of their
 *    own, so recency is never buried inside a card the reader saw days ago;
 *  - the unread marker is derived from the viewer's last visit (per browser);
 *  - the Comments lens subsets the same stream to the threads (the old panel).
 */

export type Lens = "all" | "comments"
export type SectionLabel = "Today" | "Yesterday" | "Earlier"

type Version = Artifact["versions"][number]

export type VersionRow = {
  kind: "version"
  id: string
  /** The first version's time — where the run of publishes began, which is where it
   *  sits in the stream; the turn's `until` carries the last one, for its stamp. */
  at: string
  /** The actor — the agent's name when one produced the versions on the author's behalf. */
  by: string
  /** The actor's stable identity when the record has one (an agent id, a person's handle):
   *  turns fold by it, so a rename never splits one person and a shared name never joins two. */
  byId: string | null
  agent: boolean
  /** The version range this row covers (a session folds several). */
  from: number
  to: number
  count: number
  /** The newest version's message, else the session's checkpoint name. */
  message: string | null
  /** The versions in the range, oldest first — the expanded list reads down the way the
   *  stream does, so the current version is its last line. */
  versions: Version[]
}
export type ReviewRequestRow = {
  kind: "review_request"
  id: string
  at: string
  /** The requester's recorded name; null on a row the server could not name. */
  by: string | null
  byId: string | null
  agent: boolean
  version: number
  note: string | null
  pending: boolean
}
export type ReviewSentBackRow = {
  kind: "review_sent_back"
  id: string
  at: string
  by: string | null
  byId: string | null
  agent: boolean
  version: number
  note: string | null
}
export type ReplyRow = {
  kind: "reply"
  id: string
  at: string
  by: string
  byId: string | null
  agent: boolean
  threadId: string
  threadAuthor: string
  body: string
}
export type ResolvedRow = {
  kind: "resolved"
  id: string
  at: string
  /** The resolver's recorded name; null when the record has none (a Slack click). */
  by: string | null
  byId: string | null
  agent: boolean
  threadId: string
  threadAuthor: string
  /** The version whose publish settled the thread; null for a hand resolve. */
  version: number | null
}
export type ActivityRow = VersionRow | ReviewRequestRow | ReviewSentBackRow | ReplyRow | ResolvedRow

export type ThreadItem = { type: "thread"; id: string; at: string; thread: Comment[] }
export type TurnItem = {
  type: "turn"
  id: string
  at: string
  /** The newest row's time — the stamp the line carries. */
  until: string
  by: string | null
  byId: string | null
  /** The actor is an agent (acting on someone's behalf). */
  agent: boolean
  /** Never empty — a turn is made from its first row. */
  rows: [ActivityRow, ...ActivityRow[]]
}
export type StreamItem =
  | { type: "section"; id: string; label: SectionLabel }
  | { type: "unread"; id: "unread" }
  | ThreadItem
  | TurnItem

export interface StreamInput {
  versions: Version[]
  comments: Comment[]
  rounds: ReviewRound[]
  /** The viewer — their own replies and resolves are not news to them. Matched by id when
   *  the record has one, by name for rows written before ids were kept. */
  meId?: string
  me?: string
  /** The viewer's last visit (ms since epoch); null = no marker, nothing is "new". */
  lastSeen: number | null
  lens: Lens
  now: number
}

const ms = (iso: string) => new Date(iso).getTime()

/** Calendar day key in local time, so "same day" means what the reader means. */
const dayKey = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function sectionOf(iso: string, now: number): SectionLabel {
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(today.getDate() - 1)
  const key = dayKey(iso)
  if (key === dayKey(today.toISOString())) return "Today"
  if (key === dayKey(yesterday.toISOString())) return "Yesterday"
  return "Earlier"
}

/** The stamp a stream line carries: terse relative time today, an absolute date before
 *  that (a row from last week says "Aug 20", not "7d", so old days need no eyebrow). */
export function stamp(iso: string, now: number): string {
  const s = Math.max(0, (now - ms(iso)) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (sectionOf(iso, now) === "Yesterday") return "1d"
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })
}

/** One row per version. The stream does its own folding (`foldTurns`): a run of one
 *  actor's publishes becomes one row, and ANY event between two of them — an ask, an
 *  answer, a card — keeps them apart. The server's time-clustered `sessions` are not
 *  used here on purpose: a session is blind to what happened between its versions, so
 *  "asked for review of v6" would sit before a v6–v7 row that includes v6. */
function versionRows(versions: Version[]): VersionRow[] {
  return versions.map((v) => ({
    kind: "version",
    id: `v-${v.n}`,
    at: v.created_at,
    by: v.agent?.name ?? v.author,
    byId: v.agent?.id ?? (v.handle ? `@${v.handle}` : null),
    agent: !!v.agent,
    from: v.n,
    to: v.n,
    count: 1,
    message: v.message ?? v.name ?? null,
    versions: [v],
  }))
}

// A round carries ONE note: the requester's while pending, then the answer once sent
// back (send-back overwrites it). So a settled round's request row has no note to show —
// the answer belongs to the sent-back row alone.
function reviewRows(rounds: ReviewRound[]) {
  const rows: ActivityRow[] = []
  for (const r of rounds) {
    const pending = r.state === "pending"
    rows.push({
      kind: "review_request",
      id: `rr-${r.id}`,
      at: r.created_at,
      by: r.requested_by_name,
      byId: r.requested_by,
      agent: r.requested_by_kind === "agent",
      version: r.version,
      note: pending ? r.note : null,
      pending,
    })
    if (r.state === "sent_back" && r.resolved_at)
      rows.push({
        kind: "review_sent_back",
        id: `rs-${r.id}`,
        at: r.resolved_at,
        by: r.resolved_by_name,
        // The round keeps the answerer's name, not their id.
        byId: null,
        // Only a person answers a round (the route insists on one).
        agent: false,
        version: r.version,
        note: r.note,
      })
  }
  return rows
}

/** What happened inside threads since the last visit, by someone else: a reply, or the
 *  thread being settled — the activity that would otherwise be buried inside a card the
 *  reader saw days ago. */
function threadRows(
  threads: Comment[][],
  lastSeen: number | null,
  meId?: string,
  me?: string,
): (ReplyRow | ResolvedRow)[] {
  if (lastSeen == null) return []
  const isMe = (id: string | null | undefined, name: string | null) =>
    id ? id === meId : !!name && name === me
  const rows: (ReplyRow | ResolvedRow)[] = []
  for (const t of threads) {
    const root = t[0]
    if (!root) continue
    for (const c of t.slice(1)) {
      if (c.deleted || ms(c.created_at) <= lastSeen || isMe(c.author_id, c.author)) continue
      rows.push({
        kind: "reply",
        id: `r-${c.id}`,
        at: c.created_at,
        by: c.author,
        byId: c.author_id ?? null,
        agent: c.author_kind === "agent",
        threadId: root.thread_id,
        threadAuthor: root.author,
        body: c.body_md,
      })
    }
    const res = root.state === "resolved" ? root.resolution : null
    if (res && ms(res.at) > lastSeen && !isMe(res.by_id, res.by))
      rows.push({
        kind: "resolved",
        id: `x-${root.thread_id}`,
        at: res.at,
        by: res.by,
        byId: res.by_id,
        agent: res.by_kind === "agent",
        threadId: root.thread_id,
        threadAuthor: root.author,
        version: res.version,
      })
  }
  return rows
}

/** Two publish rows by the turn's actor become one: the span widens, the versions run
 *  on in order, the newest message speaks for the range. So a run of publishes reads as
 *  "published v1–v5", never "published v1 · +4" with the rest hidden in the count. */
function mergeVersions(into: VersionRow, row: VersionRow): void {
  into.from = Math.min(into.from, row.from)
  into.to = Math.max(into.to, row.to)
  into.count += row.count
  into.versions = [...into.versions, ...row.versions].sort((a, b) => a.n - b.n)
  const spoken = [...into.versions].reverse().find((v) => v.message)
  into.message = spoken?.message ?? row.message ?? into.message
}

/** Fold consecutive rows by one actor on one day into a turn. A row with no actor (a
 *  round or a resolve the record could not name) rides with the turn before it. Actors
 *  match by identity when both rows carry one, else by name AND kind (a person who shares
 *  an agent's name is not that agent). The viewer's last visit is a boundary too: what
 *  happened since must start its own turn, or it folds into one that sits before the
 *  "New" marker and is never new. */
function foldTurns(rows: ActivityRow[], lastSeen: number | null): TurnItem[] {
  const turns: TurnItem[] = []
  let cur: TurnItem | null = null
  const seen = (iso: string) => lastSeen != null && ms(iso) <= lastSeen
  for (const row of rows) {
    const sameActor = (a: TurnItem, b: ActivityRow) =>
      a.byId && b.byId ? a.byId === b.byId : a.by === b.by && a.agent === b.agent
    const joins =
      cur !== null &&
      (row.by === null || sameActor(cur, row)) &&
      dayKey(cur.at) === dayKey(row.at) &&
      seen(cur.at) === seen(row.at)
    if (joins && cur) {
      const publish = row.kind === "version" ? cur.rows.find((r) => r.kind === "version") : null
      if (publish && row.kind === "version") mergeVersions(publish, row)
      else cur.rows.push(row)
      cur.until = row.at
    } else {
      cur = {
        type: "turn",
        id: `turn-${row.id}`,
        at: row.at,
        until: row.at,
        by: row.by,
        byId: row.byId,
        agent: row.agent,
        rows: [row],
      }
      turns.push(cur)
    }
  }
  return turns
}

const THREAD_KINDS = new Set<ActivityRow["kind"]>(["reply", "resolved"])

export function buildStream(input: StreamInput): StreamItem[] {
  const threads = groupThreads(input.comments)
  const rows: ActivityRow[] = [
    ...versionRows(input.versions),
    ...reviewRows(input.rounds),
    ...threadRows(threads, input.lastSeen, input.meId, input.me),
  ]
  const lensRows = input.lens === "comments" ? rows.filter((r) => THREAD_KINDS.has(r.kind)) : rows
  const threadItems: ThreadItem[] = threads.flatMap((t) => {
    const root = t[0]
    return root
      ? [{ type: "thread" as const, id: root.thread_id, at: root.created_at, thread: t }]
      : []
  })

  // Merge in time, then fold the runs of rows between cards into turns. Cards break a
  // turn: what happened after a comment is a different story from what happened before.
  const merged: (ThreadItem | ActivityRow)[] = [...threadItems, ...lensRows].sort(
    (a, b) => ms(a.at) - ms(b.at),
  )
  const items: (ThreadItem | TurnItem)[] = []
  let run: ActivityRow[] = []
  const flush = () => {
    if (run.length) items.push(...foldTurns(run, input.lastSeen))
    run = []
  }
  for (const m of merged) {
    if ("type" in m) {
      flush()
      items.push(m)
    } else run.push(m)
  }
  flush()

  // Sections + the unread marker (before the first item newer than the last visit).
  // A stream that all happened today needs no eyebrow — labels earn their place only
  // when there are two days to tell apart.
  const labelled = new Set(items.map((it) => sectionOf(it.at, input.now))).size > 1
  const out: StreamItem[] = []
  let section: SectionLabel | null = null
  let marked = input.lastSeen == null
  for (const it of items) {
    if (!marked && ms(it.at) > (input.lastSeen ?? 0)) {
      out.push({ type: "unread", id: "unread" })
      marked = true
    }
    const label = sectionOf(it.at, input.now)
    if (labelled && label !== section) {
      section = label
      out.push({ type: "section", id: `section-${label}`, label })
    }
    out.push(it)
  }
  return out
}

/** How many cards and turns sit after the unread marker. */
export function countUnread(items: StreamItem[]): number {
  const i = items.findIndex((it) => it.type === "unread")
  if (i < 0) return 0
  return items.slice(i + 1).filter((it) => it.type === "thread" || it.type === "turn").length
}

/** The one phrase a turn line leads with: a pending ask, else the publish, else the
 *  answer, else a settled ask, else the reply, else the resolve — what a reader most needs
 *  to know before opening it. */
const PRIORITY: ActivityRow["kind"][] = [
  "version",
  "review_sent_back",
  "review_request",
  "reply",
  "resolved",
]
export function leadRow(turn: TurnItem): ActivityRow {
  const rank = (r: ActivityRow) =>
    r.kind === "review_request" && r.pending ? -1 : PRIORITY.indexOf(r.kind)
  return turn.rows.reduce((best, r) => (rank(r) < rank(best) ? r : best), turn.rows[0])
}

/** A row's plain-text phrase, actor excluded ("published v9–v11"). Shared by the turn
 *  line and its opened detail rows so the two can never disagree. */
export function phrase(row: ActivityRow): string {
  switch (row.kind) {
    case "version":
      return row.count > 1 ? `published v${row.from}–v${row.to}` : `published v${row.to}`
    case "review_request":
      return `asked for review of v${row.version}`
    case "review_sent_back":
      return `sent v${row.version} back`
    case "reply":
      return `replied in ${row.threadAuthor}'s thread`
    case "resolved":
      return `resolved ${row.threadAuthor}'s thread`
  }
}

/** The turn's detail is worth opening when a row carries more than its phrase. */
// A pending ask is shown in full beneath the line already, so it never counts here.
export const hasDetail = (turn: TurnItem): boolean =>
  turn.rows.filter((r) => !(r.kind === "review_request" && r.pending)).length > 1 ||
  turn.rows.some(
    (r) =>
      (r.kind === "version" && (r.count > 1 || !!r.message)) ||
      (r.kind === "review_request" && !r.pending && !!r.note) ||
      (r.kind === "review_sent_back" && !!r.note) ||
      THREAD_KINDS.has(r.kind),
  )
