// An artifact ref is a short id, optionally with a slug and an @vN suffix:
//   abc123            → { shortId: "abc123" }
//   abc123-my-title   → { shortId: "abc123" }
//   abc123@v4         → { shortId: "abc123", version: 4 }
// Shared by the /a/$ref route loader (to key the prefetch) and the page.
export const parseRef = (ref: string): { shortId: string; version?: number } => {
  const m = ref.match(/^([0-9a-z]{6,12})(?:-[a-z0-9-]*?)?(?:@v(\d+))?$/)
  return { shortId: m?.[1] ?? ref, version: m?.[2] ? Number(m[2]) : undefined }
}
