// The selector: ONE generic way to point at a set of artifacts, used wherever the
// platform needs an address — an automation's targets today, a context's sources next,
// event scopes later. The same house pattern as AutomationTrigger: a tiny JSON
// discriminated union, extensible by adding a kind, never by adding a table.
//
// Read side (sources): artifact = this doc; collection = its current members, live;
// tag = every doc carrying it, live. Write side (targets): artifact = revise it;
// collection = file new work into it; tag = stamp whatever the run writes.
// A bare string is accepted everywhere a selector is and normalizes to {kind:"artifact"}
// — the ergonomic shorthand, and what keeps every pre-selector refs array valid.

export type Selector =
  | { kind: "artifact"; id: string }
  | { kind: "collection"; id: string }
  | { kind: "tag"; tag: string }

/** Canonicalize one selector-ish value. Bare string → artifact shorthand. Returns
 *  null for anything malformed rather than throwing — callers decide strictness. */
export const normalizeSelector = (v: unknown): Selector | null => {
  if (typeof v === "string") return v.trim() === "" ? null : { kind: "artifact", id: v.trim() }
  if (typeof v !== "object" || v === null) return null
  const o = v as Record<string, unknown>
  if (o.kind === "artifact" && typeof o.id === "string" && o.id.trim() !== "")
    return { kind: "artifact", id: o.id.trim() }
  if (o.kind === "collection" && typeof o.id === "string" && o.id.trim() !== "")
    return { kind: "collection", id: o.id.trim() }
  if (o.kind === "tag" && typeof o.tag === "string" && o.tag.trim() !== "")
    return { kind: "tag", tag: o.tag.trim() }
  return null
}

/** Canonicalize a list, dropping malformed entries and deduping by identity. */
export const normalizeSelectors = (v: unknown): Selector[] => {
  if (!Array.isArray(v)) return []
  const out: Selector[] = []
  const seen = new Set<string>()
  for (const item of v) {
    const s = normalizeSelector(item)
    if (!s) continue
    const key = s.kind === "tag" ? `tag:${s.tag}` : `${s.kind}:${s.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** The artifact short ids a target list names directly (revision destinations). */
export const artifactTargets = (sel: Selector[]): string[] =>
  sel
    .filter((s): s is Extract<Selector, { kind: "artifact" }> => s.kind === "artifact")
    .map((s) => s.id)

/** The tag labels in a target list — stamped on every write the run makes. */
export const tagTargets = (sel: Selector[]): string[] =>
  sel.filter((s): s is Extract<Selector, { kind: "tag" }> => s.kind === "tag").map((s) => s.tag)
