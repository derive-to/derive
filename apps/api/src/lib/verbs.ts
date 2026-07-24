import { type MetaStore, newId, type VerbRecord } from "@derive/core"
import { overBudget } from "./budget"

export type InvokeOutcome =
  | { ok: true; runId: string; status: string }
  | { ok: false; code: 400 | 403 | 429; error: string }

/** Bound connection ids off a verb's JSON array, defensively. */
export const verbConnectionIds = (v: VerbRecord): string[] => {
  if (!v.connection_ids) return []
  try {
    const a = JSON.parse(v.connection_ids)
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/**
 * Validate invoker params against a verb's loose schema. Params are DATA, never instruction:
 * only primitives (string/number/boolean), bounded length, and any schema-listed required key
 * must be present. Returns an error string, or null when valid.
 */
export const validateParams = (schema: string | null, params: unknown): string | null => {
  if (params === undefined || params === null) return null
  if (typeof params !== "object" || Array.isArray(params)) return "params must be an object"
  for (const value of Object.values(params as Record<string, unknown>)) {
    const t = typeof value
    if (t !== "string" && t !== "number" && t !== "boolean")
      return "params values must be primitives (string/number/boolean)"
    if (t === "string" && (value as string).length > 2000) return "param string too long"
  }
  if (schema) {
    try {
      const s = JSON.parse(schema) as { required?: string[] }
      const p = params as Record<string, unknown>
      for (const k of s.required ?? []) if (!(k in p)) return `missing required param: ${k}`
    } catch {
      // A malformed schema doesn't block invocation — the params still had to be primitives.
    }
  }
  return null
}

/**
 * Enqueue a run for a verb invocation. The instruction is the owner-authored template; invoker
 * params ride in `meta.params` as fenced DATA (the executor never splices them into the
 * instruction). The run bills to the verb OWNER (created_by), records the INVOKER, carries the
 * owner's bound connections (the least-privilege tool set), and lands as a proposal or a live
 * publish per the verb's gate. Killswitch/enabled/budget guard at enqueue. `actingUserId` is
 * who is allowed to invoke (audience); `invoker` labels the run in the ledger.
 */
export const invokeVerb = async (
  meta: MetaStore,
  verb: VerbRecord,
  actingUserId: string | null,
  invoker: string,
  params: unknown,
): Promise<InvokeOutcome> => {
  if (verb.enabled !== 1) return { ok: false, code: 400, error: "verb is disabled" }
  // Audience: an owner-only verb is invokable only by its owner.
  if (verb.audience === "owner" && actingUserId !== verb.created_by)
    return { ok: false, code: 403, error: "forbidden" }
  const perr = validateParams(verb.params_schema, params)
  if (perr) return { ok: false, code: 400, error: perr }
  // Budget bills to the verb owner (invariant 2).
  if (await overBudget(meta, verb.org_id, verb.created_by))
    return { ok: false, code: 429, error: "monthly run budget reached" }
  const mode = verb.gate === "direct" ? "publish" : "propose"
  const rec = await meta.createRun({
    id: newId("run"),
    org_id: verb.org_id,
    automation_id: null,
    agent_id: verb.agent_id,
    reason: `verb:${verb.id}:${invoker}`,
    scheduled_for: new Date().toISOString(),
    meta: JSON.stringify({
      verb: verb.name,
      instruction: verb.instruction_template,
      params: params ?? {},
      invoker,
      owner: verb.created_by,
      targets: [{ kind: "artifact", id: verb.artifact_id, mode }],
      connection_ids: verbConnectionIds(verb),
      provenance: { verb_id: verb.id, depth: 0 },
    }),
  })
  return { ok: true, runId: rec.id, status: rec.status }
}
