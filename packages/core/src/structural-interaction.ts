export type StructuralGesture = "drag" | "resize" | "layout"
export type StructuralInteractionPhase =
  | "idle"
  | "selected"
  | "dragging"
  | "resizing"
  | "validating"
  | "committed"
  | "cancelled"

export type StructuralConstraintCode =
  | "multi-selection"
  | "transformed"
  | "width-axis-controlled"
  | "height-axis-controlled"
  | "partial-selection"
  | "unbounded-stack"
  | "content-clips"
  | "authored-layout"
  | "no-change"

export interface StructuralConstraintReason {
  code: StructuralConstraintCode
  message: string
  nodeId?: string
  suggestion?: "select-all" | "same-width" | "same-height" | "fit-height"
}

export interface StructuralInteractionState {
  phase: StructuralInteractionPhase
  selectedIds: readonly string[]
  activeId: string | null
  gesture: StructuralGesture | null
  reason: StructuralConstraintReason | null
}

export type StructuralInteractionEvent =
  | { type: "select"; selectedIds: readonly string[]; activeId: string | null }
  | { type: "begin"; gesture: StructuralGesture }
  | { type: "validate" }
  | { type: "commit" }
  | { type: "cancel"; reason?: StructuralConstraintReason }
  | { type: "settle" }
  | { type: "clear" }

export const idleStructuralInteraction = (): StructuralInteractionState => ({
  phase: "idle",
  selectedIds: [],
  activeId: null,
  gesture: null,
  reason: null,
})

/** A deliberately small state machine shared by pointer, keyboard, and layout actions.
 * Invalid lifecycle events are ignored so late pointer-capture and blur events are harmless. */
export const transitionStructuralInteraction = (
  state: StructuralInteractionState,
  event: StructuralInteractionEvent,
): StructuralInteractionState => {
  if (event.type === "clear") return idleStructuralInteraction()
  if (event.type === "select")
    return event.activeId && event.selectedIds.length
      ? {
          phase: "selected",
          selectedIds: [...event.selectedIds],
          activeId: event.activeId,
          gesture: null,
          reason: null,
        }
      : idleStructuralInteraction()
  if (event.type === "begin" && state.phase === "selected")
    return {
      ...state,
      phase:
        event.gesture === "drag"
          ? "dragging"
          : event.gesture === "resize"
            ? "resizing"
            : "validating",
      gesture: event.gesture,
      reason: null,
    }
  if (event.type === "validate" && (state.phase === "dragging" || state.phase === "resizing"))
    return { ...state, phase: "validating" }
  if (event.type === "commit" && state.phase === "validating")
    return { ...state, phase: "committed", reason: null }
  if (
    event.type === "cancel" &&
    state.phase !== "idle" &&
    state.phase !== "committed" &&
    state.phase !== "cancelled"
  )
    return { ...state, phase: "cancelled", reason: event.reason ?? null }
  if (event.type === "settle" && (state.phase === "committed" || state.phase === "cancelled"))
    return state.activeId
      ? { ...state, phase: "selected", gesture: null, reason: null }
      : idleStructuralInteraction()
  return state
}

export interface StructuralModifierKeys {
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}

export interface StructuralModifierIntent {
  extendSelection: boolean
  bypassSnap: boolean
  keyboardWidthStep: number
  keyboardHeightStep: number
  reorderShortcut: boolean
}

export const structuralModifierIntent = (
  keys: StructuralModifierKeys,
): StructuralModifierIntent => ({
  extendSelection: !!(keys.shiftKey || keys.metaKey || keys.ctrlKey),
  bypassSnap: !!keys.altKey,
  keyboardWidthStep: keys.shiftKey ? 5 : 1,
  keyboardHeightStep: keys.shiftKey ? 8 : 1,
  reorderShortcut: !!keys.altKey && !keys.metaKey && !keys.ctrlKey,
})

export type StructuralCapability =
  | "drag"
  | "resize-width"
  | "resize-height"
  | "resize-both"
  | "align"
  | "distribute"
  | "equalize-width"
  | "equalize-height"
  | "fit-height"
  | "exact-size"

export interface StructuralCapabilityInput {
  selectionCount: number
  siblingCount: number
  transformed?: boolean
  widthAxis?: boolean
  heightAxis?: boolean
  alignAxis?: boolean
  boundedStack?: boolean
  hasFixedHeight?: boolean
  activeId?: string
}

export type StructuralCapabilityResult =
  | { available: true; reason: null }
  | { available: false; reason: StructuralConstraintReason }

