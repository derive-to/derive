import {
  type ArtifactRecord,
  applyEdits,
  type DocEdit,
  EditError,
  type VersionRecord,
} from "@derive/core"

/** A conflict with the artifact's actual state (wrong kind, or it moved past the
 *  version you read) — distinct from a malformed edit itself (bad JSON, 0/multi-match)
 *  so REST callers can map it to 409 instead of 400, matching the pre-consolidation
 *  status codes this helper's callers already committed to in their tests. */
export class EditConflictError extends EditError {}

export interface MaterializeEditsDeps {
  getVersion: (artifactId: string, n: number) => Promise<VersionRecord | null>
  sourceText: (v: Pick<VersionRecord, "blob_key" | "content_type">) => Promise<string | null>
}

export interface MaterializedEdits {
  content: string
  filename: string
}

/** A filename that round-trips `contentType` through the publish sniffer (which types
 *  by filename first). Any revision of an existing single-file artifact that doesn't
 *  carry an explicit filename must go through this — an `index.html` default silently
 *  re-types a markdown doc as HTML, and the browser then swallows its text as markup. */
export const preservingFilename = (contentType: string | null): string =>
  (contentType ?? "").split(";")[0]?.trim() === "text/markdown" ? "index.md" : "index.html"

/**
 * Turn an `edits` request into stored-revision bytes: validate the artifact can take
 * edits at all (single-file, `base_version` still fresh), load its current source,
 * apply the edits, and infer a content-type-preserving filename. Shared by the MCP
 * `publish` tool and the REST `/versions` + `/proposals` routes — the three surfaces
 * that offer `edits` — so the semantics and error text can't drift between them the
 * way they had (mismatched wording, and the MCP path silently skipping the size/
 * storage-quota check the REST routes both apply after calling this).
 *
 * Throws `EditConflictError` for a state conflict (409-shaped), plain `EditError` for
 * a malformed edit (400-shaped) — never a partial/silent failure. Callers translate
 * to their own error shape (MCP `err()`, REST `fail(c, status, …)`); check
 * `instanceof EditConflictError` BEFORE `instanceof EditError` (it's a subclass).
 */
export async function materializeEdits(
  deps: MaterializeEditsDeps,
  artifact: Pick<ArtifactRecord, "id" | "short_id" | "kind" | "current_version">,
  edits: DocEdit[],
  baseVersion: number | undefined,
): Promise<MaterializedEdits> {
  if (artifact.kind !== "file")
    throw new EditConflictError(
      `"${artifact.short_id}" is a multi-page bundle — \`edits\` applies to single-file artifacts; republish the changed page via \`files\` (+ \`merge\`).`,
    )
  if (baseVersion !== undefined && baseVersion !== artifact.current_version)
    throw new EditConflictError(
      `"${artifact.short_id}" moved to v${artifact.current_version} while you were editing (you read v${baseVersion}) — catch_up, re-read, then retry.`,
    )
  const cur = await deps.getVersion(artifact.id, artifact.current_version)
  const src = cur ? await deps.sourceText(cur) : null
  if (!cur || src === null)
    throw new EditError(`Couldn't load the current source of "${artifact.short_id}".`)
  const content = applyEdits(src, edits)
  // Keep the artifact's content type: the sniffer types by filename first, and the
  // default index.html would silently re-type an edited markdown doc as HTML.
  return { content, filename: preservingFilename(cur.content_type) }
}

/** Parse a `base_version` value from an untyped form field: `undefined` when absent,
 *  `EditError` (not silent NaN-passthrough) when present but not a clean integer —
 *  a malformed field must fail loudly, not coerce to NaN and reject every edit as
 *  "moved to vNaN" regardless of whether the artifact actually moved. */
export function parseBaseVersion(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1)
    throw new EditError(`base_version "${raw}" is not a valid version number.`)
  return n
}
