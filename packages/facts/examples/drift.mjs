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
    console.log("\n### " + label + "\nFAILED: " + String(e.message).slice(0, 300))
  }
}
await run("schema across a DRIFTING series", `DESCRIBE SELECT * FROM read_json_auto('${URL}')`)
await run(
  "query a field that only SOME versions have",
  `SELECT n, data.pass AS pass, data.fail AS fail, data.flaky AS flaky FROM read_json_auto('${URL}') ORDER BY n`,
)
await run(
  "does a dropped field become NULL or an error",
  `SELECT count(*) AS rows, count(data.fail) AS have_fail, count(data.flaky) AS have_flaky FROM read_json_auto('${URL}')`,
)