const blocked = (
  code: StructuralConstraintCode,
  message: string,
  input: StructuralCapabilityInput,
  suggestion?: StructuralConstraintReason["suggestion"],
): StructuralCapabilityResult => ({
  available: false,
  reason: { code, message, nodeId: input.activeId, suggestion },
})

/** Declarative availability shared by button painting and action entry points. */
export const evaluateStructuralCapability = (
  capability: StructuralCapability,
  input: StructuralCapabilityInput,
): StructuralCapabilityResult => {
  const batch = input.selectionCount > 1
  if (
    ["drag", "resize-width", "resize-height", "resize-both", "exact-size"].includes(capability) &&
    batch
  )
    return blocked("multi-selection", "Resize one element at a time", input)
  if (
    input.transformed &&
    [
      "resize-width",
      "resize-height",
      "resize-both",
      "exact-size",
      "equalize-width",
      "equalize-height",
      "distribute",
    ].includes(capability)
  )
    return blocked("transformed", `${input.activeId ?? "This element"} is transformed`, input)
  if (
    ["resize-width", "resize-both", "exact-size", "equalize-width"].includes(capability) &&
    !input.widthAxis
  )
    return blocked("width-axis-controlled", "Authored layout controls this width", input)
  if (
    ["resize-height", "resize-both", "exact-size", "equalize-height"].includes(capability) &&
    !input.heightAxis
  )
    return blocked("height-axis-controlled", "Authored layout controls this height", input)
  if (
    ["align", "equalize-width", "equalize-height", "fit-height"].includes(capability) &&
    input.selectionCount < 2
  )
    return blocked("partial-selection", "Select at least two siblings", input, "select-all")
  if (capability === "align" && !input.alignAxis)
    return blocked("authored-layout", "This stack does not expose safe cross-axis alignment", input)
  if (capability === "distribute") {
    if (input.selectionCount !== input.siblingCount)
      return blocked(
        "partial-selection",
        `Select all ${input.siblingCount} siblings to distribute spacing`,
        input,
        "select-all",
      )
    if (!input.boundedStack)
      return blocked(
        "unbounded-stack",
        "Give this stack a bounded height before distributing",
        input,
      )
  }
  if (capability === "fit-height" && !input.hasFixedHeight)
    return blocked("no-change", "Selected elements already fit content", input)
  return { available: true, reason: null }
}

export interface StructuralDropCandidate {
  id: string
  start: number
  end: number
}

export interface StructuralDropTarget {
  beforeId: string | null
  anchorId: string
  placement: "before" | "after"
}

export const structuralDropTarget = (
  pointer: number,
  candidates: readonly StructuralDropCandidate[],
): StructuralDropTarget | null => {
  if (!candidates.length || !Number.isFinite(pointer)) return null
  const before = candidates.find((candidate) => pointer < (candidate.start + candidate.end) / 2)
  const anchor = before ?? candidates.at(-1)
  if (!anchor) return null
  return {
    beforeId: before?.id ?? null,
    anchorId: anchor.id,
    placement: before ? "before" : "after",
  }
}

export interface StructuralDistributionValidation {
  targetGap: number
  actualGaps: readonly number[]
  beforeSizes: readonly number[]
  afterSizes: readonly number[]
  scrollSize: number
  clientSize: number
  tolerance?: number
}

export const structuralDistributionIsValid = ({
  targetGap,
  actualGaps,
  beforeSizes,
  afterSizes,
  scrollSize,
  clientSize,
  tolerance = 1,
}: StructuralDistributionValidation): boolean =>
  Number.isFinite(targetGap) &&
  actualGaps.every((gap) => Math.abs(gap - targetGap) <= tolerance) &&
  beforeSizes.length === afterSizes.length &&
  afterSizes.every((size, index) => Math.abs(size - (beforeSizes[index] ?? size)) <= tolerance) &&
  scrollSize <= clientSize + tolerance

export type StructuralIntentCommand = "balance" | "emphasize-active"

export type StructuralIntentOperation =
  | { kind: "set-width"; ids: readonly string[]; width: number }
  | { kind: "fit-height"; ids: readonly string[] }
  | { kind: "align"; ids: readonly string[]; alignment: "start" | "center" }

export interface StructuralIntentPlan {
  command: StructuralIntentCommand
  title: string
  summary: string
  operations: readonly StructuralIntentOperation[]
}

