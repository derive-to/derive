/** Recognize the narrow missing-table shape used by production-backed PR
 * previews. They intentionally deploy code without applying unmerged DDL, so a
 * new feature can explain that release sequencing state without hiding any
 * unrelated database failure. */
export const isMissingTable = (error: unknown, tables: readonly string[]): boolean => {
  const names = tables.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const sqlite = new RegExp(`no such table:\\s*(?:main\\.)?(?:${names})\\b`, "i")
  const postgres = new RegExp(`relation\\s+["']?(?:${names})["']?\\s+does not exist`, "i")
  const seen = new Set<unknown>()
  let current = error

  for (let depth = 0; current != null && depth < 6 && !seen.has(current); depth++) {
    seen.add(current)
    if (typeof current === "string") return sqlite.test(current) || postgres.test(current)
    if (typeof current !== "object") break

    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (typeof candidate.message === "string") {
      if (sqlite.test(candidate.message) || postgres.test(candidate.message)) return true
    } else if (candidate.code === "42P01") {
      // node-postgres normally includes the relation in `message`; retain the
      // useful classification if an adapter preserves only its SQLSTATE.
      return true
    }
    current = candidate.cause
  }

  return false
}
