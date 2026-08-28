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
/** What a version row needs of a version — the artifact's own, or the workspace feed's
 *  (`ActivityVersion`, which adds `artifact_id`). */
export type VersionLike = Pick<Version, "n" | "author" | "created_at" | "message" | "name"> & {
  agent?: Version["agent"]
  handle?: string | null
  artifact_id?: string
}
/** The document a row belongs to — set in workspace mode, where the stream spans many. */
export type ActivityArtifact = { short_id: string; title: string }

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
  versions: VersionLike[]
  artifact?: ActivityArtifact
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
  artifact?: ActivityArtifact
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
  artifact?: ActivityArtifact
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
  artifact?: ActivityArtifact
}
/** A new thread, as a LINE — the workspace feed's shape for it (the artifact rail shows
 *  threads as cards, where they are answered in place). */
export type CommentedRow = {
  kind: "commented"
  id: string
  at: string
  by: string
  byId: string | null
  agent: boolean
  threadId: string
  body: string
  artifact?: ActivityArtifact
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
  artifact?: ActivityArtifact
}
export type ActivityRow =
  | VersionRow
  | ReviewRequestRow
  | ReviewSentBackRow
  | ReplyRow
  | CommentedRow
  | ResolvedRow

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
  artifact?: ActivityArtifact
}
export type StreamItem =
  | { type: "section"; id: string; label: SectionLabel }
  | { type: "unread"; id: "unread" }
  | ThreadItem
  | TurnItem

export interface StreamInput {
  versions: VersionLike[]
  comments: Comment[]
  rounds: ReviewRound[]
  /** WORKSPACE mode (the home): rows span many documents and carry theirs (looked up by
   *  `artifact_id` here); a new thread is a line, not a card; a pending ask is not a row
   *  (it is the home's "Needs you"); rows before `since` are left out. */
  workspace?: { artifacts: Record<string, ActivityArtifact>; since: string }
  /** Newest first (a page reads down from now) or oldest first (the rail reads up to its
   *  composer). Default oldest first. */
  order?: "asc" | "desc"
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
function versionRows(versions: VersionLike[], docOf: DocOf): VersionRow[] {
  return versions.map((v) => ({
    kind: "version",
    id: `v-${v.artifact_id ?? ""}-${v.n}`,
    at: v.created_at,
    by: v.agent?.name ?? v.author,
    byId: v.agent?.id ?? (v.handle ? `@${v.handle}` : null),
    agent: !!v.agent,
    from: v.n,
    to: v.n,
    count: 1,
    message: v.message ?? v.name ?? null,
    versions: [v],
    artifact: docOf(v.artifact_id),
  }))
}

/** The document a record belongs to, in workspace mode; nothing in the rail. */
type DocOf = (artifactId: string | undefined) => ActivityArtifact | undefined

// A round carries ONE note: the requester's while pending, then the answer once sent
// back (send-back overwrites it). So a settled round's request row has no note to show —
// the answer belongs to the sent-back row alone.
function reviewRows(rounds: ReviewRound[], docOf: DocOf) {
  const rows: ActivityRow[] = []
  for (const r of rounds) {
    const pending = r.state === "pending"
    const artifact = docOf(r.artifact_id)
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
      artifact,
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
        artifact,
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
  docOf: DocOf,
  workspace: boolean,
  meId?: string,
  me?: string,
): (ReplyRow | ResolvedRow | CommentedRow)[] {
  const isMe = (id: string | null | undefined, name: string | null) =>
    id ? id === meId : !!name && name === me
  const rows: (ReplyRow | ResolvedRow | CommentedRow)[] = []
  for (const t of threads) {
    const root = t[0]
    if (!root) continue
    const artifact = docOf(root.artifact_id)
    // In the workspace feed a thread is a line like any other action; in the rail it is a
    // card, and only what happened INSIDE it since the last visit gets a row.
    if (workspace && !root.deleted)
      rows.push({
        kind: "commented",
        id: `t-${root.id}`,
        at: root.created_at,
        by: root.author,
        byId: root.author_id ?? null,
        agent: root.author_kind === "agent",
        threadId: root.thread_id,
        body: root.body_md,
        artifact,
      })
    // Replies and resolves are news only after a visit; in the workspace feed, always.
    const floor = workspace ? Number.NEGATIVE_INFINITY : lastSeen
    if (floor == null) continue
    for (const c of t.slice(1)) {
      if (c.deleted || ms(c.created_at) <= floor || isMe(c.author_id, c.author)) continue
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
        artifact,
      })
    }
    const res = root.state === "resolved" ? root.resolution : null
    if (res && ms(res.at) > floor && !isMe(res.by_id, res.by))
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
        artifact,
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
    // Across documents (the workspace feed) a turn is one actor on ONE document.
    const sameDoc = (a: TurnItem, b: ActivityRow) => a.artifact?.short_id === b.artifact?.short_id
    const joins =
      cur !== null &&
      (row.by === null || sameActor(cur, row)) &&
      sameDoc(cur, row) &&
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
        artifact: row.artifact,
      }
      turns.push(cur)
    }
  }
  return turns
}

