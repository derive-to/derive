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
 * An artifact ref is a name (slug) followed by the short id, with an optional `@vN`
 * suffix — the short id is the last hyphen token (name-first, so the URL reads well):
 *   abc12345              → { shortId: "abc12345" }
 *   my-title-abc12345     → { shortId: "abc12345" }
 *   my-title-abc12345@v4  → { shortId: "abc12345", version: 4 }
 * The short id is taken from the last token, falling back to the first (legacy
 * short-id-first links) then the whole ref. Mirrors the SPA's own `parse-ref.ts`
 * (kept separate so the client bundle doesn't pull in core) so the same `/artifacts/:ref`
 * link resolves identically on the server and the client.
 */
export const parseRef = (ref: string): { shortId: string; version?: number } => {
  const [base = "", v] = ref.split("@v")
  const parts = base.split("-")
  const id = /^[0-9a-z]{6,12}$/
  const last = parts[parts.length - 1] ?? ""
  const first = parts[0] ?? ""
  const shortId = id.test(last) ? last : id.test(first) ? first : base
  return { shortId, version: v ? Number(v) : undefined }
}

/** Ordered, de-duped short-id candidates for a `/artifacts/:ref`: the trailing token first
 *  (name-first links), then the leading token (legacy short-id-first). Resolve by
 *  trying each in order so any link form finds the right artifact — even a name whose
 *  tail looks like an id. Falls back to the whole base when neither token is id-shaped. */
export const candidateShortIds = (ref: string): string[] => {
  const base = ref.split("@v")[0] ?? ""
  const parts = base.split("-")
  const id = /^[0-9a-z]{6,12}$/
  const out: string[] = []
  for (const c of [parts[parts.length - 1] ?? "", parts[0] ?? ""])
    if (id.test(c) && !out.includes(c)) out.push(c)
  return out.length ? out : [base]
}

/** Build a readable `/artifacts/:ref`: `<name>-<shortId>`, the name from an explicit slug or
 *  the current title. Decorative — `parseRef` resolves by the trailing short id, so
 *  renames and stale names still resolve. */
export const refFor = (a: {
  short_id: string
  slug?: string | null
  title?: string | null
}): string => {
  const name = a.slug || (a.title ? slugify(a.title) : "")
  return name ? `${name}-${a.short_id}` : a.short_id
}
