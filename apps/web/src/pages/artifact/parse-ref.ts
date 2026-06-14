// An artifact ref is a name (slug) then the short id, with an optional @vN suffix —
// the short id is the last hyphen token (name-first). Mirrors core's parseRef.
//   abc12345              → { shortId: "abc12345" }
//   my-title-abc12345     → { shortId: "abc12345" }
//   my-title-abc12345@v4  → { shortId: "abc12345", version: 4 }
// Falls back to the first token (legacy short-id-first links) then the whole ref.
export const parseRef = (ref: string): { shortId: string; version?: number } => {
  const [base = "", v] = ref.split("@v")
  const parts = base.split("-")
  const id = /^[0-9a-z]{6,12}$/
  const last = parts[parts.length - 1] ?? ""
  const first = parts[0] ?? ""
  const shortId = id.test(last) ? last : id.test(first) ? first : base
  return { shortId, version: v ? Number(v) : undefined }
}
