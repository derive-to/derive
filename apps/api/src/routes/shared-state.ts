import { newId, type SharedStateAction } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const MAX_ITEMS = 2_000
const MAX_BYTES = 256 * 1024
const CAS_ATTEMPTS = 8
const RESERVED_FIELDS = new Set(["id", "__proto__", "constructor", "prototype"])

const JsonObject = z.record(z.string(), z.unknown())
const Mutation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    initial: z.unknown().optional().default([]),
    value: JsonObject,
  }),
  z.object({
    op: z.literal("update"),
    initial: z.unknown().optional().default([]),
    id: z.string().min(1).max(128),
    patch: JsonObject,
  }),
])

type Item = Record<string, unknown> & { id: string }
type MutationBody = z.infer<typeof Mutation>

const collection = (value: unknown, mintMissingIds: boolean): Item[] | string => {
  if (!Array.isArray(value)) return "shared state must be an array"
  if (value.length > MAX_ITEMS) return `shared state is limited to ${MAX_ITEMS} items`
  const items: Item[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return "every shared-state item must be an object"
    const object = item as Record<string, unknown>
    for (const key of Object.keys(object))
      if (RESERVED_FIELDS.has(key) && key !== "id") return `field "${key}" is reserved`
    if (typeof object.id === "string") items.push(object as Item)
    else if (mintMissingIds) items.push({ ...object, id: newId("item") })
    else return "every stored shared-state item must have an id"
  }
  return items
}

const incrementBy = (value: unknown): number | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const marker = value as Record<string, unknown>
  if (Object.keys(marker).length !== 1) return null
  const by = marker.__derive_increment
  return typeof by === "number" && Number.isFinite(by) && Math.abs(by) <= 1_000_000 ? by : null
}

const apply = (
  items: Item[],
  body: MutationBody,
  addId: string,
): { value: Item[]; itemId: string } | string => {
  if (body.op === "add") {
    for (const key of Object.keys(body.value))
      if (RESERVED_FIELDS.has(key) && key !== "id") return `field "${key}" is reserved`
    if (items.length >= MAX_ITEMS) return `shared state is limited to ${MAX_ITEMS} items`
    return { value: [...items, { ...body.value, id: addId }], itemId: addId }
  }

  const at = items.findIndex((item) => item.id === body.id)
  if (at < 0) return "item not found"
  const next = { ...items[at] } as Item
  for (const [key, value] of Object.entries(body.patch)) {
    if (RESERVED_FIELDS.has(key)) return `field "${key}" is reserved`
    const by = incrementBy(value)
    next[key] = by === null ? value : (typeof next[key] === "number" ? next[key] : 0) + by
  }
  const value = items.slice()
  value[at] = next
  return { value, itemId: body.id }
}

const publicState = (row: { json: string; version: number } | null) => ({
  value: row ? JSON.parse(row.json) : null,
  version: row?.version ?? 0,
})

/** Persistent JSON collections for mini-app artifacts. Reads follow artifact
 * visibility; mutations deliberately reuse COMMENT permission, so collaborators
 * can interact without receiving source-edit rights. */
export const sharedStateRoutes = (ctx: AppContext) => {
  const { meta, bus, requireArtifact, actingUser } = ctx
  const app = new Hono()

  app.get("/v1/artifacts/:shortId/state/:key", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const key = c.req.param("key")
    if (!KEY.test(key)) return fail(c, 400, "invalid shared-state key")
    return c.json(publicState(await meta.getSharedState(artifact.id, key)))
  })

  app.get("/v1/artifacts/:shortId/state/:key/activity", async (c) => {
    const artifact = await requireArtifact(c, "comment", { split: true })
    if (artifact instanceof Response) return artifact
    const key = c.req.param("key")
    if (!KEY.test(key)) return fail(c, 400, "invalid shared-state key")
    const rows = await meta.listSharedStateActivity(artifact.id, key, 50)
    return c.json({
      activity: rows.map((row) => ({
        action: row.action,
        version: row.version,
        item_id: row.item_id,
        actor: { id: row.actor_id, name: row.actor_name },
        at: row.created_at,
      })),
    })
  })

  app.post("/v1/artifacts/:shortId/state/:key", async (c) => {
    const artifact = await requireArtifact(c, "comment", { split: true })
    if (artifact instanceof Response) return artifact
    const key = c.req.param("key")
    if (!KEY.test(key)) return fail(c, 400, "invalid shared-state key")
    const body = await readJson(c, Mutation)
    if (body instanceof Response) return body
    const actor = (await actingUser(c)) ?? { id: "system", name: "automation" }
    const stateId = newId("state")
    const itemId = body.op === "add" ? newId("item") : body.id

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await meta.getSharedState(artifact.id, key)
      let parsed: unknown
      try {
        parsed = current ? JSON.parse(current.json) : body.initial
      } catch {
        return fail(c, 500, "stored shared state is invalid")
      }
      const items = collection(parsed, !current)
      if (typeof items === "string") return fail(c, 400, items)
      const changed = apply(items, body, itemId)
      if (typeof changed === "string")
        return fail(c, changed === "item not found" ? 404 : 400, changed)
      const json = JSON.stringify(changed.value)
      if (new TextEncoder().encode(json).byteLength > MAX_BYTES)
        return fail(c, 413, `shared state is limited to ${MAX_BYTES / 1024} KB`)
      const at = new Date().toISOString()
      const saved = await meta.putSharedState({
        id: stateId,
        artifact_id: artifact.id,
        key,
        json,
        expected_version: current?.version ?? 0,
        updated_by_id: actor.id,
        updated_by_name: actor.name,
        updated_at: at,
      })
      if (!saved) continue

      const activity = {
        id: newId("activity"),
        artifact_id: artifact.id,
        key,
        version: saved.version,
        action: body.op as SharedStateAction,
        item_id: changed.itemId,
        actor_id: actor.id,
        actor_name: actor.name,
        created_at: at,
      }
      // State correctness is the primary write. An activity-ledger outage must not
      // make a client retry an already-applied increment and count it twice.
      await meta.appendSharedStateActivity(activity).catch(() => undefined)
      const response = publicState(saved)
      bus.publish(artifact.id, { type: "artifact.state.updated", key, ...response })
      return c.json(response)
    }
    return fail(c, 409, "shared state changed; try again")
  })

  return app
}
