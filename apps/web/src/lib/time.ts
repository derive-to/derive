// Compact relative-time formatter shared across the app (notifications, comments,
// version history): "just now", "5m ago", "3h ago", "2d ago".
export const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Future-facing counterpart for deadlines (the draft-claim page's "Expires in 2d"):
// "under a minute", "5m", "3h", "2d". Callers supply the surrounding words, so the
// buckets stay reusable across phrasings.
export const until = (iso: string): string => {
  const s = Math.max(0, (new Date(iso).getTime() - Date.now()) / 1000)
  if (s < 60) return "under a minute"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// Terse variant for dense repeated rows (the comment thread): "now", "5m", "3h",
// "2d" — "ago" is noise multiplied by every row. Pair with a title attr carrying
// the full date, so precision is a hover away.
export const agoShort = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// Absolute stamps for pickers and history, where "3h ago" is too vague to tell two
// versions apart: "Today at 5:14 PM", "Yesterday at 9:02 AM", "Oct 20 at 5:14 PM",
// and the year once it stops being this one.
export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
export const dayLabel = (iso: string): string => {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return "Today"
  if (same(d, y)) return "Yesterday"
  return d.toLocaleDateString(
    [],
    d.getFullYear() === today.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  )
}
export const stamp = (iso: string): string => `${dayLabel(iso)} at ${clock(iso)}`
