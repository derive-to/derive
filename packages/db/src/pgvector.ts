// The pgvector storage half of the dense/semantic search arm — vectors live in the SAME Postgres
// as the artifacts (no second datastore to run, and no per-query vector billing). The dense write
// is NOT in the same transaction as the metadata write (the caller runs it best-effort after the
// lexical index, on a separate pool — see lib/search.ts), but pgvector's HNSW indexes an insert
// synchronously, so a committed vector is queryable on the NEXT request — no async-indexing
// propagation lag like Vectorize. This is the storage counterpart to a Cloudflare Vectorize index;
// it holds NO embedding or chunking logic (that's the SearchIndex adapter that composes it) and NO
// visibility knowledge (the caller's Tier-2 gate owns that, exactly as the FTS).
//
// Vectors are passed as `$n::vector` TEXT params and read back via `embedding::text` — deliberately
// NOT the pgvector-node custom type. That type needs a per-connection OID registration keyed to the
// extension's per-database dynamic OID, which is the one real footgun over Cloudflare Hyperdrive's
// pooled connections; the text-cast path is plain SQL and sidesteps it entirely (validated on both
// node-postgres and the target Neon instance).

/** The slice of a node-postgres Pool/Client this store uses. `pg.Pool` satisfies it structurally,
 *  which keeps this file unit-testable with a fake and free of a hard `pg` type dependency. */
export interface SqlExecutor {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** One chunk vector to store. `embedding.length` MUST equal the store's configured `dimensions`. */
export interface VectorRow {
  vectorId: string
  artifactId: string
  orgId: string
  chunk: number
  embedding: number[]
  snippet: string
}

/** A raw chunk match from a similarity query, before the adapter rolls chunks up to artifacts. */
export interface VectorMatch {
  artifactId: string
  chunk: string
  score: number
}

/** The storage operations a dense-search adapter needs — the seam PgVectorStore implements, so the
 *  adapter (PgvectorSearchIndex) depends on the interface and is unit-testable with a fake store. */
export interface VectorStore {
  upsert(rows: VectorRow[]): Promise<void>
  deleteByIds(ids: string[]): Promise<void>
  deleteByArtifact(artifactId: string): Promise<void>
  query(orgId: string, vector: number[], topK: number): Promise<VectorMatch[]>
  /** One stored embedding by its vector id, or null when absent — lets a caller run a
   *  similarity query FROM an already-indexed chunk without re-embedding anything. */
  getVector(vectorId: string): Promise<number[] | null>
}

// Serialize a JS number[] to a pgvector text literal `[1,2,3]`. Guards NaN/Infinity (a bad
// embedding must fail loudly, not write a corrupt vector Postgres would reject mid-batch anyway).
const toVectorLiteral = (v: number[]): string => {
  for (const n of v)
    if (!Number.isFinite(n)) throw new Error("embedding contains a non-finite value")
  return `[${v.join(",")}]`
}

const UPSERT_BATCH = 200

export class PgVectorStore implements VectorStore {
  constructor(
    private readonly sql: SqlExecutor,
    /** Vector length the column + HNSW index are sized to — from the paired Embedder. A change
     *  means a new table/index + full re-backfill (a different-dim vector can't be stored). */
    private readonly dimensions: number,
    /** Table name; overridable for tests. */
    private readonly table: string = "artifact_vec",
  ) {}

