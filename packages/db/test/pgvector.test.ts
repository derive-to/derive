import { randomUUID as uuid } from "node:crypto"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { PgVectorStore } from "../src/pgvector"

// PgVectorStore against a REAL pgvector-enabled Postgres (the store half of the dense arm).
// Gated on DERIVE_TEST_DB=pg + TEST_DATABASE_URL, set by `scripts/test-pg.sh` / the CI pg job —
// which now stand up the `pgvector/pgvector` image so `CREATE EXTENSION vector` is available.
// Without the env it's a no-op, so `pnpm test` stays zero-config on SQLite.
const PG_URL = process.env.DERIVE_TEST_DB === "pg" ? process.env.TEST_DATABASE_URL : undefined

// Deterministic little vectors so cosine ranking is hand-verifiable. Dim 4 keeps the test legible;
// the real embedders are 1024/384-dim but the SQL is dimension-agnostic.
const DIM = 4

if (PG_URL) {
  const url = PG_URL
  const schema = `t_vec_${process.pid}_${uuid().replace(/-/g, "")}`
  // search_path puts our isolated schema FIRST (tables land there, dropped on teardown) but keeps
  // `public` so the `vector` type resolves wherever the extension is installed — matching a real
  // deployment's default `"$user",public` search_path (extension in public, app tables alongside).
  const pool = new Pool({
    connectionString: `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent(
      `-c search_path=${schema},public`,
    )}`,
    max: 2,
  })
  // Mirror prod: widen the HNSW candidate breadth per connection (node.ts does this via the pool's
  // connect handler; the edge via ALTER DATABASE). Lets the ef_search guard test below reach 50.
  pool.on("connect", (c) => {
    c.query("SET hnsw.ef_search = 100").catch(() => {})
  })

  const boot = async () => {
    const b = new Pool({ connectionString: url, max: 1 })
    await b.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await b.end()
    const store = new PgVectorStore(pool, DIM)
    await store.ensureSchema()
    return store
  }

  afterAll(async () => {
    await pool.end()
    const drop = new Pool({ connectionString: url, max: 1 })
    await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await drop.end()
  })

  describe("PgVectorStore (real pgvector)", () => {
    it("ensureSchema creates the extension, table and HNSW index (idempotent)", async () => {
      const store = await boot()
      await store.ensureSchema() // second call must not throw
      const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname='vector'")
      expect(ext.rows.length).toBe(1)
      const idx = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename='artifact_vec'`,
        [schema],
      )
      expect(idx.rows.some((r) => String(r.indexdef).includes("hnsw"))).toBe(true)
    })

    it("upsert + query ranks chunks by cosine similarity, org-scoped", async () => {
      const store = await boot()
      await store.upsert([
        {
          vectorId: "a1#0",
          artifactId: "a1",
          orgId: "o1",
          chunk: 0,
          embedding: [1, 0, 0, 0],
          snippet: "head",
        },
        {
          vectorId: "a1#1",
          artifactId: "a1",
          orgId: "o1",
          chunk: 1,
          embedding: [0, 1, 0, 0],
          snippet: "mid",
        },
        {
          vectorId: "a2#0",
          artifactId: "a2",
          orgId: "o1",
          chunk: 0,
          embedding: [0, 0, 1, 0],
          snippet: "other",
        },
        {
          vectorId: "b1#0",
          artifactId: "b1",
          orgId: "o2",
          chunk: 0,
          embedding: [1, 0, 0, 0],
          snippet: "wrong org",
        },
      ])
      const hits = await store.query("o1", [1, 0.1, 0, 0], 10)
      expect(hits.map((h) => h.artifactId)).toEqual(["a1", "a1", "a2"]) // b1 excluded by org
      expect(hits[0]?.chunk).toBe("head") // snippet returned as `chunk`
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1) // cosine desc
      expect(hits[0]?.score).toBeCloseTo(0.995, 2)
    })

    it("upsert is idempotent on vector_id (re-index overwrites, no duplicate rows)", async () => {
      const store = await boot()
      await store.upsert([
        {
          vectorId: "c1#0",
          artifactId: "c1",
          orgId: "o3",
          chunk: 0,
          embedding: [1, 0, 0, 0],
          snippet: "v1",
        },
      ])
      await store.upsert([
        {
          vectorId: "c1#0",
          artifactId: "c1",
          orgId: "o3",
          chunk: 0,
          embedding: [0, 1, 0, 0],
          snippet: "v2",
        },
      ])
      const rows = await pool.query("SELECT snippet FROM artifact_vec WHERE vector_id='c1#0'")
      expect(rows.rows.length).toBe(1)
      expect(rows.rows[0]?.snippet).toBe("v2")
    })

    it("deleteByIds drops specific chunk slots; deleteByArtifact drops all of an artifact", async () => {
      const store = await boot()
      await store.upsert([
        {
          vectorId: "d1#0",
          artifactId: "d1",
          orgId: "o4",
          chunk: 0,
          embedding: [1, 0, 0, 0],
          snippet: "0",
        },
        {
          vectorId: "d1#1",
          artifactId: "d1",
          orgId: "o4",
          chunk: 1,
          embedding: [0, 1, 0, 0],
          snippet: "1",
        },
        {
          vectorId: "d1#2",
          artifactId: "d1",
          orgId: "o4",
          chunk: 2,
          embedding: [0, 0, 1, 0],
          snippet: "2",
        },
      ])
      await store.deleteByIds(["d1#1", "d1#2"])
      let rows = await pool.query(
        "SELECT vector_id FROM artifact_vec WHERE artifact_id='d1' ORDER BY chunk",
      )
      expect(rows.rows.map((r) => r.vector_id)).toEqual(["d1#0"])
      await store.deleteByArtifact("d1")
      rows = await pool.query("SELECT vector_id FROM artifact_vec WHERE artifact_id='d1'")
      expect(rows.rows.length).toBe(0)
    })

    it("deleteByIds([]) is a no-op (no malformed SQL)", async () => {
      const store = await boot()
      await expect(store.deleteByIds([])).resolves.toBeUndefined()
    })

    it("honors hnsw.ef_search so a topK-50 query isn't capped at pgvector's default of 40", async () => {
      const store = await boot()
      // 60 distinct single-chunk vectors in one org. With ef_search=100 (set on the pool above,
      // as prod does) a topK-50 query returns 50 — NOT the ≤40 an HNSW scan yields at the default
      // ef_search=40. This regression-guards the ef_search wiring: remove the SET and this drops.
      await store.upsert(
        Array.from({ length: 60 }, (_, i) => ({
          vectorId: `ef#${i}`,
          artifactId: `ef${i}`,
          orgId: "oef",
          chunk: 0,
          embedding: [1, i / 200, 0, 0],
          snippet: `s${i}`,
        })),
      )
      const hits = await store.query("oef", [1, 0, 0, 0], 50)
      expect(hits.length).toBe(50)
    })

    it("upsert splits >UPSERT_BATCH(200) rows across statements, storing them all", async () => {
      const store = await boot()
      const n = 250 // > the 200-row batch → exercises the multi-statement split + param offsets
      await store.upsert(
        Array.from({ length: n }, (_, i) => ({
          vectorId: `bulk#${i}`,
          artifactId: "bulk",
          orgId: "obulk",
          chunk: i,
          embedding: [i % 2, (i + 1) % 2, 0, 0],
          snippet: `s${i}`,
        })),
      )
      const count = await pool.query(
        "SELECT count(*)::int AS c FROM artifact_vec WHERE artifact_id='bulk'",
      )
      expect(count.rows[0]?.c).toBe(n)
      // spot-check a row from the SECOND batch survived with the right snippet (param-offset check)
      const spot = await pool.query("SELECT snippet FROM artifact_vec WHERE vector_id='bulk#233'")
      expect(spot.rows[0]?.snippet).toBe("s233")
    })

    it("rejects a wrong-dimension vector before writing", async () => {
      const store = await boot()
      await expect(
        store.upsert([
          {
            vectorId: "e1#0",
            artifactId: "e1",
            orgId: "o5",
            chunk: 0,
            embedding: [1, 0, 0],
            snippet: "short",
          },
        ]),
      ).rejects.toThrow(/3-dim, expected 4/)
    })

    it("rejects a non-finite embedding value", async () => {
      const store = await boot()
      await expect(
        store.upsert([
          {
            vectorId: "f1#0",
            artifactId: "f1",
            orgId: "o6",
            chunk: 0,
            embedding: [1, Number.NaN, 0, 0],
            snippet: "nan",
          },
        ]),
      ).rejects.toThrow(/non-finite/)
    })

    it("ensureSchema throws on a dimension mismatch (embedder swap needs a re-backfill)", async () => {
      await boot() // table is vector(4)
      const wrong = new PgVectorStore(pool, 8)
      await expect(wrong.ensureSchema()).rejects.toThrow(/vector\(4\).*8-dim|8-dim.*re-backfill/)
    })
  })
}

// Keep the suite non-empty when the pg env is absent, so vitest doesn't error on an empty file.
if (!PG_URL) {
  describe("PgVectorStore", () => {
    it.skip("skipped — set DERIVE_TEST_DB=pg + TEST_DATABASE_URL (pgvector image) to run", () => {})
  })
}
