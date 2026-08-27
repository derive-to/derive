// Shared boot-DDL generator. Each dialect's DDL (SQLite in schema.ts, Postgres in
// pg-schema.ts, and D1 derived from SQLite) is generated from the same drizzle
// table defs via the dialect's getTableConfig, so the DDL can't drift from the
// schema and the three dialects stay in lockstep. Dialect differences (ADD COLUMN
// IF NOT EXISTS, the timestamp-default expression) are passed in; the structural
// result is identical everywhere.

// biome-ignore lint/suspicious/noExplicitAny: drizzle's per-dialect column/index/table runtime shapes aren't exported as stable types.
type Any = any

export interface DdlOptions {
  /** Postgres supports ADD COLUMN IF NOT EXISTS; SQLite relies on a boot try/catch
   *  ("duplicate column" = already applied), so it omits the clause. */
  ifNotExists: boolean
  /** The dialect's SQL for a created_at/$defaultFn timestamp default (e.g. SQLite's
   *  strftime(...) vs Postgres' to_char(now()...)). */
  timestampDefault: string
}

const sqlType = (c: Any): string => c.getSQLType().toUpperCase() // text/integer → TEXT/INTEGER

// A constant (string/number/bool) default rendered inline. null for anything else:
// a $defaultFn (default === undefined) or a drizzle sql`…` default (an object), both
// of which are non-constant and handled as the timestamp backstop below.
const literalDefault = (c: Any): string | null => {
  const d = c.default
  if (typeof d === "string") return `'${d}'`
  if (typeof d === "number" || typeof d === "boolean") return `${d}`
  return null
}
// A non-constant default (sql`…` or $defaultFn). drizzle fills $defaultFn at insert
// time; we mirror both with the dialect timestamp default as a server-side backstop.
// Every non-constant default in this schema is the created_at/next_attempt_at
// timestamp; a test pins that so a different one fails loudly.
export const isTimestampDefault = (c: Any): boolean => c.hasDefault && literalDefault(c) === null
const renderDefault = (c: Any, o: DdlOptions): string | null =>
  literalDefault(c) ?? (isTimestampDefault(c) ? o.timestampDefault : null)

// A column can be added to an EXISTING table only when it's nullable or has a
// CONSTANT default — both SQLite and Postgres reject adding a NOT NULL column with
// no constant default to populated rows. Primary keys and timestamp-default columns
// are therefore initial-only and never need a migration.
export const isMigratable = (c: Any): boolean =>
  !c.primary && !isTimestampDefault(c) && (!c.notNull || literalDefault(c) !== null)

export interface DdlPlan {
  /** Create the complete current table shape for a new database. */
  createTables: string[]
  /** Reconcile columns that can be added safely to an existing populated table. */
  addColumns: string[]
  /** Create non-unique secondary indexes after every table and migrated column exists. */
  createIndexes: string[]
}

/** Generate dependency-ordered boot DDL from the drizzle tables.
 *
 * Keeping tables, additive column migrations, and indexes as distinct phases is
 * load-bearing: CREATE TABLE IF NOT EXISTS does not update an existing table, and
 * an index may reference a column that only the migration phase can add. */
export function generateDdl(tables: Any[], getConfig: (t: Any) => Any, o: DdlOptions): DdlPlan {
  const tableName = (t: Any): string => getConfig(t).name
  const columnDef = (c: Any): string => {
    const p = [c.name, sqlType(c)]
    if (c.primary) p.push("PRIMARY KEY")
    else if (c.notNull) p.push("NOT NULL")
    if (c.isUnique && !c.primary) p.push("UNIQUE")
    const d = renderDefault(c, o)
    if (d) p.push(`DEFAULT ${d}`)
    return p.join(" ")
  }
  const createTable = (cfg: Any): string => {
    const lines: string[] = cfg.columns.map(columnDef)
    // Composite unique indexes render inline (matches the prior hand-written DDL +
    // its auto-named constraints); a non-unique index becomes a CREATE INDEX below.
    for (const idx of cfg.indexes)
      if (idx.config.unique)
        lines.push(`UNIQUE (${idx.config.columns.map((x: Any) => x.name).join(", ")})`)
    for (const fk of cfg.foreignKeys) {
      const r = fk.reference()
      const local = r.columns.map((x: Any) => x.name).join(", ")
      const cols = r.foreignColumns.map((x: Any) => x.name).join(", ")
      lines.push(`FOREIGN KEY (${local}) REFERENCES ${tableName(r.foreignTable)}(${cols})`)
    }
    return `CREATE TABLE IF NOT EXISTS ${cfg.name} (\n  ${lines.join(",\n  ")}\n)`
  }
  const addColumn = (table: string, c: Any): string => {
    const ine = o.ifNotExists ? "IF NOT EXISTS " : ""
    const p = [`ALTER TABLE ${table} ADD COLUMN ${ine}${c.name} ${sqlType(c)}`]
    if (c.notNull) p.push("NOT NULL")
    const d = renderDefault(c, o)
    if (d) p.push(`DEFAULT ${d}`)
    return p.join(" ")
  }

  const tableStatements: string[] = []
  const columnStatements: string[] = []
  const indexStatements: string[] = []
  for (const t of tables) {
    const cfg = getConfig(t)
    tableStatements.push(createTable(cfg))
    for (const idx of cfg.indexes)
      if (!idx.config.unique)
        indexStatements.push(
          `CREATE INDEX IF NOT EXISTS ${idx.config.name} ON ${cfg.name} (${idx.config.columns
            .map((x: Any) => x.name)
            .join(", ")})`,
        )
    for (const c of cfg.columns) if (isMigratable(c)) columnStatements.push(addColumn(cfg.name, c))
  }
  return {
    createTables: tableStatements,
    addColumns: columnStatements,
    createIndexes: indexStatements,
  }
}

