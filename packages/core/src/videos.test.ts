import { describe, expect, it } from "vitest"
import { applySceneEdits, isVideoDocument, sliceScenes } from "./videos"

const video = `<!doctype html><html><body><main data-derive-video>
<section data-derive-scene="opening" data-duration-ms="5000" data-transition="fade">Hello</section>
<section data-derive-scene="proof" data-duration-ms="3000">World</section>
</main></body></html>`

describe("HTML video scenes", () => {
  it("recognizes canonical scene markup", () => {
    expect(isVideoDocument(video)).toBe(true)
    expect(sliceScenes(video).map((scene) => scene.id)).toEqual(["opening", "proof"])
  })

  it("refuses ambiguous ids and timing instead of guessing", () => {
    expect(
      isVideoDocument(video.replace('data-derive-scene="opening"', 'data-derive-scene="1 bad"')),
    ).toBe(false)
    expect(() =>
      sliceScenes(video.replace('data-duration-ms="5000"', 'data-duration-ms="50000"')),
    ).toThrow(/1000 to 30000/)
    const outside = video.replace(
      "</main>",
      "</main><section data-derive-scene=outside>x</section>",
    )
    expect(isVideoDocument(outside)).toBe(true)
    expect(sliceScenes(outside)).toHaveLength(2)
  })

  it("updates captions through the same scene operation", () => {
    expect(
      applySceneEdits(video, [{ op: "scene-update", id: "proof", caption: "Proof point" }]),
    ).toContain('data-derive-caption="Proof point"')
  })

  it("updates scene timing without serializing the document", () => {
    const out = applySceneEdits(video, [
      {
        op: "scene-update",
        id: "opening",
        duration_ms: 6500,
        transition: "slide",
        transition_ms: 450,
      },
    ])
    expect(out).toContain('data-duration-ms="6500"')
    expect(out).toContain('data-transition="slide"')
    expect(out).toContain('data-transition-ms="450"')
    expect(out).toContain("<!doctype html>")
  })

  it("duplicates, moves, and deletes by stable identity", () => {
    const duplicate = applySceneEdits(video, [{ op: "scene-duplicate", id: "opening" }])
    expect(sliceScenes(duplicate)).toHaveLength(3)
    expect(new Set(sliceScenes(duplicate).map((scene) => scene.id)).size).toBe(3)
    const moved = applySceneEdits(video, [{ op: "scene-move", id: "proof", direction: "previous" }])
    expect(sliceScenes(moved).map((scene) => scene.id)).toEqual(["proof", "opening"])
    const deleted = applySceneEdits(video, [{ op: "scene-delete", id: "proof" }])
    expect(sliceScenes(deleted).map((scene) => scene.id)).toEqual(["opening"])
  })
})
