import { DuckDBInstance } from "@duckdb/node-api"

const base = "http://localhost:8791/raw"
const urls = ["gr07h6c7", "kb29yhrq", "zo1tgxr1"]
  .map((id) => `'${base}/${id}/data/checks.jsonl'`)
  .join(", ")
const db = await DuckDBInstance.create(":memory:")
const c = await db.connect()
const run = async (label, sql) => {
  try {
    const r = await c.runAndReadAll(sql)
    console.log("\n### " + label)
    for (const row of r.getRowObjects())
      console.log("   " + JSON.stringify(row, (k, v) => (typeof v === "bigint" ? Number(v) : v)))
  } catch (e) {
    console.log("\n### " + label + "\nFAILED: " + String(e.message).slice(0, 300))
  }
}
// THREE artifacts, three URLs, one table. filename=true names which artifact a row came from.
await run(
  "the workspace as a table: latest pass per artifact",
  `WITH s AS (SELECT filename, n, data.pass AS pass FROM read_json_auto([${urls}], filename=true))
   SELECT regexp_extract(filename, 'raw/([^/]+)/', 1) AS artifact, max(n) AS latest_version,
          max_by(pass, n) AS pass_now, count(*) AS versions
   FROM s GROUP BY 1 ORDER BY pass_now DESC`,
)
await run(
  "which artifact is regressing (last delta < 0)",
  `WITH s AS (SELECT regexp_extract(filename, 'raw/([^/]+)/', 1) AS a, n, data.pass AS pass
              FROM read_json_auto([${urls}], filename=true)),
        d AS (SELECT a, n, pass - lag(pass) OVER (PARTITION BY a ORDER BY n) AS delta FROM s)
   SELECT a AS artifact, max_by(delta, n) AS last_delta FROM d GROUP BY 1 ORDER BY 2`,
)
