import { DuckDBInstance } from "@duckdb/node-api"

const URL = "http://localhost:8791/raw/gr07h6c7/data/checks.jsonl"
const db = await DuckDBInstance.create(":memory:")
const c = await db.connect()
const run = async (label, sql) => {
  try {
    const r = await c.runAndReadAll(sql)
    console.log("\n### " + label)
    console.log(
      JSON.stringify(r.getRowObjects(), (k, v) => (typeof v === "bigint" ? Number(v) : v)),
    )
  } catch (e) {
    console.log("\n### " + label + "\nFAILED: " + String(e.message).slice(0, 220))
  }
}
await run(
  "1. schema inferred straight off the URL",
  `DESCRIBE SELECT * FROM read_json_auto('${URL}')`,
)
await run(
  "2. the trend, in SQL",
  `SELECT n, data.pass AS pass, data.fail AS fail FROM read_json_auto('${URL}') ORDER BY n`,
)
await run(
  "3. an aggregate the host refuses to do",
  `SELECT count(*) AS versions, min(data.pass) AS worst, max(data.pass) AS best, round(avg(data.pass),1) AS mean FROM read_json_auto('${URL}')`,
)
await run(
  "4. window function over the series",
  `SELECT n, data.pass AS pass, data.pass - lag(data.pass) OVER (ORDER BY n) AS delta FROM read_json_auto('${URL}') ORDER BY n`,
)
