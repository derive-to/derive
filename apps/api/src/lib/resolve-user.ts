import { type MetaStore, normalizeUsername } from "@derive/core"

/**
 * Resolve a sharing/invite target that may be typed as either an email or a
 * @handle, returning the matched user's id (or null if unknown). An email has an
 * `@` in the middle (`a@b.c`); a handle is bare or `@`-prefixed (`@nia` / `nia`).
 * So Share accepts both: the username is the public identifier, the email still
 * works for people who only know that.
 */
export const resolveUserRef = async (meta: MetaStore, ref: string): Promise<string | null> => {
  const s = ref.trim()
  if (!s) return null
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) {
    const u = await meta.findUserByEmail(s)
    return u?.id ?? null
  }
  const p = await meta.getUserByUsername(normalizeUsername(s.replace(/^@/, "")))
  return p?.id ?? null
}
