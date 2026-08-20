import type { BlobStore, MetaStore, VersionRecord } from "@derive/core"
import { sniffImageType } from "./image"

/** The three stored screenshot variants. A growth point in the same way `stage.target`
 *  was, so callers check it server-side rather than pinning an enum a cached client
 *  would refuse. */
export const RENDER_VARIANTS = ["top", "full", "marked"] as const
export type RenderVariant = (typeof RENDER_VARIANTS)[number]

/** Longest a caller may block for a screenshot, in seconds. Matches `read`'s cap: a
 *  render lands a few seconds after a publish, and anything past this is a hung browser
 *  rather than a slow one. */
export const RENDER_WAIT_MAX = 30

/**
 * What to say when this instance renders no screenshots at all — shared by `read` and
 * `publish` so the two cannot drift into describing different instances.
 *
 * `deps.renderPreviews` is the tier-agnostic answer to "will a screenshot EVER exist":
 * node.ts sets it from DERIVE_PREVIEWS, worker.ts from the BROWSER binding, and
 * context.ts's `notifyRender` never enqueues a job when it is false. So a not-ready
 * variant on such an instance is TERMINAL, not slow — and the ordinary "try again
 * shortly, or pass `wait`" ending is advice that cannot succeed no matter how many times
 * it is taken. Measured in an agent trace: four reads, each blocking the full 30s, before
 * the caller gave up on a screenshot that was never queued.
 */
export const rendersOff = (what: string, url: string): string =>
  `${what} will never arrive: this instance does not render screenshots. Open ${url} to see the page instead. ` +
  `An operator turns them on with DERIVE_PREVIEWS=true (Node tier) or a BROWSER binding (Workers tier).`

/**
 * A variant's three columns. THE one place that maps a variant name onto storage: three
 * variants times three columns is nine names to get right, and a second copy of that
 * mapping is how `read` and `publish` would quietly come to disagree about which
 * screenshot they are talking about.
 */
export const pickVariant = (
  v: VersionRecord,
  variant: RenderVariant,
): { key: string | null; status: string | null; error: string | null } =>
  variant === "top"
    ? { key: v.preview_key, status: v.preview_status, error: v.preview_error }
    : variant === "full"
      ? { key: v.preview_full_key, status: v.preview_full_status, error: v.preview_full_error }
      : {
          key: v.preview_marked_key,
          status: v.preview_marked_status,
          error: v.preview_marked_error,
        }

/**
 * Wait for a version's screenshot and return its bytes, or null if it isn't ready in
 * time (or failed). Shared so `publish` can hand the shot back with the publish itself
 * and `read` can fetch one later, without two copies of the poll drifting apart.
 *
 * Bounded and honest: polls once a second up to `waitSecs` (capped), returns null the
 * moment the variant is known-failed rather than burning the whole budget on something
 * that will never arrive, and never throws — a caller that can't get a picture still
 * has a successful publish to report.
 */
export const collectRender = async (
  ctx: { meta: MetaStore; blobs: BlobStore },
  artifactId: string,
  n: number,
  variant: RenderVariant,
  waitSecs: number,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> => {
  const deadline = Date.now() + Math.min(Math.max(waitSecs, 0), RENDER_WAIT_MAX) * 1000
  try {
    for (;;) {
      const v = await ctx.meta.getVersion(artifactId, n)
      const got = v ? pickVariant(v, variant) : null
      if (got?.status === "ready" && got.key) {
        const bytes = await ctx.blobs.get(got.key)
        // Sniffed, never assumed: the label should read the bytes, not restate what the
        // pipeline is believed to produce.
        if (bytes) return { bytes, mimeType: sniffImageType(bytes) ?? "image/png" }
        return null
      }
      // A failed variant will not become ready by waiting for it.
      if (got?.status === "failed") return null
      if (Date.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, 1000))
    }
  } catch {
    return null
  }
}
