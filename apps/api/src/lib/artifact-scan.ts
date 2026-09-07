import type { ArtifactRecord, MetaStore } from "@derive/core"

export const localArtifactScanActivity = async (args: {
  meta: MetaStore
  artifact: ArtifactRecord
  canRead: (artifact: ArtifactRecord) => Promise<boolean>
}) => {
  const direct = await args.meta.listArtifactScanEvents(args.artifact.id, args.artifact.org_id, 100)
  const readEvents = direct.filter((event) => event.action === "read")
  if (readEvents.length === 0)
    return {
      activity: direct.map((event) => ({
        id: event.id,
        artifact: { short_id: args.artifact.short_id, version: event.artifact_version },
        client: event.client,
        action: event.action,
        occurred_at: event.occurred_at,
      })),
      related: [],
    }
  const sessions = [
    ...new Map(
      readEvents.map((event) => [
        `${event.scanned_by}\0${event.opaque_session_id}`,
        { scannedBy: event.scanned_by, opaqueSessionId: event.opaque_session_id },
      ]),
    ).values(),
  ]
  const sessionEvents = await args.meta.listArtifactScanSessionEvents(
    args.artifact.org_id,
    sessions,
    500,
  )
  const readAt = new Map<string, number>()
  for (const event of readEvents) {
    const key = `${event.scanned_by}\0${event.opaque_session_id}`
    const at = Date.parse(event.occurred_at)
    readAt.set(key, Math.min(readAt.get(key) ?? at, at))
  }
  const candidates = sessionEvents.filter((event) => {
    if (event.action !== "published" || event.artifact_id === args.artifact.id) return false
    const at = readAt.get(`${event.scanned_by}\0${event.opaque_session_id}`)
    const publishedAt = Date.parse(event.occurred_at)
    return at !== undefined && publishedAt >= at && publishedAt - at <= 86_400_000
  })
  const relatedArtifacts = await args.meta.listArtifacts({
    ids: [...new Set(candidates.map((event) => event.artifact_id))],
    orgId: args.artifact.org_id,
    archived: "include",
    limit: Math.max(1, candidates.length),
  })
  const readable = new Map<string, ArtifactRecord>()
  for (const candidate of relatedArtifacts)
    if (await args.canRead(candidate)) readable.set(candidate.id, candidate)
  return {
    activity: direct.map((event) => ({
      id: event.id,
      artifact: { short_id: args.artifact.short_id, version: event.artifact_version },
      client: event.client,
      action: event.action,
      occurred_at: event.occurred_at,
    })),
    related: candidates
      .filter((event) => readable.has(event.artifact_id))
      .map((event) => {
        const related = readable.get(event.artifact_id)
        return {
          id: event.id,
          artifact: {
            short_id: related?.short_id ?? "",
            title: related?.title ?? related?.short_id ?? "Artifact",
            version: event.artifact_version,
          },
          client: event.client,
          action: "published" as const,
          occurred_at: event.occurred_at,
          reason: "This local agent session read this artifact before it published that version.",
        }
      }),
  }
}
