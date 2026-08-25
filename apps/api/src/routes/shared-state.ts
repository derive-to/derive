import {
  isSharedStateKey,
  newId,
  SHARED_STATE_ACTIVITY_LIMIT,
  SHARED_STATE_MAX_BYTES,
  SHARED_STATE_MAX_ITEMS,
  SHARED_STATE_MAX_KEYS,
  type SharedStateAction,
  type SharedStateMutation,
} from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

const CAS_ATTEMPTS = 8
const ACTOR_FIELD = "__derive_actor_id"
const SLOT_FIELD = "__derive_slot"
const RESERVED_FIELDS = new Set([
  "id",
  ACTOR_FIELD,
  SLOT_FIELD,
  "__proto__",
  "constructor",
  "prototype",
])

const JsonObject = z.record(z.string(), z.unknown())
const Mutation: z.ZodType<SharedStateMutation> = z.discriminatedUnion("op", [
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
  z.object({
    op: z.literal("set_mine"),
    initial: z.unknown().optional().default([]),
    slot: z.string().min(1).max(128),
    value: JsonObject.nullable(),
  }),
])

type Item = Record<string, unknown> & { id: string }
type MutationBody = z.infer<typeof Mutation>

const collection = (
  value: unknown,
  mintMissingIds: boolean,
  allowActorFields = false,
): Item[] | string => {
  if (!Array.isArray(value)) return "shared state must be an array"
  if (value.length > SHARED_STATE_MAX_ITEMS)
    return `shared state is limited to ${SHARED_STATE_MAX_ITEMS} items`
  const items: Item[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return "every shared-state item must be an object"
    const object = item as Record<string, unknown>
    for (const key of Object.keys(object)) {
      const allowedActorField = allowActorFields && (key === ACTOR_FIELD || key === SLOT_FIELD)
      if (RESERVED_FIELDS.has(key) && key !== "id" && !allowedActorField)
        return `field "${key}" is reserved`
    }
    const actorId = object[ACTOR_FIELD]
    const slot = object[SLOT_FIELD]
    if (
      allowActorFields &&
      ((actorId === undefined) !== (slot === undefined) ||
        (actorId !== undefined && typeof actorId !== "string") ||
        (slot !== undefined && (typeof slot !== "string" || slot.length < 1 || slot.length > 128)))
    )
      return "stored actor-scoped state is invalid"
    let normalized: Item
    if (!Object.hasOwn(object, "id") && mintMissingIds)
      normalized = { ...object, id: newId("item") }
    else if (typeof object.id === "string" && object.id.length >= 1 && object.id.length <= 128)
      normalized = object as Item
    else return "every shared-state item id must be a 1-128 character string"
    if (ids.has(normalized.id)) return "shared-state item ids must be unique"
    ids.add(normalized.id)
    items.push(normalized)
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
  actorId: string,
): { value: Item[]; itemId: string; changed: boolean } | string => {
  if (body.op === "add") {
    for (const key of Object.keys(body.value))
      if (RESERVED_FIELDS.has(key)) return `field "${key}" is reserved`
    if (items.length >= SHARED_STATE_MAX_ITEMS)
      return `shared state is limited to ${SHARED_STATE_MAX_ITEMS} items`
    return { value: [...items, { ...body.value, id: addId }], itemId: addId, changed: true }
  }

  if (body.op === "set_mine") {
    if (body.value)
      for (const key of Object.keys(body.value))
        if (RESERVED_FIELDS.has(key)) return `field "${key}" is reserved`
    const at = items.findIndex(
      (item) => item[ACTOR_FIELD] === actorId && item[SLOT_FIELD] === body.slot,
    )
    if (body.value === null) {
      if (at < 0) return { value: items, itemId: addId, changed: false }
      const value = items.slice()
      const removed = value.splice(at, 1)[0]
      return { value, itemId: removed?.id ?? addId, changed: true }
    }
    const id = at < 0 ? addId : (items[at]?.id ?? addId)
    const item = {
      ...body.value,
      id,
      [ACTOR_FIELD]: actorId,
      [SLOT_FIELD]: body.slot,
    }
    if (at < 0) {
      if (items.length >= SHARED_STATE_MAX_ITEMS)
        return `shared state is limited to ${SHARED_STATE_MAX_ITEMS} items`
      return { value: [...items, item], itemId: id, changed: true }
    }
    const value = items.slice()
    value[at] = item
    return { value, itemId: id, changed: true }
  }

  const at = items.findIndex((item) => item.id === body.id)
  if (at < 0) return "item not found"
  if (items[at]?.[ACTOR_FIELD] !== undefined)
    return "actor-scoped items must be changed with set_mine"
  const next = { ...items[at] } as Item
  for (const [key, value] of Object.entries(body.patch)) {
    if (RESERVED_FIELDS.has(key)) return `field "${key}" is reserved`
    const by = incrementBy(value)
    next[key] = by === null ? value : (typeof next[key] === "number" ? next[key] : 0) + by
  }
  const value = items.slice()
  value[at] = next
  return { value, itemId: body.id, changed: true }
}

const publicCollection = (items: Item[], version: number, actorId: string | null) => {
  const mine: Record<string, string> = {}
  const value = items.map((item) => {
    const { [ACTOR_FIELD]: owner, [SLOT_FIELD]: slot, ...visible } = item
    if (actorId && owner === actorId && typeof slot === "string") mine[slot] = item.id
    return visible
  })
  return { value, version, mine }
}

const publicState = (row: { json: string; version: number } | null, actorId: string | null) => {
  if (!row) return { value: null, version: 0, mine: {} }
  const parsed = collection(JSON.parse(row.json), false, true)
  if (typeof parsed === "string") throw new Error(parsed)
  return publicCollection(parsed, row.version, actorId)
}

// A public commenter may create an item, set their own actor-scoped value, or
// apply the tiny atomic counter gesture the server understands. Arbitrary field
// replacement is source-level authority: hiding a control in artifact HTML is
// not authorization because callers can use the HTTP endpoint directly.
const commenterMutation = (body: MutationBody): boolean => {
  if (body.op === "add" || body.op === "set_mine") return true
  const values = Object.values(body.patch)
  return (
    values.length > 0 &&
    values.every((value) => {
      const by = incrementBy(value)
      return by === -1 || by === 1
    })
  )
}

/** Persistent JSON collections for mini-app artifacts. Reads follow artifact
 * visibility. Adds, actor-scoped values, and atomic counter gestures reuse
 * COMMENT permission; arbitrary field replacement follows PUBLISH permission. */
export const sharedStateRoutes = (ctx: AppContext) => {
  const { meta, bus, requireArtifact, authorize, actingUser, limited, commentLimiter } = ctx
  const app = new Hono()

  app.get("/v1/artifacts/:shortId/state/:key", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const key = c.req.param("key")
    if (!isSharedStateKey(key)) return fail(c, 400, "invalid shared-state key")
    const actor = await actingUser(c)
    return c.json(publicState(await meta.getSharedState(artifact.id, key), actor?.id ?? null))
  })

  app.get("/v1/artifacts/:shortId/state/:key/activity", async (c) => {
    const artifact = await requireArtifact(c, "comment", { split: true })
    if (artifact instanceof Response) return artifact
    const key = c.req.param("key")
    if (!isSharedStateKey(key)) return fail(c, 400, "invalid shared-state key")
    const rows = await meta.listSharedStateActivity(artifact.id, key, SHARED_STATE_ACTIVITY_LIMIT)
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
    if (!isSharedStateKey(key)) return fail(c, 400, "invalid shared-state key")
    const body = await readJson(c, Mutation)
    if (body instanceof Response) return body
    if (!commenterMutation(body) && !(await authorize(c, "publish", artifact)))
      return fail(c, 403, "changing shared-state fields requires edit access")
    const rateLimited = await limited(c, commentLimiter)
    if (rateLimited) return rateLimited
    const actor = (await actingUser(c)) ?? { id: "system", name: "automation" }
    const stateId = newId("state")
    const itemId = body.op === "update" ? body.id : newId("item")

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      let current = await meta.getSharedState(artifact.id, key)
      if (!current && (await meta.countSharedStateKeys(artifact.id)) >= SHARED_STATE_MAX_KEYS) {
        // A same-key create may have won between the first read and the count. It
        // should become an ordinary CAS update, not a false capacity rejection.
        current = await meta.getSharedState(artifact.id, key)
        if (!current)
          return fail(
            c,
            413,
            `shared state is limited to ${SHARED_STATE_MAX_KEYS} keys per artifact`,
          )
      }
      let parsed: unknown
      try {
        parsed = current ? JSON.parse(current.json) : body.initial
      } catch {
        return fail(c, 500, "stored shared state is invalid")
      }
      const items = collection(parsed, !current, !!current)
      if (typeof items === "string") return fail(c, 400, items)
      const changed = apply(items, body, itemId, actor.id)
      if (typeof changed === "string")
        return fail(c, changed === "item not found" ? 404 : 400, changed)
      if (!changed.changed) {
        if (!current) return c.json({ value: null, version: 0, mine: {} })
        return c.json(publicCollection(changed.value, current.version, actor.id))
      }
      const json = JSON.stringify(changed.value)
      if (new TextEncoder().encode(json).byteLength > SHARED_STATE_MAX_BYTES)
        return fail(c, 413, `shared state is limited to ${SHARED_STATE_MAX_BYTES / 1024} KB`)
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
      const response = publicState(saved, actor.id)
      bus.publish(artifact.id, {
        type: "artifact.state.updated",
        key,
        ...publicState(saved, null),
      })
      return c.json(response)
    }
    return fail(c, 409, "shared state changed; try again")
  })

  return app
}
