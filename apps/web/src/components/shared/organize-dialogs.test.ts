import { describe, expect, it } from "vitest"
import type { Collection } from "@/api"
import { canAddTo, organizeList, pickableCollections, titleAffinity } from "./organize-dialogs"

// The picker's ordering is the redesign: the old dialog served the list in raw API
// order (heap order on Postgres — genuinely arbitrary), and "suggested then A–Z" is a
// promise the UI can't keep unless it's pinned here as data, not eyeballed as JSX.

let seq = 0
const col = (over: Partial<Collection>): Collection =>
  ({
    id: `col_${seq++}`,
    title: "Shelf",
    count: 1,
    my_role: "owner",
    ...over,
  }) as Collection

const titles = (cols: Collection[]) => cols.map((c) => c.title)

describe("pickableCollections", () => {
  it("offers hand-made collections only — mirrors and Brandprint stay out", () => {
    const manual = col({ title: "Launch assets" })
    const untagged = col({ title: "Old row", kind: undefined }) // pre-kind payloads are manual
    const repo = col({ title: "derive/derive", kind: "repo" })
    const pr = col({ title: "PR 618 — library rail", kind: "pr" })
    const brand = col({ title: "Brandprint docs" })
    const out = pickableCollections([manual, untagged, repo, pr, brand], new Set([brand.id]))
    expect(titles(out)).toEqual(["Launch assets", "Old row"])
  })
})

describe("canAddTo", () => {
  it("mirrors the add route's demand: publish on the collection (editor or better)", () => {
    expect(canAddTo(col({ my_role: "owner" }))).toBe(true)
    expect(canAddTo(col({ my_role: "editor" }))).toBe(true)
    expect(canAddTo(col({ my_role: "commenter" }))).toBe(false)
    expect(canAddTo(col({ my_role: "viewer" }))).toBe(false)
    expect(canAddTo(col({ my_role: null }))).toBe(false)
  })
})

