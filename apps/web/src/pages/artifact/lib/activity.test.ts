import { describe, expect, it } from "vitest"
import type { Artifact, Comment, ReviewRound } from "@/api"
import { buildStream, countUnread, hasDetail, leadRow, phrase, sectionOf, stamp } from "./activity"

// A fixed clock: Aug 27, 2026, 15:00 local.
const NOW = new Date(2026, 7, 27, 15, 0).getTime()
const at = (daysAgo: number, hour = 12, minute = 0) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

type Version = Artifact["versions"][number]
type Session = NonNullable<Artifact["sessions"]>[number]
// The byline is always the person; an agent that did the work is recorded beside it.
const CLAUDE = { id: "agent-1", name: "Claude Code" }
const version = (
  n: number,
  author: string,
  created_at: string,
  message: string | null,
  agent: Version["agent"] = null,
): Version => ({
  n,
  author,
  message,
  name: null,
  created_at,
  agent,
})
const session = (
  p: Partial<Session> & { n: number; from_n: number; created_at: string },
): Session => ({
  count: p.n - p.from_n + 1,
  author: "Mert",
  agent_name: null,
  name: null,
  ...p,
})
const comment = (
  p: Partial<Comment> & { id: string; author: string; created_at: string },
): Comment => ({
  thread_id: p.id,
  base_version: 1,
  path: null,
  anchor: null,
  body_md: "…",
  state: "open",
  author_kind: "user",
  ...p,
})
const round = (p: Partial<ReviewRound> & { id: string; created_at: string }): ReviewRound => ({
  artifact_id: "a",
  version: 1,
  requested_by: "agent-1",
  requested_by_name: "Claude Code",
  requested_by_kind: "agent",
  requested_for: "u1",
  state: "pending",
  note: null,
  resolved_by_name: null,
  resolved_at: null,
  ...p,
})

const base = { rounds: [], lastSeen: null, lens: "all" as const, now: NOW }

