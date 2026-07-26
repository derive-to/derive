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
 * Split a generated d1-schema.sql into the statements that must run BEFORE the additive
 * column reconciler (tables, virtual tables) and the CREATE [UNIQUE] INDEX statements that
 * must run AFTER it. A partial index — context_session_dedupe — references a column the
 * `alters` add on an existing DB, so creating it before the ADD COLUMN throws "no such
 * column" and aborts the whole apply before any ALTER runs (the exact hazard PG and SQLite
 * already order around: index after alters). Deferring every index to the tail mirrors that.
 * The generated file has no `;` inside a statement, so a split on `;` is safe; the header's
 * full-line `--` comments are dropped so they don't ride along as a bare statement.
 */
export const partitionStatements = (sql) => {
  const preIndex = []
  const indexes = []
  for (const raw of sql.replace(/^\s*--.*$/gm, "").split(";")) {
    const stmt = raw.trim()
    if (!stmt) continue
    ;(/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stmt) ? indexes : preIndex).push(`${stmt};`)
  }
  return { preIndex, indexes }
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
