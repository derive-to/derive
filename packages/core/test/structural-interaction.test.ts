import { describe, expect, it } from "vitest"
import {
  coachStructuralLayout,
  evaluateStructuralCapability,
  idleStructuralInteraction,
  inferStructuralDesignRail,
  planStructuralIntent,
  structuralDistributionIsValid,
  structuralDropTarget,
  structuralModifierIntent,
  transitionStructuralInteraction,
} from "../src/structural-interaction"

describe("structural interaction state", () => {
  it("runs resize through selection, validation, commit, and settle", () => {
    let state = transitionStructuralInteraction(idleStructuralInteraction(), {
      type: "select",
      selectedIds: ["alpha"],
      activeId: "alpha",
    })
    expect(state.phase).toBe("selected")
    state = transitionStructuralInteraction(state, { type: "begin", gesture: "resize" })
    expect(state.phase).toBe("resizing")
    state = transitionStructuralInteraction(state, { type: "validate" })
    expect(state.phase).toBe("validating")
    state = transitionStructuralInteraction(state, { type: "commit" })
    expect(state.phase).toBe("committed")
    state = transitionStructuralInteraction(state, { type: "settle" })
    expect(state).toMatchObject({ phase: "selected", activeId: "alpha", gesture: null })
  })

  it("records a cancellation reason and ignores late invalid events", () => {
    const selected = transitionStructuralInteraction(idleStructuralInteraction(), {
      type: "select",
      selectedIds: ["alpha"],
      activeId: "alpha",
    })
    expect(transitionStructuralInteraction(selected, { type: "commit" })).toBe(selected)
    const dragging = transitionStructuralInteraction(selected, { type: "begin", gesture: "drag" })
    const cancelled = transitionStructuralInteraction(dragging, {
      type: "cancel",
      reason: { code: "authored-layout", message: "Authored layout controls this order" },
    })
    expect(cancelled).toMatchObject({ phase: "cancelled", reason: { code: "authored-layout" } })
    expect(transitionStructuralInteraction(cancelled, { type: "validate" })).toBe(cancelled)
  })
})

describe("structural modifier grammar", () => {
  it.each([
    [
      {},
      {
        extendSelection: false,
        bypassSnap: false,
        keyboardWidthStep: 1,
        keyboardHeightStep: 1,
        reorderShortcut: false,
      },
    ],
    [
      { shiftKey: true },
      {
        extendSelection: true,
        bypassSnap: false,
        keyboardWidthStep: 5,
        keyboardHeightStep: 8,
        reorderShortcut: false,
      },
    ],
    [
      { altKey: true },
      {
        extendSelection: false,
        bypassSnap: true,
        keyboardWidthStep: 1,
        keyboardHeightStep: 1,
        reorderShortcut: true,
      },
    ],
    [
      { metaKey: true, altKey: true },
      {
        extendSelection: true,
        bypassSnap: true,
        keyboardWidthStep: 1,
        keyboardHeightStep: 1,
        reorderShortcut: false,
      },
    ],
  ])("maps %o to one shared intent", (keys, expected) => {
    expect(structuralModifierIntent(keys)).toEqual(expected)
  })
})

describe("structural capabilities", () => {
  const base = {
    selectionCount: 1,
    siblingCount: 3,
    transformed: false,
    widthAxis: true,
    heightAxis: true,
    alignAxis: true,
    boundedStack: true,
    hasFixedHeight: true,
    activeId: "alpha",
  }

  it.each([
    ["resize-both", { ...base, transformed: true }, "transformed"],
    ["resize-width", { ...base, widthAxis: false }, "width-axis-controlled"],
    ["resize-height", { ...base, heightAxis: false }, "height-axis-controlled"],
    ["distribute", { ...base, selectionCount: 2 }, "partial-selection"],
    ["distribute", { ...base, selectionCount: 3, boundedStack: false }, "unbounded-stack"],
    ["fit-height", { ...base, selectionCount: 2, hasFixedHeight: false }, "no-change"],
  ] as const)("explains why %s is unavailable", (capability, input, code) => {
    expect(evaluateStructuralCapability(capability, input)).toMatchObject({
      available: false,
      reason: { code, nodeId: "alpha" },
    })
  })

  it("allows a supported diagonal resize", () => {
    expect(evaluateStructuralCapability("resize-both", base)).toEqual({
      available: true,
      reason: null,
    })
  })
})

