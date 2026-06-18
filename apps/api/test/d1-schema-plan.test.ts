import { describe, expect, it } from "vitest"
// @ts-expect-error — plain .mjs deploy helper, no types; tested for behavior only.
import { isUnsafeAdd, parseExpectedColumns, planColumnAdds } from "../scripts/d1-schema-plan.mjs"

const SCHEMA = `-- header
CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  title TEXT,
  author_login TEXT,
  UNIQUE (short_id)
);

CREATE TABLE IF NOT EXISTS version (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  author_login TEXT,
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE INDEX IF NOT EXISTS artifact_org ON artifact (org_id);
`

describe("parseExpectedColumns", () => {
  it("extracts real columns per table and skips table-level constraints", () => {
    const expected = parseExpectedColumns(SCHEMA)
    expect(Object.keys(expected)).toEqual(["artifact", "version"])
    expect(Object.keys(expected.artifact)).toEqual(["id", "short_id", "title", "author_login"])
    // UNIQUE/FOREIGN lines are not columns.
    expect(expected.artifact).not.toHaveProperty("UNIQUE")
    expect(expected.version).not.toHaveProperty("FOREIGN")
    expect(expected.artifact.author_login).toBe("author_login TEXT")
  })
})

describe("isUnsafeAdd", () => {
  it("flags NOT NULL with no default; allows nullable or constant-default", () => {
    expect(isUnsafeAdd("kind TEXT NOT NULL")).toBe(true)
    expect(isUnsafeAdd("author_login TEXT")).toBe(false)
    expect(isUnsafeAdd("n INTEGER NOT NULL DEFAULT 0")).toBe(false)
    expect(isUnsafeAdd("spa INTEGER DEFAULT 0")).toBe(false)
  })
})

describe("planColumnAdds", () => {
  const expected = {
    artifact: { id: "id TEXT PRIMARY KEY", title: "title TEXT", author_login: "author_login TEXT" },
  }

  it("emits ALTERs only for columns missing on the live table", () => {
    const live = { artifact: new Set(["id", "title"]) }
    const { alters, unsafe } = planColumnAdds(expected, live)
    expect(alters).toEqual(["ALTER TABLE artifact ADD COLUMN author_login TEXT;"])
    expect(unsafe).toEqual([])
  })

  it("adds nothing when the live table already has every column", () => {
    const live = { artifact: new Set(["id", "title", "author_login"]) }
    expect(planColumnAdds(expected, live)).toEqual({ alters: [], unsafe: [] })
  })

  it("collects an unsafe NOT-NULL-no-default add instead of emitting an ALTER", () => {
    const exp = { artifact: { kind: "kind TEXT NOT NULL" } }
    const live = { artifact: new Set(["id"]) }
    const { alters, unsafe } = planColumnAdds(exp, live)
    expect(alters).toEqual([])
    expect(unsafe).toEqual([{ tbl: "artifact", col: "kind", def: "kind TEXT NOT NULL" }])
  })

  it("skips tables absent from the live DB (created fresh, no ALTER needed)", () => {
    const { alters, unsafe } = planColumnAdds(expected, {})
    expect(alters).toEqual([])
    expect(unsafe).toEqual([])
  })
})