export interface StructuralIntentPlanInput {
  selectedIds: readonly string[]
  activeId: string
  widths: readonly number[]
  fixedHeightIds?: readonly string[]
  canAlign?: boolean
}

/** Choose the artifact's nearest familiar width rail from the selection's median.
 * Keeping this pure makes the inferred design language deterministic and reviewable. */
export const inferStructuralDesignRail = (
  widths: readonly number[],
  rails: readonly number[] = [50, 75, 100],
): number | null => {
  const values = widths.filter(Number.isFinite).map((value) => Math.round(value))
  const candidates = rails.filter(Number.isFinite).map((value) => Math.round(value))
  if (!values.length || !candidates.length) return null
  values.sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  const median =
    values.length % 2
      ? (values[middle] as number)
      : ((values[middle - 1] as number) + (values[middle] as number)) / 2
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - median) < Math.abs(best - median) ? candidate : best,
  )
}

/** Compile a human or agent design intent into the same bounded operations exposed
 * by manual controls. The caller previews this plan before applying it. */
export const planStructuralIntent = (
  command: StructuralIntentCommand,
  input: StructuralIntentPlanInput,
): StructuralIntentPlan | null => {
  if (input.selectedIds.length < 2 || !input.selectedIds.includes(input.activeId)) return null
  const fixed = (input.fixedHeightIds ?? []).filter((id) => input.selectedIds.includes(id))
  if (command === "balance") {
    const rail = inferStructuralDesignRail(input.widths)
    if (rail === null) return null
    const operations: StructuralIntentOperation[] = [
      { kind: "set-width", ids: [...input.selectedIds], width: rail },
    ]
    if (fixed.length) operations.push({ kind: "fit-height", ids: fixed })
    if (input.canAlign)
      operations.push({ kind: "align", ids: [...input.selectedIds], alignment: "center" })
    const parts = [`${rail}% local rail`]
    if (fixed.length) parts.push(`fit ${fixed.length} fixed height${fixed.length === 1 ? "" : "s"}`)
    if (input.canAlign) parts.push("center alignment")
    return {
      command,
      title: "Balance selection",
      summary: parts.join(" · "),
      operations,
    }
  }
  const peers = input.selectedIds.filter((id) => id !== input.activeId)
  const operations: StructuralIntentOperation[] = [
    { kind: "set-width", ids: [input.activeId], width: 75 },
    { kind: "set-width", ids: peers, width: 50 },
  ]
  if (fixed.length) operations.push({ kind: "fit-height", ids: fixed })
  if (input.canAlign)
    operations.push({ kind: "align", ids: [...input.selectedIds], alignment: "start" })
  return {
    command,
    title: `Emphasize ${input.activeId}`,
    summary: `active 75% · ${peers.length} peer${peers.length === 1 ? "" : "s"} 50%${fixed.length ? " · fit content" : ""}${input.canAlign ? " · start alignment" : ""}`,
    operations,
  }
}

export interface StructuralHealthInput extends StructuralCapabilityInput {
  clipping?: readonly { id: string; overflow: number; fitHeight?: boolean }[]
  widths?: readonly number[]
  heights?: readonly number[]
}

/** First leapfrog primitive: return the exact culprit and nearest safe repair. */
export const coachStructuralLayout = (
  input: StructuralHealthInput,
): StructuralConstraintReason | null => {
  const clipped = input.clipping?.find(({ overflow }) => overflow > 1)
  if (clipped)
    return {
      code: "content-clips",
      nodeId: clipped.id,
      message: clipped.fitHeight
        ? `${clipped.id} clips ${Math.ceil(clipped.overflow)}px of content. Fit H is the safe fix`
        : `${clipped.id} clips ${Math.ceil(clipped.overflow)}px of content inside an authored height`,
      suggestion: clipped.fitHeight ? "fit-height" : undefined,
    }
  const distribute = evaluateStructuralCapability("distribute", input)
  if (!distribute.available && distribute.reason.code === "partial-selection")
    return distribute.reason
  const widths = input.widths ?? []
  if (widths.length > 1 && Math.max(...widths) - Math.min(...widths) > 1)
    return {
      code: "authored-layout",
      message: `${widths.length} sibling widths differ. Same W will normalize them`,
      suggestion: "same-width",
    }
  const heights = input.heights ?? []
  if (heights.length > 1 && Math.max(...heights) - Math.min(...heights) > 1)
    return {
      code: "authored-layout",
      message: `${heights.length} sibling heights differ. Same H will normalize them`,
      suggestion: "same-height",
    }
  return null
}
