#!/usr/bin/env node
import { pathToFileURL } from "node:url"

// Preview config generation cannot retire triggers on Workers deployed before it existed.
// Read the account's live configuration before production ships: a stale scheduler sharing
// its database can consume work even when the current scheduler is correct.
export async function auditWorkerCrons({ accountId, token, worker = "derive", fetchImpl = fetch }) {
  if (!accountId || !token) throw new Error("Cloudflare account and API token are required")
  const root = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts`
  const get = async (path) => {
    let response
    try {
      response = await fetchImpl(root + path, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new Error("Could not read Cloudflare Worker configuration")
    }
    if (!response.ok)
      throw new Error(`Cloudflare configuration read failed: HTTP ${response.status}`)
    const body = await response.json()
    if (body.success !== true) throw new Error("Cloudflare configuration read was unsuccessful")
    return body.result
  }
  const settings = await get(`/${encodeURIComponent(worker)}/settings`)
  const databases = new Set(
    settings.bindings.filter((b) => b.type === "hyperdrive").map((b) => b.id),
  )
  if (!databases.size) throw new Error("Production Worker has no Hyperdrive binding to audit")
  const workers = await get("")
  if (!Array.isArray(workers) || !workers.some((w) => w.id === worker))
    throw new Error("Cloudflare inventory is missing the production Worker")
  const conflicts = []
  for (const other of workers) {
    if (other.id === worker) continue
    const path = `/${encodeURIComponent(other.id)}`
    const { schedules } = await get(`${path}/schedules`)
    if (!Array.isArray(schedules)) throw new Error("Cloudflare returned an invalid cron inventory")
    if (!schedules.length) continue
    const { bindings } = await get(`${path}/settings`)
    if (bindings.some((b) => b.type === "hyperdrive" && databases.has(b.id)))
      conflicts.push(other.id)
  }
  if (conflicts.length)
    throw new Error(
      `Other Workers have cron triggers on the production database: ${conflicts.join(", ")}`,
    )
  return { inspected: workers.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await auditWorkerCrons({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    })
    console.log(`Worker cron audit passed (${result.inspected} Workers inspected)`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
