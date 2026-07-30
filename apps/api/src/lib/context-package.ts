// A context is a PACKAGE, not only a session partner: a manifest, the skills that
// manifest's frontmatter pins, and its bound sources. `use` gives that package work;
// `read` LOADS it. Both reach this one assembly, so what a caller loads is what a run
// materializes — the two modes cannot drift into describing different things.
//
// PROGRESSIVE OPENING is the whole shape. The manifest comes back INLINE, because it is
// the small always-read layer: the thing that orients you. Skills and sources come back
// as POINTERS you follow only when a task needs them. A package that inlined its corpus
// would spend the caller's orientation budget on orientation, which is exactly the
// failure this avoids — and the reason `checkpoint` states the same rule for itself
// ("an index a cold session follows, not a container").
import type { ArtifactRecord, ContextRecord, MetaStore } from "@derive/core"
import { parseConnectionIds } from "./broker"
import { parseManifestSkillPins, stalePins } from "./manifest-pins"

/** How much manifest text loads inline. A manifest is meant to be the small layer; one
 *  that runs past this is over budget by its own design, so the read clips and says so
 *  rather than quietly blowing the caller's context. */
export const MANIFEST_INLINE_MAX = 24_000

export interface PackagedSkill {
  short_id: string
  title: string | null
  /** The version the manifest pins; null = unpinned (a run fetches current). */
  pinned_version: number | null
  current_version: number | null
  /** The pin trails the artifact — a run executes the pinned version, not the latest. */
  stale: boolean
}

export interface ContextPackage {
  context: {
    id: string
    name: string
    ask_policy: ContextRecord["ask_policy"]
    /** Whether a RUNNER is polling. Only affects `use`; reading never needs one. */
    online: boolean
  }
  manifest: {
    short_id: string
    title: string | null
    version: number
    content: string
    clipped?: true
  } | null
  skills: PackagedSkill[]
  sources: string[]
}

/** Assemble the package a caller loads. `sourceText` is the store's version-body reader,
 *  passed in so this module stays free of the MCP tool context and is directly testable. */
export const assembleContextPackage = async (
  meta: MetaStore,
  x: ContextRecord,
  manifestArtifact: ArtifactRecord | null,
  sourceText: (
    v: NonNullable<Awaited<ReturnType<MetaStore["getVersion"]>>>,
  ) => Promise<string | null>,
  online: boolean,
): Promise<ContextPackage> => {
  const base: ContextPackage = {
    context: { id: x.id, name: x.name, ask_policy: x.ask_policy, online },
    manifest: null,
    skills: [],
    sources: parseConnectionIds(x.connection_ids),
  }
  if (!manifestArtifact) return base

  // Best-effort, mirroring the runner: a manifest that will not load must not turn a
  // read into an error — the identity and the pointers are still worth having, and a
  // caller can tell the difference because `manifest` comes back null.
  const v = await meta
    .getVersion(manifestArtifact.id, manifestArtifact.current_version)
    .catch(() => null)
  const raw = v ? ((await sourceText(v).catch(() => null)) ?? "") : ""
  if (!raw) return base

  const clipped = raw.length > MANIFEST_INLINE_MAX
  base.manifest = {
    short_id: manifestArtifact.short_id,
    title: manifestArtifact.title,
    version: manifestArtifact.current_version,
    content: clipped ? raw.slice(0, MANIFEST_INLINE_MAX) : raw,
    ...(clipped ? { clipped: true as const } : {}),
  }

  // The SAME pin parsing the runner uses (manifest-pins), so the skills a reader is told
  // about are the skills a run would materialize — including the staleness, which is the
  // one thing a pinned-skill model gets silently wrong.
  const pins = parseManifestSkillPins(raw)
  if (!pins.length) return base
  const stale = new Set((await stalePins(meta, pins)).map((p) => p.short_id))
  base.skills = await Promise.all(
    pins.map(async (p) => {
      const a = await meta.getByShortId(p.id).catch(() => null)
      return {
        short_id: p.id,
        title: a?.title ?? null,
        pinned_version: p.version,
        current_version: a?.current_version ?? null,
        stale: stale.has(p.id),
      }
    }),
  )
  return base
}
