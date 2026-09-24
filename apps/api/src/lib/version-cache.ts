import type { ArtifactRecord, VersionRecord } from "@derive/core"

/**
 * Attended inline saves are a working burst, not a trail of meaningful checkpoints.
 * Five minutes matches the product rule: a pause creates the next durable version.
 */
export const INLINE_EDIT_COALESCE_MS = 5 * 60_000

/** Slack past the window before a version's bytes count as final. A coalescing save
 *  checks the window when it starts and commits only after materializing the edit, so
 *  a read at the very edge of the window must not pin bytes that save is replacing. */
const COALESCE_SETTLE_MS = 60_000

/**
 * Whether a later inline save may still REPLACE this version's bytes in place: same
 * version number, same URL, new blob. Such a version must not be served from any
 * cache without revalidating, or reopening it shows the pre-save page.
 *
 * Deliberately looser than the publish-time check in routes/artifacts.ts (it ignores
 * who is asking and whether feedback exists): over-reporting costs one revalidation
 * inside the edit window, under-reporting pins stale bytes behind an immutable URL.
 * An unparseable or future timestamp counts as still mutable for the same reason.
 */
export const mayStillCoalesce = (
  artifact: Pick<ArtifactRecord, "current_version">,
  version: Pick<VersionRecord, "n" | "source" | "name" | "created_at">,
  now = Date.now(),
): boolean => {
  if (version.n !== artifact.current_version || version.source !== "web" || version.name)
    return false
  const age = now - Date.parse(version.created_at)
  return !(age > INLINE_EDIT_COALESCE_MS + COALESCE_SETTLE_MS)
}

/** Cache-Control for bytes the same URL may change: always revalidate. `private`
 *  keeps a gated artifact out of shared caches. */
export const mutableCacheFor = (a: Pick<ArtifactRecord, "link_role" | "password_hash">): string =>
  a.link_role !== "none" && !a.password_hash ? "no-cache" : "private, no-cache"

/**
 * A version's Cache-Control: `access` (the access model's policy for settled bytes)
 * unless this URL can mean new bytes a moment from now — a current-version `alias`, or
 * a version an inline save may still replace in place — then revalidate. no-store
 * (gated cookie route, password lock, draft) is already stricter and stays.
 */
export const versionCacheControl = (
  artifact: Pick<ArtifactRecord, "current_version" | "link_role" | "password_hash">,
  version: Pick<VersionRecord, "n" | "source" | "name" | "created_at"> | null | undefined,
  access: string,
  alias = false,
): string =>
  !access.includes("no-store") && (alias || (!!version && mayStillCoalesce(artifact, version)))
    ? mutableCacheFor(artifact)
    : access