const THREAD_KINDS = new Set<ActivityRow["kind"]>(["reply", "resolved", "commented"])

export function buildStream(input: StreamInput): StreamItem[] {
  const threads = groupThreads(input.comments)
  const ws = input.workspace
  const docOf: DocOf = (id) => (ws && id ? ws.artifacts[id] : undefined)
  const since = ws ? ms(ws.since) : Number.NEGATIVE_INFINITY
  const rows: ActivityRow[] = [
    ...versionRows(input.versions, docOf),
    ...reviewRows(input.rounds, docOf),
    ...threadRows(threads, input.lastSeen, docOf, !!ws, input.meId, input.me),
  ].filter(
    (r) =>
      // Workspace mode: a pending ask is the home's "Needs you", not a line; rows before the
      // window (open threads served for Needs you) stay out of the stream.
      !ws || (!(r.kind === "review_request" && r.pending) && ms(r.at) >= since),
  )
  const lensRows = input.lens === "comments" ? rows.filter((r) => THREAD_KINDS.has(r.kind)) : rows
  // Cards only in the rail: the workspace feed made its threads lines above.
  const threadItems: ThreadItem[] = ws
    ? []
    : threads.flatMap((t) => {
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
  // Newest first reads down from now: the same items, reversed, and the marker sits
  // after the last new item instead of before the first.
  if (input.order === "desc") items.reverse()
  const isNew = (it: { at: string }) => ms(it.at) > (input.lastSeen ?? 0)

  // Sections + the unread marker (before the first item newer than the last visit —
  // or, newest first, before the first item that is not). A stream that all happened
  // today needs no eyebrow — labels earn their place only when there are two days to
  // tell apart.
  const labelled = new Set(items.map((it) => sectionOf(it.at, input.now))).size > 1
  const out: StreamItem[] = []
  let section: SectionLabel | null = null
  let marked = input.lastSeen == null
  for (const it of items) {
    const boundary =
      input.order === "desc" ? !isNew(it) && out.some((o) => o.type !== "section") : isNew(it)
    if (!marked && boundary) {
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
  "commented",
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
  // In the workspace feed the sentence names the document; in the rail the document is
  // the page.
  const doc = row.artifact?.title
  switch (row.kind) {
    case "version": {
      const span = row.count > 1 ? `v${row.from}–v${row.to}` : `v${row.to}`
      return doc ? `published ${span} of ${doc}` : `published ${span}`
    }
    case "review_request":
      return doc
        ? `asked for review of v${row.version} · ${doc}`
        : `asked for review of v${row.version}`
    case "review_sent_back":
      return doc ? `sent v${row.version} of ${doc} back` : `sent v${row.version} back`
    case "commented":
      return doc ? `commented on ${doc}` : "commented"
    case "reply":
      return doc
        ? `replied in ${row.threadAuthor}'s thread on ${doc}`
        : `replied in ${row.threadAuthor}'s thread`
    case "resolved":
      return doc
        ? `resolved ${row.threadAuthor}'s thread on ${doc}`
        : `resolved ${row.threadAuthor}'s thread`
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
