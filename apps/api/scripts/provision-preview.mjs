// Create data stores owned by one PR preview. Never accept a production resource name.
import { execFileSync } from "node:child_process"

const name = process.argv[2]
if (!/^derive-pr-\d+$/.test(name ?? "")) throw new Error("Expected a derive-pr-N name")
const run = (args) => execFileSync("wrangler", args, { encoding: "utf8" })
const databases = JSON.parse(run(["d1", "list", "--json"]))
let database = databases.find((row) => row.name === name)
if (!database) {
  const created = run(["d1", "create", name, "--update-config=false"])
  const id = /database_id\s*=\s*"([a-f0-9-]+)"/.exec(created)?.[1]
  if (!id) throw new Error("D1 creation did not return a database id")
  database = { name, uuid: id }
}
const bucket = `${name}-blobs`
try {
  run(["r2", "bucket", "create", bucket])
} catch (error) {
  const message = `${error.stdout ?? ""}\n${error.stderr ?? ""}`
  if (!/already exists/i.test(message)) throw error
}
process.stdout.write(
  JSON.stringify({ databaseName: name, databaseId: database.uuid, bucketName: bucket }),
)
