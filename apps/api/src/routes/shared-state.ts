import {
  artifactCollection,
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

const CAS_ATTEMPTS = 8
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

const collection = (value: unknown, mintMissingIds: boolean, stored = false): Item[] | string => {
  const result = artifactCollection.read(value, {
    mintId: mintMissingIds ? () => newId("item") : undefined,
    stored,
  })
  return "error" in result ? result.error : result
}

const publicCollection = (items: Item[], version: number, actorId: string | null) => {
  const result = artifactCollection.snapshot(items, version, actorId)
  return { value: result.items, version: result.version, mine: result.mine }
}

const publicState = (row: { json: string; version: number } | null, actorId: string | null) => {
  if (!row) return { value: null, version: 0, mine: {} }
  const parsed = collection(JSON.parse(row.json), false, true)
  if (typeof parsed === "string") throw new Error(parsed)
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
      const changed = artifactCollection.apply(items, coreMutation(body), actor.id, itemId)
      if ("error" in changed) {
        const message =
          changed.code === "owned"
            ? "actor-scoped items must be changed with set_mine"
            : changed.error
        return fail(
          c,
          changed.code === "missing" ? 404 : changed.code === "bytes" ? 413 : 400,
          message,
        )
      }
      if (!changed.changed) {
        if (!current) return c.json({ value: null, version: 0, mine: {} })
        return c.json(publicCollection(changed.items, current.version, actor.id))
      }
      const json = JSON.stringify(changed.items)
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
      const response = publicState(saved, actor.id)
      bus.publish(artifact.id, {
        type: "artifact.state.updated",
        key,
        ...publicState(saved, null),
      })
      // State correctness and its live broadcast are the hot path. The activity
      // ledger is best-effort: on Workers it rides waitUntil, avoiding an insert +
      // retention-delete before the response; on Node/tests background() awaits it.
      // A ledger outage must never make a client retry an already-applied mutation.
      await background(meta.appendSharedStateActivity(activity))
      return c.json(response)
    }
    return fail(c, 409, "shared state changed; try again")
  })

  return app
}
