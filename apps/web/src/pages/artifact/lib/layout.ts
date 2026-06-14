import type { Comment } from "@/api"

export const COMPOSER_ID = "__composer__"

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// Place pinned thread cards beside their highlights without overlap: stack from
// the top honouring each desired Y + a gap, then if a card is active, pin it to
// its exact Y and push its neighbours out of the way (above and below).
export function layoutPins(
  items: { id: string; desiredY: number }[],
  heights: Record<string, number>,
  activeId: string | null,
  gap: number,
): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.desiredY - b.desiredY)
  const h = (id: string) => heights[id] ?? 116
  const pos: Record<string, number> = {}
  let prevBottom = -1e9
  for (const it of sorted) {
    const y = Math.max(it.desiredY, prevBottom + gap)
    pos[it.id] = y
    prevBottom = y + h(it.id)
  }
  const idx = activeId ? sorted.findIndex((s) => s.id === activeId) : -1
  const act = idx >= 0 ? sorted[idx] : undefined
  if (act) {
    pos[act.id] = act.desiredY
    let limit = act.desiredY
    for (let i = idx - 1; i >= 0; i--) {
      const it = sorted[i]
      if (!it) continue
      let p = pos[it.id] ?? it.desiredY
      if (p + h(it.id) + gap > limit) {
        p = limit - gap - h(it.id)
        pos[it.id] = p
      }
      limit = p
    }
    let top = act.desiredY + h(act.id)
    for (let i = idx + 1; i < sorted.length; i++) {
      const it = sorted[i]
      if (!it) continue
      let p = pos[it.id] ?? it.desiredY
      if (p < top + gap) {
        p = top + gap
        pos[it.id] = p
      }
      top = p + h(it.id)
    }
  }
  return pos
}

export function parseAnchor(
  a: string | null,
): { exact: string; prefix?: string; suffix?: string } | null {
  if (!a) return null
  try {
    const s = JSON.parse(a) as { exact?: string; prefix?: string; suffix?: string }
    return s.exact ? { exact: s.exact, prefix: s.prefix, suffix: s.suffix } : null
  } catch {
    return null
  }
}

export const anchorExact = (a: string | null): string | null => parseAnchor(a)?.exact ?? null

export function groupThreads(comments: Comment[]): Comment[][] {
  const map = new Map<string, Comment[]>()
  for (const c of comments) {
    if (!map.has(c.thread_id)) map.set(c.thread_id, [])
    map.get(c.thread_id)?.push(c)
  }
  return [...map.values()]
}