/** The not-yet-queried placeholder tables (no drizzle def), created up front so
 *  migrations stay forward-only. `iso` is the dialect timestamp default. Inline
 *  REFERENCES works in both SQLite and Postgres CREATE. */
export const placeholderTables = (iso: string): string[] => [
  `CREATE TABLE IF NOT EXISTS principal (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT,
    kind TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL DEFAULT ${iso}
  )`,
  `CREATE TABLE IF NOT EXISTS view (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    version INTEGER NOT NULL,
    viewer TEXT NOT NULL,
    viewer_kind TEXT NOT NULL DEFAULT 'anon',
    created_at TEXT NOT NULL DEFAULT ${iso}
  )`,
  // A confirmed read: this viewer was still present, beating, CONFIRM_READ_MS after
  // their view landed (see confirmRead). Its own table rather than a column on `view`
  // because `view` has no drizzle def and so gets no automatic ADD COLUMN migration,
  // and SQLite has no ADD COLUMN IF NOT EXISTS — a new table is forward-only on all
  // three dialects. Keyed on (artifact, viewer): a read is a fact, not a counter.
  `CREATE TABLE IF NOT EXISTS view_read (
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    viewer TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${iso},
    PRIMARY KEY (artifact_id, viewer)
  )`,
]

/** Performance indexes (identical SQL across dialects; the unique ones are inline
 *  in each table's CREATE). Applied after every table + placeholder exists. */
export const PERF_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS artifact_org_created ON artifact (org_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS artifact_org_archived_created ON artifact (org_id, archived_at, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS view_artifact_time ON view (artifact_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS delivery_due ON webhook_delivery (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS render_job_due ON render_job (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS export_job_due ON export_job (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS export_job_artifact ON export_job (artifact_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS notification_user_time ON notification (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS agent_mention_inbox ON agent_mention (agent_id, state, created_at)`,
  `CREATE INDEX IF NOT EXISTS favorite_user ON artifact_favorite (user_id)`,
  `CREATE INDEX IF NOT EXISTS collection_favorite_user_idx ON collection_favorite (user_id)`,
  // The "Created by me" filter/badge walks a user's owner rows on every summary fetch.
  `CREATE INDEX IF NOT EXISTS artifact_member_by_user ON artifact_member (user_id)`,
  `CREATE INDEX IF NOT EXISTS tag_name ON artifact_tag (tag)`,
  `CREATE INDEX IF NOT EXISTS collection_item_artifact ON collection_item (artifact_id)`,
  `CREATE INDEX IF NOT EXISTS collection_member_user ON collection_member (user_id)`,
  `CREATE INDEX IF NOT EXISTS template_library_org_scope ON template_library (org_id, scope, created_at)`,
  `CREATE INDEX IF NOT EXISTS template_library_scope_time ON template_library (scope, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS template_library_owner ON template_library (created_by, created_at)`,
  `CREATE INDEX IF NOT EXISTS domain_artifact ON domain (artifact_id)`,
  `CREATE INDEX IF NOT EXISTS comment_artifact_state ON comment (artifact_id, state)`,
  `CREATE INDEX IF NOT EXISTS report_state ON report (state, created_at)`,
  `CREATE INDEX IF NOT EXISTS audit_artifact ON audit_log (artifact_id, created_at)`,
  // The operator's model timings read the newest AGENT answers across every session
  // (listRecentAgentMessages). The table's own index is keyed on session_id first, so it cannot
  // serve an unscoped newest-first scan — without this the query sorts the whole table on a page
  // that exists to be looked at while a provider is misbehaving.
  `CREATE INDEX IF NOT EXISTS session_message_recent ON session_message (author_kind, created_at)`,
]