  // Create the extension, the vector table, and its indexes. Idempotent; run ONCE at boot (Node)
  // or out-of-band at deploy (edge) — never in the query path. `CREATE EXTENSION` needs a role
  // allowed to create it (Neon grants this; a locked-down self-host Postgres may need an operator
  // to `CREATE EXTENSION vector` once first — then this call is a no-op).
  //
  // The column is `vector(N)`; if a table already exists at a DIFFERENT dimension (an embedder
  // swap), we do NOT silently reuse it — that would mix incompatible vector spaces. We detect and
  // throw with a clear message directing a drop + re-backfill.
  async ensureSchema(): Promise<void> {
    await this.sql.query("CREATE EXTENSION IF NOT EXISTS vector")
    // `pg_table_is_visible` scopes to the search_path, so we read OUR `artifact_vec` — not a
    // same-named table in another schema (multi-tenant-by-schema, or overlapping test schemas).
    // pgvector stores the dimension directly in atttypmod (no varchar-style +4 offset — verified).
    const existing = await this.sql.query(
      `SELECT a.atttypmod AS dim
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = $1 AND a.attname = 'embedding' AND pg_table_is_visible(c.oid)`,
      [this.table],
    )
    const priorDim = existing.rows[0]?.dim
    if (typeof priorDim === "number" && priorDim > 0 && priorDim !== this.dimensions)
      throw new Error(
        `${this.table}.embedding is vector(${priorDim}) but the configured embedder is ${this.dimensions}-dim; ` +
          `drop the table and re-backfill (an embedder/dimension change can't reuse the old vectors)`,
      )
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         vector_id text PRIMARY KEY,
         artifact_id text NOT NULL,
         org_id text NOT NULL,
         chunk int NOT NULL,
         embedding vector(${this.dimensions}) NOT NULL,
         snippet text NOT NULL DEFAULT ''
       )`,
    )
    // Cosine HNSW for the ANN read; a plain btree on org_id/artifact_id for the org filter and the
    // delete-by-artifact sweep. HNSW builds incrementally on insert, so order here doesn't matter.
    await this.sql.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_hnsw ON ${this.table} USING hnsw (embedding vector_cosine_ops)`,
    )
    await this.sql.query(`CREATE INDEX IF NOT EXISTS ${this.table}_org ON ${this.table} (org_id)`)
    await this.sql.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_artifact ON ${this.table} (artifact_id)`,
    )
  }

  // Upsert chunk vectors, batched. Each row's vector is a `$n::vector` text param; ON CONFLICT
  // keeps a re-index idempotent. A length mismatch throws before any SQL (no partial corrupt row).
  async upsert(rows: VectorRow[]): Promise<void> {
    for (const r of rows)
      if (r.embedding.length !== this.dimensions)
        throw new Error(
          `vector for ${r.vectorId} is ${r.embedding.length}-dim, expected ${this.dimensions}`,
        )
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH)
      const values: string[] = []
      const params: unknown[] = []
      batch.forEach((r, j) => {
        const b = j * 6
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::vector,$${b + 6})`)
        params.push(
          r.vectorId,
          r.artifactId,
          r.orgId,
          r.chunk,
          toVectorLiteral(r.embedding),
          r.snippet,
        )
      })
      await this.sql.query(
        `INSERT INTO ${this.table} (vector_id, artifact_id, org_id, chunk, embedding, snippet)
         VALUES ${values.join(",")}
         ON CONFLICT (vector_id) DO UPDATE SET
           artifact_id = EXCLUDED.artifact_id, org_id = EXCLUDED.org_id,
           chunk = EXCLUDED.chunk, embedding = EXCLUDED.embedding, snippet = EXCLUDED.snippet`,
        params,
      )
    }
  }

  // Delete specific chunk-vector ids (the stale-slot sweep). `= ANY($1)` takes the whole list in
  // one round-trip; Postgres has no small IN-list cap the way Vectorize caps deleteByIds.
  async deleteByIds(ids: string[]): Promise<void> {
    if (!ids.length) return
    await this.sql.query(`DELETE FROM ${this.table} WHERE vector_id = ANY($1)`, [ids])
  }

  // Every chunk vector for an artifact, in one statement — the clean hard-delete path (unindex).
  async deleteByArtifact(artifactId: string): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.table} WHERE artifact_id = $1`, [artifactId])
  }

  // One stored embedding, read back as a JS vector. pgvector's text form is `[0.1,0.2,…]` —
  // valid JSON — so parse rather than hand-split. Null when the id has no row.
  async getVector(vectorId: string): Promise<number[] | null> {
    const { rows } = await this.sql.query(
      `SELECT embedding::text AS embedding FROM ${this.table} WHERE vector_id = $1`,
      [vectorId],
    )
    const text = rows[0]?.embedding
    if (typeof text !== "string") return null
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== "number"))
      throw new Error(`stored vector ${vectorId} did not parse to a number array`)
    return parsed as number[]
  }

  // Top-`topK` nearest chunks in ONE org by cosine similarity. Returns similarity (1 − distance)
  // as `score` so higher = better, matching the SearchIndex/RRF convention. No visibility filter —
  // the caller gates.
  //
  // Plan reality: Postgres uses ONE index per scan. This is an HNSW scan (`ORDER BY <=>`) whose
  // candidates are then post-filtered by `org_id` — NOT a btree-first-then-HNSW plan (that can't
  // exist). The candidate breadth is governed by `hnsw.ef_search` (pgvector's default is 40, so
  // topK must be ≤ it or results silently truncate): the caller sets it ≥ topK on the pooled
  // connection (see node.ts). Caveat: in a DB where one org is a small fraction of all vectors, the
  // ef_search global-nearest set can contain few rows for that org → thinner dense recall for small
  // tenants. Self-host is typically one/few workspaces, so this is minor there; fused with lexical.
  async query(orgId: string, vector: number[], topK: number): Promise<VectorMatch[]> {
    const lit = toVectorLiteral(vector)
    const { rows } = await this.sql.query(
      `SELECT artifact_id, snippet, 1 - (embedding <=> $2::vector) AS score
         FROM ${this.table}
        WHERE org_id = $1
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      [orgId, lit, Math.max(topK, 1)],
    )
    return rows.map((r) => ({
      artifactId: String(r.artifact_id),
      chunk: typeof r.snippet === "string" ? r.snippet : "",
      score: Number(r.score),
    }))
  }
}