describe("buildStream", () => {
  it("makes one version row per server session, credited to the agent that did the work", () => {
    const versions = [
      version(1, "Mert", at(3, 10), "Create"),
      version(2, "Mert", at(3, 10, 15), "Draft", CLAUDE),
      version(3, "Mert", at(3, 10, 18), "Chart", CLAUDE),
      version(4, "Mert", at(3, 10, 24), "Tighten", CLAUDE),
    ]
    const sessions = [
      session({ n: 4, from_n: 2, agent_name: "Claude Code", created_at: at(3, 10, 24) }),
      session({ n: 1, from_n: 1, created_at: at(3, 10) }),
    ]
    const items = buildStream({ ...base, versions, sessions, comments: [] })
    const turns = items.filter((it) => it.type === "turn")
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      by: "Mert",
      agent: false,
      rows: [{ kind: "version", from: 1, to: 1 }],
    })
    // The byline stays the person's; the turn is the agent's, by the recorded identity.
    expect(turns[1]).toMatchObject({
      by: "Claude Code",
      agent: true,
      rows: [{ kind: "version", from: 2, to: 4, count: 3, message: "Tighten" }],
    })
    // The expanded list runs newest-first.
    const row = (turns[1] as { rows: { versions: Version[] }[] }).rows[0]
    expect(row?.versions.map((v) => v.n)).toEqual([4, 3, 2])
  })

  it("breaks a turn at a comment card, so before and after read as separate stories", () => {
    const versions = [version(1, "Mert", at(2, 9), "One"), version(2, "Mert", at(2, 11), "Two")]
    const comments = [comment({ id: "t1", author: "Ada", created_at: at(2, 10) })]
    const items = buildStream({ ...base, versions, comments })
    // One day: no eyebrow to tell days apart.
    expect(items.map((it) => it.type)).toEqual(["turn", "thread", "turn"])
  })

  it("splits an actor's turns across days and labels sections Today / Yesterday / Earlier", () => {
    const versions = [
      version(1, "Mert", at(5, 9), "Old"),
      version(2, "Mert", at(1, 9), "Yesterday's"),
      version(3, "Mert", at(0, 9), "Today's"),
    ]
    const items = buildStream({ ...base, versions, comments: [] })
    expect(items.map((it) => (it.type === "section" ? it.label : it.type))).toEqual([
      "Earlier",
      "turn",
      "Yesterday",
      "turn",
      "Today",
      "turn",
    ])
  })

  it("turns review rounds into request and sent-back rows, naming the requester when it can", () => {
    const rounds = [
      round({
        id: "rr1",
        version: 3,
        created_at: at(1, 10),
        state: "sent_back",
        note: "Looks right.",
        resolved_by_name: "Mert",
        resolved_at: at(1, 11),
      }),
      round({ id: "rr2", version: 4, created_at: at(0, 13), note: "Check §3." }),
    ]
    const items = buildStream({ ...base, versions: [], comments: [], rounds })
    const rows = items.filter((it) => it.type === "turn").flatMap((t) => t.rows)
    expect(rows.map((r) => r.kind)).toEqual([
      "review_request",
      "review_sent_back",
      "review_request",
    ])
    // A settled round's one note is the answer — it rides the sent-back row, not the ask.
    expect(rows[0]).toMatchObject({
      by: "Claude Code",
      agent: true,
      version: 3,
      pending: false,
      note: null,
    })
    expect(rows[1]).toMatchObject({ by: "Mert", agent: false, note: "Looks right." })
    expect(rows[2]).toMatchObject({
      by: "Claude Code",
      agent: true,
      version: 4,
      pending: true,
      note: "Check §3.",
    })
  })

  it("marks an agent's reply by its recorded kind, never by its name", () => {
    const seen = new Date(at(0, 12)).getTime()
    const comments = [
      comment({ id: "t1", author: "Ada", created_at: at(3, 9) }),
      // A person who happens to share the agent's name is still a person.
      comment({ id: "c2", thread_id: "t1", author: "Claude Code", created_at: at(0, 13) }),
      comment({
        id: "c3",
        thread_id: "t1",
        author: "Claude Code",
        author_id: CLAUDE.id,
        author_kind: "agent",
        created_at: at(0, 14),
      }),
    ]
    const rows = buildStream({ ...base, versions: [], comments, lastSeen: seen })
      .filter((it) => it.type === "turn")
      .map((t) => ({ by: t.by, agent: t.agent }))
    expect(rows).toEqual([
      { by: "Claude Code", agent: false },
      { by: "Claude Code", agent: true },
    ])
  })

  it("surfaces replies since the last visit as rows, skipping the viewer's own", () => {
    const seen = new Date(at(0, 12)).getTime()
    const comments = [
      comment({ id: "t1", author: "Ada", created_at: at(3, 9) }),
      comment({ id: "c2", thread_id: "t1", author: "Mert", created_at: at(3, 10), body_md: "old" }),
      comment({ id: "c3", thread_id: "t1", author: "Noor", created_at: at(0, 14), body_md: "new" }),
      comment({
        id: "c4",
        thread_id: "t1",
        author: "Mert",
        created_at: at(0, 14, 30),
        body_md: "mine",
      }),
    ]
    const items = buildStream({ ...base, versions: [], comments, lastSeen: seen, me: "Mert" })
    const replies = items.filter((it) => it.type === "turn").flatMap((t) => t.rows)
    expect(replies).toEqual([
      expect.objectContaining({
        kind: "reply",
        by: "Noor",
        threadId: "t1",
        threadAuthor: "Ada",
        body: "new",
      }),
    ])
    // The marker sits before the first new item, and only new items count.
    const types = items.map((it) => it.type)
    expect(types.indexOf("unread")).toBeGreaterThan(types.indexOf("thread"))
    expect(countUnread(items)).toBe(1)
  })

  it("surfaces a thread settled since the last visit as the resolver's row", () => {
    const seen = new Date(at(0, 12)).getTime()
    const comments = [
      comment({
        id: "t1",
        author: "Ada",
        created_at: at(3, 9),
        state: "resolved",
        resolution: {
          at: at(0, 14),
          by: "Claude Code",
          by_id: CLAUDE.id,
          by_kind: "agent",
          version: 6,
        },
      }),
      // Settled by the viewer, before the visit: not news.
      comment({
        id: "t2",
        author: "Noor",
        created_at: at(3, 10),
        state: "resolved",
        resolution: { at: at(1, 9), by: "Mert", by_id: "u1", by_kind: "user", version: null },
      }),
    ]
    const items = buildStream({ ...base, versions: [], comments, lastSeen: seen, me: "Mert" })
    const turns = items.filter((it) => it.type === "turn")
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      by: "Claude Code",
      agent: true,
      rows: [{ kind: "resolved", threadId: "t1", threadAuthor: "Ada", version: 6 }],
    })
    expect(countUnread(items)).toBe(1)
    // Rows about threads survive the Comments lens.
    const only = buildStream({
      ...base,
      versions: [],
      comments,
      lastSeen: seen,
      me: "Mert",
      lens: "comments",
    })
    expect(only.filter((it) => it.type === "turn")).toHaveLength(1)
  })

  it("has no marker and nothing new on a first visit", () => {
    const items = buildStream({
      ...base,
      versions: [version(1, "Mert", at(0, 9), null)],
      comments: [],
    })
    expect(items.some((it) => it.type === "unread")).toBe(false)
    expect(countUnread(items)).toBe(0)
  })

  it("the Comments lens keeps the threads (and replies) and drops the changes", () => {
    const versions = [version(1, "Mert", at(0, 9), "One")]
    const comments = [comment({ id: "t1", author: "Ada", created_at: at(0, 10) })]
    const all = buildStream({ ...base, versions, comments })
    const only = buildStream({ ...base, versions, comments, lens: "comments" })
    expect(all.map((it) => it.type)).toEqual(["turn", "thread"])
    expect(only.map((it) => it.type)).toEqual(["thread"])
  })
})

