import {
  applyDynamicPatch,
  DYNAMIC_MAX_BYTES,
  DYNAMIC_MAX_COLUMNS,
  DYNAMIC_MAX_PATCH_OPS,
  DYNAMIC_MAX_ROWS,
  DYNAMIC_MAX_SLOTS,
  DYNAMIC_REVISION_LIMIT,
  type DynamicSlotRecord,
  type DynamicValue,
  dynamicValueBytes,
  hasArtifactStanding,
  isDynamicName,
  newId,
  renderDynamicFigureInner,
  renderDynamicTableInner,
  validateDynamicValue,
} from "@derive/core"
import { z } from "@hono/zod-openapi"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { AGENT_WRITES_OFF, agentWritesOff } from "../lib/agent-writes"
import { fail, readJson } from "../lib/http"
import { log } from "../log"

const CAS_ATTEMPTS = 8

// Wire shapes are structural here; the semantic rules (unique column keys, the key
// column exists, cells only reference declared columns, figure URL grammar) live in
// @derive/core validateDynamicValue so the route, the seeding pass and the renderers
// can never disagree about what a valid value is.
const Cell = z.union([z.string().max(4096), z.number().finite(), z.null()])
const Column = z.object({
  key: z.string().min(1).max(64),
  label: z.string().max(2000).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
})
const Table = z.object({
  columns: z.array(Column).min(1).max(DYNAMIC_MAX_COLUMNS),
  rows: z.array(z.record(z.string(), Cell)).max(DYNAMIC_MAX_ROWS),
  key: z.string().min(1).max(64).optional(),
})
const Figure = z.object({
  url: z.string().max(2048).nullable(),
  asset: z.string().max(80).optional(),
  caption: z.string().max(2000).optional(),
  alt: z.string().max(2000).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
})
const Meta = {
  /** Compare-and-swap guard. Omitted: the write retries against the live revision.
   *  Given and stale: 409 at once, because the caller asked to be told. */
  expected_revision: z.number().int().min(0).optional(),
  note: z.string().trim().max(200).optional(),
}
const Put = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("table"), table: Table, ...Meta }),
  z.object({ kind: z.literal("figure"), figure: Figure, ...Meta }),
])
const RowAddress = z.union([z.string().max(4096), z.number().int().min(0)])
const Patch = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("table"),
    cells: z
      .array(z.object({ row: RowAddress, col: z.string().min(1).max(64), value: Cell }))
      .max(DYNAMIC_MAX_PATCH_OPS)
      .optional(),
    delete_rows: z.array(RowAddress).max(DYNAMIC_MAX_PATCH_OPS).optional(),
    append_rows: z.array(z.record(z.string(), Cell)).max(DYNAMIC_MAX_PATCH_OPS).optional(),
    ...Meta,
  }),
  z.object({ kind: z.literal("figure"), figure: Figure.partial(), ...Meta }),
])

const parseStored = (row: DynamicSlotRecord): DynamicValue => {
  const value = validateDynamicValue(JSON.parse(row.json))
  if (typeof value === "string") throw new Error(`stored dynamic slot is invalid: ${value}`)
  return value
}

const fragmentOf = (value: DynamicValue): string =>
  value.kind === "table"
    ? renderDynamicTableInner(value.table)
    : renderDynamicFigureInner(value.figure)

const slotJson = (row: DynamicSlotRecord, withHtml = false) => {
  const value = parseStored(row)
  return {
    name: row.name,
    kind: row.kind,
    version: row.n,
    revision: row.revision,
    updated_at: row.updated_at,
    updated_by: { id: row.updated_by_id, name: row.updated_by_name },
    value,
    ...(withHtml ? { html: fragmentOf(value) } : {}),
  }
}

/**
 * Dynamic tables and figures: per-version data a document declares and Derive owns, so
 * an agent can land a result without minting a version (see @derive/core
 * dynamic-data.ts for the model). Reads follow artifact visibility, with a non-current
 * version gated the way version history is everywhere else. Writes are content, so they
 * follow PUBLISH permission exactly as a republish would: a link that grants edit can
 * write a cell because it could already republish the whole table; a commenter cannot,
 * because a cell is not a reaction. Every write targets the CURRENT version: older
 * versions keep the data they had, by design.
 */
