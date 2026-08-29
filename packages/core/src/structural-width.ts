export const MIN_STRUCTURAL_WIDTH_PCT = 10
export const MAX_STRUCTURAL_WIDTH_PCT = 100
export const STRUCTURAL_WIDTH_PROPERTY = "--derive-structural-width"
export const MIN_STRUCTURAL_HEIGHT_PX = 24
export const MAX_STRUCTURAL_HEIGHT_PX = 8192
export const STRUCTURAL_HEIGHT_PROPERTY = "--derive-structural-height"

export interface StructuralWidthSnap {
  width: number
  snappedTo: number | null
}

export interface StructuralHeightSnap {
  height: number
  snappedTo: number | null
}

export interface StructuralResizeAxis {
  edge: "left" | "right"
  /** Fraction of total width change seen at the active edge; sign is drag direction. */
  motion: -1 | 0.5 | 1
}

export interface StructuralBlockResizeAxis {
  edge: "top" | "bottom"
  motion: -1 | 0.5 | 1
}

export const boundedStructuralWidth = (value: number): number =>
  Math.min(MAX_STRUCTURAL_WIDTH_PCT, Math.max(MIN_STRUCTURAL_WIDTH_PCT, Math.round(value)))

/** Choose the edge that visibly moves. Stack children normally anchor left, but
 * centered and RTL/end-aligned authored layouts need different pointer math. */
export const structuralResizeAxis = (
  leftGap: number,
  rightGap: number,
  centered = false,
): StructuralResizeAxis => {
  if (centered) return { edge: "right", motion: 0.5 }
  return rightGap < leftGap ? { edge: "left", motion: -1 } : { edge: "right", motion: 1 }
}

/** Vertical counterpart for column stacks whose children may be start-, end-, or
 * center-anchored inside a region with a definite height. */
export const structuralBlockResizeAxis = (
  topGap: number,
  bottomGap: number,
  centered = false,
): StructuralBlockResizeAxis => {
  if (centered) return { edge: "bottom", motion: 0.5 }
  return bottomGap < topGap ? { edge: "top", motion: -1 } : { edge: "bottom", motion: 1 }
}

/** Pick the nearest eligible width inside a caller-supplied threshold. Geometry
 * stays outside this pure helper: the iframe converts its screen-space snap radius
 * to percentage points before calling it. */
export const snapStructuralWidth = (
  value: number,
  candidates: readonly number[],
  threshold: number,
): StructuralWidthSnap => {
  const width = boundedStructuralWidth(value)
  let snappedTo: number | null = null
  const radius = Math.max(0, threshold)
  let best = Number.POSITIVE_INFINITY
  for (const raw of candidates) {
    if (!Number.isFinite(raw)) continue
    const candidate = boundedStructuralWidth(raw)
    const distance = Math.abs(candidate - width)
    if (distance <= radius && distance < best) {
      best = distance
      snappedTo = candidate
    }
  }
  return snappedTo === null ? { width, snappedTo: null } : { width: snappedTo, snappedTo }
}

export const boundedStructuralHeight = (value: number): number =>
  Math.min(MAX_STRUCTURAL_HEIGHT_PX, Math.max(MIN_STRUCTURAL_HEIGHT_PX, Math.round(value)))

/** Height is stored in authored CSS pixels because a stack normally has auto
 * height; a percentage would either be undefined or create a parent/child cycle. */
export const snapStructuralHeight = (
  value: number,
  candidates: readonly number[],
  threshold: number,
): StructuralHeightSnap => {
  const height = boundedStructuralHeight(value)
  let snappedTo: number | null = null
  const radius = Math.max(0, threshold)
  let best = Number.POSITIVE_INFINITY
  for (const raw of candidates) {
    if (!Number.isFinite(raw)) continue
    const candidate = boundedStructuralHeight(raw)
    const distance = Math.abs(candidate - height)
    if (distance <= radius && distance < best) {
      best = distance
      snappedTo = candidate
    }
  }
  return snappedTo === null ? { height, snappedTo: null } : { height: snappedTo, snappedTo }
}