describe("leadRow / phrase / hasDetail", () => {
  it("leads with the pending ask over the publish, and counts the rest", () => {
    const turn = buildStream({
      ...base,
      versions: [version(2, "Mert", at(0, 9), "Recompute", CLAUDE)],
      comments: [],
      rounds: [round({ id: "rr", version: 2, created_at: at(0, 9, 5), note: "Please check." })],
    }).find((it) => it.type === "turn")
    if (!turn) throw new Error("no turn")
    expect(turn.rows).toHaveLength(2)
    expect(phrase(leadRow(turn))).toBe("asked for review of v2")
    // The ask shows in full under the line; the publish (with a message) is what opens.
    expect(hasDetail(turn)).toBe(true)
  })

  it("once the round is settled, the publish leads and the ask is a detail", () => {
    const turn = buildStream({
      ...base,
      versions: [version(2, "Mert", at(0, 9), "Recompute", CLAUDE)],
      comments: [],
      rounds: [
        round({
          id: "rr",
          version: 2,
          created_at: at(0, 9, 5),
          state: "sent_back",
          note: "Good to go.",
          resolved_by_name: "Claude Code",
          resolved_at: at(0, 9, 30),
        }),
      ],
    }).find((it) => it.type === "turn")
    if (!turn) throw new Error("no turn")
    expect(phrase(leadRow(turn))).toBe("published v2")
  })

  it("phrases every row kind", () => {
    expect(
      phrase({
        kind: "version",
        id: "",
        at: "",
        by: "",
        agent: false,
        from: 9,
        to: 11,
        count: 3,
        message: null,
        versions: [],
      }),
    ).toBe("published v9–v11")
    expect(
      phrase({
        kind: "version",
        id: "",
        at: "",
        by: "",
        agent: false,
        from: 4,
        to: 4,
        count: 1,
        message: null,
        versions: [],
      }),
    ).toBe("published v4")
    expect(
      phrase({
        kind: "review_sent_back",
        id: "",
        at: "",
        by: null,
        agent: false,
        version: 3,
        note: null,
      }),
    ).toBe("sent v3 back")
    expect(
      phrase({
        kind: "reply",
        id: "",
        at: "",
        by: "Noor",
        agent: false,
        threadId: "t",
        threadAuthor: "Ada",
        body: "",
      }),
    ).toBe("replied in Ada's thread")
    expect(
      phrase({
        kind: "resolved",
        id: "",
        at: "",
        by: "Claude Code",
        agent: true,
        threadId: "t",
        threadAuthor: "Ada",
        version: 6,
      }),
    ).toBe("resolved Ada's thread")
  })

  it("a lone message-less publish has nothing to open", () => {
    const [turn] = buildStream({
      ...base,
      versions: [version(1, "Mert", at(0, 9), null)],
      comments: [],
    }).filter((it) => it.type === "turn")
    if (!turn) throw new Error("no turn")
    expect(hasDetail(turn)).toBe(false)
  })
})

describe("stamp / sectionOf", () => {
  it("is relative today and yesterday, absolute before that", () => {
    expect(stamp(at(0, 14, 59), NOW)).toBe("1m")
    expect(stamp(at(0, 13), NOW)).toBe("2h")
    expect(stamp(at(1, 9), NOW)).toBe("1d")
    expect(stamp(at(7, 9), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
    expect(sectionOf(at(0, 1), NOW)).toBe("Today")
    expect(sectionOf(at(1, 23), NOW)).toBe("Yesterday")
    expect(sectionOf(at(2, 23), NOW)).toBe("Earlier")
  })
})