export const dynamicDataRoutes = (ctx: AppContext) => {
  const {
    meta,
    bus,
    background,
    requireArtifact,
    actingUser,
    actorFor,
    agentFor,
    limited,
    dynamicLimiter,
  } = ctx
  const app = new Hono()

  // `?v=` reads any version the caller may see; writes never take it.
  const versionFor = async (
    c: Context,
    artifact: NonNullable<Awaited<ReturnType<typeof meta.getByShortId>>>,
  ): Promise<number | Response> => {
    const raw = c.req.query("v")
    if (raw === undefined || raw === "") return artifact.current_version
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) return fail(c, 400, "v must be a positive integer")
    // Private history stays private: the same rule the raw routes apply, and the same
    // 404 shape, so a stranger learns nothing about how many versions exist.
    if (
      n !== artifact.current_version &&
      !artifact.public_history &&
      !hasArtifactStanding(await actorFor(c, artifact), artifact.workspace_access)
    )
      return fail(c, 404, "not found")
    return n
  }

  const slotName = (c: Context): string | Response => {
    const name = c.req.param("name") ?? ""
    return isDynamicName(name) ? name : fail(c, 400, "invalid dynamic slot name")
  }

  app.get("/v1/artifacts/:shortId/dynamic", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const n = await versionFor(c, artifact)
    if (n instanceof Response) return n
    const rows = await meta.listDynamicSlots(artifact.id, n)
    return c.json({ version: n, slots: rows.map((row) => slotJson(row)) })
  })

  app.get("/v1/artifacts/:shortId/dynamic/:name", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const name = slotName(c)
    if (name instanceof Response) return name
    const n = await versionFor(c, artifact)
    if (n instanceof Response) return n
    const row = await meta.getDynamicSlot(artifact.id, n, name)
    if (!row) return fail(c, 404, `no dynamic slot "${name}" in version ${n}`)
    log.info("dynamic_read", { name, kind: row.kind, surface: "api" })
    return c.json(slotJson(row, c.req.query("format") === "html"))
  })

  app.get("/v1/artifacts/:shortId/dynamic/:name/history", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const name = slotName(c)
    if (name instanceof Response) return name
    const n = await versionFor(c, artifact)
    if (n instanceof Response) return n
    const withValues = ["1", "true"].includes(c.req.query("values") ?? "")
    const rows = await meta.listDynamicRevisions(artifact.id, n, name, DYNAMIC_REVISION_LIMIT + 1)
    return c.json({
      version: n,
      revisions: rows.map((r) => ({
        revision: r.revision,
        actor: { id: r.actor_id, name: r.actor_name },
        note: r.note,
        bytes: r.size_bytes,
        at: r.created_at,
        ...(withValues ? { value: JSON.parse(r.json) as unknown } : {}),
      })),
    })
  })

  // The shared write gate: publish access on the artifact, the workspace's agent-write
  // switch (an agent updating a cell is still an agent writing content; the switch that
  // stops its publishes stops this too, and fails closed), then the per-actor lane.
  const writable = async (c: Context) => {
    const artifact = await requireArtifact(c, "publish", { split: true })
    if (artifact instanceof Response) return artifact
    const name = slotName(c)
    if (name instanceof Response) return name
    if ((await agentFor(c)) && (await agentWritesOff(meta, artifact.org_id)))
      return fail(c, 403, AGENT_WRITES_OFF)
    const rateLimited = await limited(c, dynamicLimiter)
    if (rateLimited) return rateLimited
    const actor = (await actingUser(c)) ?? { id: "system", name: "automation" }
    return { artifact, name, n: artifact.current_version, actor }
  }

  type Writable = Exclude<Awaited<ReturnType<typeof writable>>, Response>

  const settle = async (
    c: Context,
    w: Writable,
    row: DynamicSlotRecord,
    note: string | undefined,
  ) => {
    // The value and its live broadcast are the hot path; the revision ledger is
    // best-effort behind background() (waitUntil on Workers, awaited on Node), because
    // a ledger hiccup must never make a client retry a write that already landed.
    bus.publish(w.artifact.id, {
      type: "artifact.dynamic.updated",
      name: row.name,
      kind: row.kind,
      n: row.n,
      revision: row.revision,
    })
    await background(
      meta.appendDynamicRevision({
        id: newId("dynrev"),
        artifact_id: w.artifact.id,
        n: row.n,
        name: row.name,
        revision: row.revision,
        json: row.json,
        size_bytes: row.size_bytes,
        actor_id: w.actor.id,
        actor_name: w.actor.name,
        note: note?.trim() ? note.trim() : null,
        created_at: row.updated_at,
      }),
    )
    log.info("dynamic_write", { name: row.name, kind: row.kind, n: row.n, revision: row.revision })
    return c.json(slotJson(row))
  }

  const tooBig = (c: Context) =>
    fail(c, 413, `a dynamic slot is limited to ${DYNAMIC_MAX_BYTES / 1024} KB`)

  app.put("/v1/artifacts/:shortId/dynamic/:name", async (c) => {
    const w = await writable(c)
    if (w instanceof Response) return w
    const body = await readJson(c, Put)
    if (body instanceof Response) return body
    const value = validateDynamicValue(
      body.kind === "table"
        ? { kind: "table", table: body.table }
        : { kind: "figure", figure: body.figure },
    )
    if (typeof value === "string") return fail(c, 400, value)
    const json = JSON.stringify(value)
    const size = dynamicValueBytes(value)
    if (size > DYNAMIC_MAX_BYTES) return tooBig(c)

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await meta.getDynamicSlot(w.artifact.id, w.n, w.name)
      const at = new Date().toISOString()
      if (!current) {
        if (body.expected_revision !== undefined && body.expected_revision !== 0)
          return fail(c, 409, `no dynamic slot "${w.name}" yet; expected_revision must be 0`)
        if ((await meta.countDynamicSlots(w.artifact.id, w.n)) >= DYNAMIC_MAX_SLOTS)
          return fail(c, 413, `a version is limited to ${DYNAMIC_MAX_SLOTS} dynamic slots`)
        const inserted = await meta.insertDynamicSlot({
          id: newId("dyn"),
          artifact_id: w.artifact.id,
          n: w.n,
          name: w.name,
          kind: value.kind,
          json,
          size_bytes: size,
          revision: 1,
          updated_by_id: w.actor.id,
          updated_by_name: w.actor.name,
          updated_at: at,
        })
        // A same-name create won between the read and the insert (or the seeding pass
        // landed): it is an ordinary CAS update now, so read again.
        if (!inserted) continue
        return settle(c, w, inserted, body.note)
      }
      // A binding's kind is the document's decision; changing it is a delete + put.
      if (current.kind !== value.kind)
        return fail(c, 409, `dynamic slot "${w.name}" is a ${current.kind}, not a ${value.kind}`)
      if (body.expected_revision !== undefined && body.expected_revision !== current.revision)
        return fail(c, 409, `dynamic slot "${w.name}" is at revision ${current.revision}`)
      const updated = await meta.updateDynamicSlot({
        artifact_id: w.artifact.id,
        n: w.n,
        name: w.name,
        json,
        size_bytes: size,
        expected_revision: current.revision,
        updated_by_id: w.actor.id,
        updated_by_name: w.actor.name,
        updated_at: at,
      })
      if (!updated) continue
      return settle(c, w, updated, body.note)
    }
    return fail(c, 409, "dynamic slot changed; try again")
  })

  app.patch("/v1/artifacts/:shortId/dynamic/:name", async (c) => {
    const w = await writable(c)
    if (w instanceof Response) return w
    const body = await readJson(c, Patch)
    if (body instanceof Response) return body
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const current = await meta.getDynamicSlot(w.artifact.id, w.n, w.name)
      if (!current)
        return fail(c, 404, `no dynamic slot "${w.name}" in version ${w.n}; PUT creates one`)
      if (body.expected_revision !== undefined && body.expected_revision !== current.revision)
        return fail(c, 409, `dynamic slot "${w.name}" is at revision ${current.revision}`)
      const next = applyDynamicPatch(parseStored(current), body)
      if (typeof next === "string") return fail(c, 400, next)
      const json = JSON.stringify(next)
      const size = dynamicValueBytes(next)
      if (size > DYNAMIC_MAX_BYTES) return tooBig(c)
      const updated = await meta.updateDynamicSlot({
        artifact_id: w.artifact.id,
        n: w.n,
        name: w.name,
        json,
        size_bytes: size,
        expected_revision: current.revision,
        updated_by_id: w.actor.id,
        updated_by_name: w.actor.name,
        updated_at: new Date().toISOString(),
      })
      if (!updated) continue
      return settle(c, w, updated, body.note)
    }
    return fail(c, 409, "dynamic slot changed; try again")
  })

  app.delete("/v1/artifacts/:shortId/dynamic/:name", async (c) => {
    const w = await writable(c)
    if (w instanceof Response) return w
    const current = await meta.getDynamicSlot(w.artifact.id, w.n, w.name)
    if (!current) return fail(c, 404, `no dynamic slot "${w.name}" in version ${w.n}`)
    await meta.deleteDynamicSlot(w.artifact.id, w.n, w.name)
    bus.publish(w.artifact.id, {
      type: "artifact.dynamic.updated",
      name: w.name,
      kind: current.kind,
      n: w.n,
      revision: null,
    })
    log.info("dynamic_delete", { name: w.name, kind: current.kind, n: w.n })
    return c.json({ ok: true })
  })

  return app
}
