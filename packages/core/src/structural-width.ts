export const MIN_STRUCTURAL_WIDTH_PCT = 10
export const MAX_STRUCTURAL_WIDTH_PCT = 100
export const STRUCTURAL_WIDTH_PROPERTY = "--derive-structural-width"
export const MIN_STRUCTURAL_HEIGHT_PX = 24
export const MAX_STRUCTURAL_HEIGHT_PX = 8192
export const STRUCTURAL_HEIGHT_PROPERTY = "--derive-structural-height"
export const STRUCTURAL_ALIGN_PROPERTY = "--derive-structural-align"
export const STRUCTURAL_GAP_PROPERTY = "--derive-structural-gap"
export const MIN_STRUCTURAL_GAP_PX = 0
export const MAX_STRUCTURAL_GAP_PX = 512
export type StructuralAlignment = "start" | "center" | "end"
/** The layout attributes the editor writes (`data-derive-<key>`), each but size paired
 *  with an inline custom property that carries its value plus a unit. */
export const STRUCTURAL_LAYOUT = {
  size: null,
  width: [STRUCTURAL_WIDTH_PROPERTY, "%"],
  height: [STRUCTURAL_HEIGHT_PROPERTY, "px"],
  align: [STRUCTURAL_ALIGN_PROPERTY, ""],
  gap: [STRUCTURAL_GAP_PROPERTY, "px"],
} as const
