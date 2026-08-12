import type { ArtifactRecord, MembershipRecord, MetaStore } from "@derive/core"
import { getTemplate } from "@derive-to/templates"
import { z } from "zod"
import { canReadTemplateLibrary } from "./template-library-access"

/** Trusted navigation metadata for an agent job that began in the template catalog. */
export const TemplateStartSchema = z.object({
  uri: z
    .string()
    .regex(
      /^(?:[0-9a-z]{6,12}|derive:\/\/(?:templates\/[a-z0-9-]+|template-libraries\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+))$/,
    ),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["artifact", "context"]),
})

export type TemplateStart = z.infer<typeof TemplateStartSchema>

type ResolveTemplateStartDeps = {
  meta: MetaStore
  userId: string
  workspaceId: string
  canReadArtifact: (artifact: ArtifactRecord) => Promise<boolean>
  sourceText: (content: { blob_key: string; content_type: string }) => Promise<string | null>
  membership: (orgId: string, userId: string) => Promise<MembershipRecord | null>
}

export type TemplateStartResolution =
  | { ok: true; value: TemplateStart }
  | { ok: false; reason: "unavailable" | "kind_mismatch" }

/**
 * Turn client navigation metadata into a canonical, reachable reference before
 * a model turn exists. Titles and kinds are derived from the source of truth;
 * syntactically plausible but missing/private/broken references fail closed.
 */
export async function resolveTemplateStart(
  input: TemplateStart,
  deps: ResolveTemplateStartDeps,
): Promise<TemplateStartResolution> {
  const builtInPrefix = "derive://templates/"
  if (input.uri.startsWith(builtInPrefix)) {
    const template = getTemplate(input.uri.slice(builtInPrefix.length))
    if (!template) return { ok: false, reason: "unavailable" }
    if (template.kind !== input.kind) return { ok: false, reason: "kind_mismatch" }
    return {
      ok: true,
      value: { uri: input.uri, title: template.title, kind: template.kind },
    }
  }

  const libraryMatch = input.uri.match(
    /^derive:\/\/template-libraries\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/,
  )
  if (libraryMatch) {
    const libraryId = libraryMatch[1] ?? ""
    const entryId = libraryMatch[2] ?? ""
    const [library, entry] = await Promise.all([
      deps.meta.getTemplateLibrary(libraryId),
      deps.meta.getTemplateLibraryEntry(entryId),
    ])
    if (!library || !entry || entry.library_id !== library.id)
      return { ok: false, reason: "unavailable" }
    if (library.scope !== "public" && library.org_id !== deps.workspaceId)
      return { ok: false, reason: "unavailable" }
    const member = await deps.membership(library.org_id, deps.userId)
    if (
      !canReadTemplateLibrary(library, {
        ownerId: deps.userId,
        workspaceReachable: !!member,
        isMember: !!member,
      })
    )
      return { ok: false, reason: "unavailable" }
    if (entry.kind !== input.kind) return { ok: false, reason: "kind_mismatch" }
    if (
      (await deps.sourceText({
        blob_key: entry.source_blob_key,
        content_type: entry.source_content_type,
      })) === null
    )
      return { ok: false, reason: "unavailable" }
    return {
      ok: true,
      value: { uri: input.uri, title: entry.title, kind: entry.kind },
    }
  }

  const artifact = await deps.meta.getByShortId(input.uri)
  if (!artifact || artifact.org_id !== deps.workspaceId || !(await deps.canReadArtifact(artifact)))
    return { ok: false, reason: "unavailable" }
  if (input.kind !== "artifact") return { ok: false, reason: "kind_mismatch" }
  const version = await deps.meta.getVersion(artifact.id, artifact.current_version)
  if (!version || (await deps.sourceText(version)) === null)
    return { ok: false, reason: "unavailable" }
  return {
    ok: true,
    value: {
      uri: artifact.short_id,
      title: artifact.title || "Untitled artifact",
      kind: "artifact",
    },
  }
}
