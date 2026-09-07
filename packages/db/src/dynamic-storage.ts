import type { DynamicKind, DynamicSlotRecord, SharedStateRecord } from "@derive/core"

export const DYNAMIC_STATE_PREFIX = "dynamic."

export const dynamicStatePrefix = (n: number): string => `${DYNAMIC_STATE_PREFIX}${n}.`

export const dynamicStateKey = (n: number, name: string): string =>
  `${dynamicStatePrefix(n)}${name}`

export const dynamicRecord = (
  row: SharedStateRecord,
  n: number,
  name: string,
): DynamicSlotRecord => {
  let kind: DynamicKind = "table"
  try {
    if ((JSON.parse(row.json) as { kind?: unknown }).kind === "figure") kind = "figure"
  } catch {
    // The API reports invalid stored JSON. The kind is immaterial in that response.
  }
  return {
    id: row.id,
    artifact_id: row.artifact_id,
    n,
    name,
    kind,
    json: row.json,
    size_bytes: new TextEncoder().encode(row.json).byteLength,
    revision: row.version,
    updated_by_id: row.updated_by_id,
    updated_by_name: row.updated_by_name,
    updated_at: row.updated_at,
  }
}
