import { customAlphabet } from "nanoid"

const base36 = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8)

export const newShortId = (): string => base36()
export const newId = (prefix: string): string => `${prefix}_${base36()}${base36()}`

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)

/**
 * An artifact ref is a short id, optionally with a slug and an `@vN` suffix:
 *   abc12345            → { shortId: "abc12345" }
 *   abc12345-my-title   → { shortId: "abc12345" }
 *   abc12345@v4         → { shortId: "abc12345", version: 4 }
 * Used by the API (unfurl/embed/og routes); mirrors the SPA's own `parse-ref.ts`
 * (kept separate so the client bundle doesn't pull in core) so the same `/a/:ref`
 * link resolves identically on the server and the client.
 */
export const parseRef = (ref: string): { shortId: string; version?: number } => {
  const m = ref.match(/^([0-9a-z]{6,12})(?:-[a-z0-9-]*?)?(?:@v(\d+))?$/)
  return { shortId: m?.[1] ?? ref, version: m?.[2] ? Number(m[2]) : undefined }
}