describe("organizeList — browse (no query)", () => {
  it("a short list is just A–Z, case-insensitive — no section chrome", () => {
    const cols = [
      col({ title: "screenshots", my_last_activity: "2026-08-01T00:00:00Z" }),
      col({ title: "Brand" }),
      col({ title: "Pricing" }),
    ]
    const out = organizeList(cols, "")
    expect(out.mode).toBe("browse")
    if (out.mode !== "browse") return
    expect(out.suggested).toEqual([])
    expect(titles(out.rest)).toEqual(["Brand", "Pricing", "screenshots"])
  })

  it("your latest desks lead the suggestions, newest touch first", () => {
    const cols = [
      col({ title: "Alpha" }),
      col({ title: "Beta", my_last_activity: "2026-08-01T00:00:00Z" }),
      col({ title: "Gamma", my_last_activity: "2026-08-02T00:00:00Z" }),
      col({ title: "Delta" }),
      col({ title: "Epsilon" }),
      col({ title: "Zeta" }),
    ]
    const out = organizeList(cols, "")
    if (out.mode !== "browse") throw new Error("expected browse")
    expect(out.suggested.map((s) => s.col.title)).toEqual(["Gamma", "Beta"])
    expect(out.suggested.map((s) => s.reason)).toEqual(["recent", "recent"])
    // Suggested rows don't repeat in the index below.
    expect(titles(out.rest)).toEqual(["Alpha", "Delta", "Epsilon", "Zeta"])
  })

  it("title kinship fills the remaining slots, and never duplicates a recent pick", () => {
    const cols = [
      col({ title: "Pricing work", my_last_activity: "2026-08-02T00:00:00Z" }),
      col({ title: "Pricing archive" }),
      col({ title: "Brand" }),
      col({ title: "Research" }),
      col({ title: "Inbox" }),
      col({ title: "Misc" }),
    ]
    const out = organizeList(cols, "", "Q3 pricing page")
    if (out.mode !== "browse") throw new Error("expected browse")
    expect(out.suggested.map((s) => [s.col.title, s.reason])).toEqual([
      ["Pricing work", "recent"],
      ["Pricing archive", "similar"],
    ])
  })

  it("semantic neighbors slot between your recent desks and title kinship", () => {
    const hood = col({ title: "Neighborhood" })
    const cols = [
      col({ title: "Mine", my_last_activity: "2026-08-01T00:00:00Z" }),
      hood,
      col({ title: "Pricing archive" }),
      col({ title: "Inbox" }),
      col({ title: "Misc" }),
      col({ title: "Research" }),
    ]
    const out = organizeList(cols, "", "Q3 pricing page", [hood.id])
    if (out.mode !== "browse") throw new Error("expected browse")
    expect(out.suggested.map((s) => [s.col.title, s.reason])).toEqual([
      ["Mine", "recent"],
      ["Neighborhood", "neighbors"],
      ["Pricing archive", "similar"],
    ])
  })

  it("semantic ids the list doesn't offer (mirrors, brandprint, unknown) are ignored", () => {
    const wiki = col({ title: "Wiki", my_role: "viewer" })
    const cols = [
      col({ title: "A" }),
      col({ title: "B" }),
      col({ title: "C" }),
      col({ title: "D" }),
      col({ title: "E" }),
      wiki,
    ]
    // A stale/foreign id and a view-only collection: neither may surface as suggested.
    const out = organizeList(cols, "", undefined, ["col_gone", wiki.id])
    if (out.mode !== "browse") throw new Error("expected browse")
    expect(out.suggested).toEqual([])
  })

  it("never suggests a collection the caller can't add to", () => {
    const cols = [
      col({ title: "Team wiki", my_role: "viewer", my_last_activity: "2026-08-02T00:00:00Z" }),
      col({ title: "Mine", my_last_activity: "2026-08-01T00:00:00Z" }),
      col({ title: "A" }),
      col({ title: "B" }),
      col({ title: "C" }),
      col({ title: "D" }),
    ]
    const out = organizeList(cols, "")
    if (out.mode !== "browse") throw new Error("expected browse")
    expect(out.suggested.map((s) => s.col.title)).toEqual(["Mine"])
    // Still reachable — just not promoted.
    expect(titles(out.rest)).toContain("Team wiki")
  })
})

describe("organizeList — filter (typed query)", () => {
  const cols = [
    col({ title: "Brand kit" }),
    col({ title: "Rebrand 2026" }),
    col({ title: "Launch brand assets" }),
    col({ title: "Pricing" }),
  ]

  it("ranks title-prefix over word-prefix over substring, then A–Z", () => {
    const out = organizeList(cols, "bran")
    if (out.mode !== "filter") throw new Error("expected filter")
    expect(titles(out.matches)).toEqual(["Brand kit", "Launch brand assets", "Rebrand 2026"])
  })

  it("offers to create the draft unless a collection already has exactly that name", () => {
    const fresh = organizeList(cols, "  brand book ")
    if (fresh.mode !== "filter") throw new Error("expected filter")
    expect(fresh.create).toBe("brand book")

    const taken = organizeList(cols, "brand KIT")
    if (taken.mode !== "filter") throw new Error("expected filter")
    expect(taken.create).toBeNull()
  })

  it("no match still offers create — the empty state is an invitation, not a wall", () => {
    const out = organizeList(cols, "zzz")
    if (out.mode !== "filter") throw new Error("expected filter")
    expect(out.matches).toEqual([])
    expect(out.create).toBe("zzz")
  })
})

describe("titleAffinity", () => {
  it("counts meaningful shared words — case, plurals, and connectives don't", () => {
    expect(titleAffinity("Q3 pricing page", "Pricing work")).toBe(1)
    expect(titleAffinity("Screenshots of the launch", "launch screenshot")).toBe(2)
    expect(titleAffinity("The plan for launch", "Plan of the launch")).toBe(2)
    expect(titleAffinity("Brand", "Pricing")).toBe(0)
    // Stopwords and short tokens alone never bind two titles together.
    expect(titleAffinity("The A to Z", "The Z of A")).toBe(0)
  })
})
