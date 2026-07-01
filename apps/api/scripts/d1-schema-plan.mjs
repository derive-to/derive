// Pure planning for the D1 schema apply (apply-d1-schema.mjs). Side-effect-free so it's
// unit-tested (d1-schema-plan.test.ts) without invoking wrangler; the apply script wraps
// these with the live D1 I/O.

/**
 * Parse `{ table: { column: "<full column def line>" } }` from a generated d1-schema.sql.
 * Only real column lines are kept — table-level constraints (UNIQUE/PRIMARY/FOREIGN/…) and
 * blank lines are skipped.
 */
export const parseExpectedColumns = (sql) => {
  const expected = {}
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\);/g
  let m = re.exec(sql)
  while (m) {
    const cols = {}
    for (const raw of m[2].split("\n")) {
      const line = raw.trim().replace(/,$/, "")
      if (!line || /^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line)) continue
      const col = line.split(/\s+/)[0]
      if (/^\w+$/.test(col)) cols[col] = line
    }
    expected[m[1]] = cols
    m = re.exec(sql)
  }
  return expected
}

/**
 * A column ADDED to an existing (populated) table must be nullable or carry a constant
 * DEFAULT — SQLite/D1 reject `ADD COLUMN` of a NOT NULL column with no default. Derive's
 * schema policy is additive-only (CONTRIBUTING.md → Database migrations); this is the
 * deploy-time backstop for it.
 */
export const isUnsafeAdd = (def) => /\bNOT NULL\b/i.test(def) && !/\bDEFAULT\b/i.test(def)

/**
 * Diff the expected columns against the live DB (`{ table: Set<column> }`) and split the
 * missing ones into safe `ALTER … ADD COLUMN` statements and `unsafe` adds (NOT NULL with
 * no default) that must not be attempted — the caller aborts the deploy if any are unsafe,
 * before running a single ALTER, so the database is left untouched.
 */
export const planColumnAdds = (expected, live) => {
  const alters = []
  const unsafe = []
  for (const [tbl, cols] of Object.entries(expected))
    for (const [col, def] of Object.entries(cols))
      if (live[tbl] && !live[tbl].has(col)) {
        if (isUnsafeAdd(def)) unsafe.push({ tbl, col, def })
        else alters.push(`ALTER TABLE ${tbl} ADD COLUMN ${def};`)
      }
  return { alters, unsafe }
}
