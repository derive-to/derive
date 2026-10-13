import {
  artifactCollection,
  commitCollection,
  isSharedStateKey,
  newId,
  SHARED_STATE_ACTIVITY_LIMIT,
  SHARED_STATE_MAX_KEYS,
  type SharedStateAction,
  type SharedStateMutation,
} from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

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

const coreMutation = (body: MutationBody) =>
  body.op === "set_mine" ? { ...body, op: "setMine" as const } : body

const publicCollection = (items: Item[], version: number, actorId: string | null) => {
  const result = artifactCollection.snapshot(items, version, actorId)
  return { value: result.items, version: result.version, mine: result.mine }
}

const publicState = (row: { json: string; version: number } | null, actorId: string | null) => {
  if (!row) return { value: null, version: 0, mine: {} }
  const parsed = artifactCollection.read(JSON.parse(row.json), { stored: true })
  if ("error" in parsed) throw new Error(parsed.error)
  return publicCollection(parsed, row.version, actorId)
}

// The host assigns COMMENT to counters and own slots. Field replacement requires PUBLISH.
const commenterMutation = (body: MutationBody): boolean =>
  artifactCollection.counter(coreMutation(body))

/** Persistent JSON collections for mini-app artifacts. Reads follow artifact
 * visibility. Adds, actor-scoped values, and atomic counter gestures reuse
 * COMMENT permission; arbitrary field replacement follows PUBLISH permission. */
export const sharedStateRoutes = (ctx: AppContext) => {
  const { meta, bus, background, requireArtifact, authorize, actingUser, limited, commentLimiter } =
    ctx
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

    const at = new Date().toISOString()
    const saved = await commitCollection(
      {
        read: async () => {
          const row = await meta.getSharedState(artifact.id, key)
          if (!row) return null
          let items: unknown
          try {
            items = JSON.parse(row.json)
          } catch {
            items = null
          }
          return { items, version: row.version }
        },
        countKeys: () => meta.countSharedStateKeys(artifact.id),
        put: async (items, expected) =>
          !!(await meta.putSharedState({
            id: stateId,
            artifact_id: artifact.id,
            key,
            json: JSON.stringify(items),
            expected_version: expected,
            updated_by_id: actor.id,
            updated_by_name: actor.name,
            updated_at: at,
          })),
      },
      {
        rules: artifactCollection,
        actorId: actor.id,
        mutation: coreMutation(body),
        initial: body.initial,
        mintId: () => newId("item"),
        itemId,
      },
    )
    if ("error" in saved) {
      if (saved.code === "keys")
        return fail(c, 413, `shared state is limited to ${SHARED_STATE_MAX_KEYS} keys per artifact`)
      if (saved.code === "race") return fail(c, 409, "shared state changed; try again")
      if (saved.code === "stored") return fail(c, 500, "stored shared state is invalid")
      const message =
        saved.code === "owned" ? "actor-scoped items must be changed with set_mine" : saved.error
      return fail(c, saved.code === "missing" ? 404 : saved.code === "bytes" ? 413 : 400, message)
    }
    if (!saved.changed)
      return c.json(
        saved.persisted
          ? publicCollection(saved.items, saved.version, actor.id)
          : { value: null, version: 0, mine: {} },
      )
    const activity = {
      id: newId("activity"),
      artifact_id: artifact.id,
      key,
      version: saved.version,
      action: body.op as SharedStateAction,
      item_id: saved.itemId,
      actor_id: actor.id,
      actor_name: actor.name,
      created_at: at,
    }
    bus.publish(artifact.id, {
      type: "artifact.state.updated",
      key,
      ...publicCollection(saved.items, saved.version, null),
    })
    // The ledger runs after commit. It cannot make a client retry a saved mutation.
    await background(meta.appendSharedStateActivity(activity))
    return c.json({
      ...publicCollection(saved.items, saved.version, actor.id),
      itemId: saved.itemId,
    })
  })

  return app
}