describe("structural geometry fixtures", () => {
  const candidates = [
    { id: "alpha", start: 0, end: 80 },
    { id: "bravo", start: 100, end: 180 },
    { id: "charlie", start: 200, end: 280 },
  ]

  it.each([
    [10, { beforeId: "alpha", anchorId: "alpha", placement: "before" }],
    [70, { beforeId: "bravo", anchorId: "bravo", placement: "before" }],
    [190, { beforeId: "charlie", anchorId: "charlie", placement: "before" }],
    [999, { beforeId: null, anchorId: "charlie", placement: "after" }],
  ] as const)("picks the stable drop target at %d", (pointer, expected) => {
    expect(structuralDropTarget(pointer, candidates)).toEqual(expected)
  })

  it.each([
    [
      {
        targetGap: 24,
        actualGaps: [24, 24.5],
        beforeSizes: [80, 90, 70],
        afterSizes: [80, 90, 70],
        scrollSize: 320,
        clientSize: 320,
      },
      true,
    ],
    [
      {
        targetGap: 24,
        actualGaps: [24, 28],
        beforeSizes: [80, 90, 70],
        afterSizes: [80, 90, 70],
        scrollSize: 320,
        clientSize: 320,
      },
      false,
    ],
    [
      {
        targetGap: 24,
        actualGaps: [24, 24],
        beforeSizes: [80, 90, 70],
        afterSizes: [80, 96, 70],
        scrollSize: 320,
        clientSize: 320,
      },
      false,
    ],
    [
      {
        targetGap: 24,
        actualGaps: [24, 24],
        beforeSizes: [80, 90, 70],
        afterSizes: [80, 90, 70],
        scrollSize: 326,
        clientSize: 320,
      },
      false,
    ],
  ] as const)("validates distribution without DOM state", (fixture, expected) => {
    expect(structuralDistributionIsValid(fixture)).toBe(expected)
  })
})

describe("constraint coach", () => {
  it("names the clipping element and offers Fit H before weaker advice", () => {
    expect(
      coachStructuralLayout({
        selectionCount: 3,
        siblingCount: 3,
        boundedStack: true,
        clipping: [
          { id: "alpha", overflow: 0 },
          { id: "bravo", overflow: 17.2, fitHeight: true },
        ],
        widths: [300, 240, 200],
      }),
    ).toEqual({
      code: "content-clips",
      nodeId: "bravo",
      message: "bravo clips 18px of content. Fit H is the safe fix",
      suggestion: "fit-height",
    })
  })

  it("offers Select all for a partial distribution selection", () => {
    expect(
      coachStructuralLayout({ selectionCount: 2, siblingCount: 4, boundedStack: false }),
    ).toMatchObject({
      code: "partial-selection",
      message: "Select all 4 siblings to distribute spacing",
      suggestion: "select-all",
    })
  })

  it("does not offer a repair that cannot change an authored clipping height", () => {
    expect(
      coachStructuralLayout({
        selectionCount: 2,
        siblingCount: 2,
        boundedStack: true,
        clipping: [{ id: "charlie", overflow: 9 }],
      }),
    ).toEqual({
      code: "content-clips",
      nodeId: "charlie",
      message: "charlie clips 9px of content inside an authored height",
      suggestion: undefined,
    })
  })
})

describe("structural intent planner", () => {
  it.each([
    [[52, 68, 84, 90], 75],
    [[44, 48, 55], 50],
    [[92, 110], 100],
    [[], null],
  ] as const)("infers the nearest local rail from %o", (widths, expected) => {
    expect(inferStructuralDesignRail(widths)).toBe(expected)
  })

  it("previews a balanced repair as bounded existing operations", () => {
    expect(
      planStructuralIntent("balance", {
        selectedIds: ["alpha", "bravo", "charlie"],
        activeId: "bravo",
        widths: [52, 76, 88],
        fixedHeightIds: ["alpha", "charlie", "outside"],
        canAlign: true,
      }),
    ).toEqual({
      command: "balance",
      title: "Balance selection",
      summary: "75% local rail · fit 2 fixed heights · center alignment",
      operations: [
        { kind: "set-width", ids: ["alpha", "bravo", "charlie"], width: 75 },
        { kind: "fit-height", ids: ["alpha", "charlie"] },
        {
          kind: "align",
          ids: ["alpha", "bravo", "charlie"],
          alignment: "center",
        },
      ],
    })
  })

  it("keeps emphasis deterministic around the active element", () => {
    expect(
      planStructuralIntent("emphasize-active", {
        selectedIds: ["alpha", "bravo", "charlie"],
        activeId: "bravo",
        widths: [50, 50, 50],
        canAlign: true,
      }),
    ).toEqual({
      command: "emphasize-active",
      title: "Emphasize bravo",
      summary: "active 75% · 2 peers 50% · start alignment",
      operations: [
        { kind: "set-width", ids: ["bravo"], width: 75 },
        { kind: "set-width", ids: ["alpha", "charlie"], width: 50 },
        {
          kind: "align",
          ids: ["alpha", "bravo", "charlie"],
          alignment: "start",
        },
      ],
    })
  })

  it("rejects selections that cannot name a stable active element", () => {
    expect(
      planStructuralIntent("balance", {
        selectedIds: ["alpha"],
        activeId: "alpha",
        widths: [50],
      }),
    ).toBeNull()
    expect(
      planStructuralIntent("balance", {
        selectedIds: ["alpha", "bravo"],
        activeId: "outside",
        widths: [50, 75],
      }),
    ).toBeNull()
  })
})
