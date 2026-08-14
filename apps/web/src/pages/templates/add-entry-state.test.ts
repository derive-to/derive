import { describe, expect, it } from "vitest"
import type { Artifact } from "@/api"
import { initialAddEntryState, reduceAddEntry } from "./add-entry-state"

const artifact = (id: string, title: string, contentType: string) =>
  ({ short_id: id, title, current_content_type: contentType }) as Artifact

describe("add-entry state", () => {
  it("replaces derived metadata when the source changes", () => {
    let state = reduceAddEntry(initialAddEntryState(), {
      type: "select-source",
      artifact: artifact("first", "First deck", "text/x-derive-deck"),
    })
    state = reduceAddEntry(state, { type: "set-field", field: "description", value: "Old details" })
    state = reduceAddEntry(state, {
      type: "select-source",
      artifact: artifact("second", "Second doc", "text/markdown"),
    })
    expect(state).toMatchObject({
      source: "second",
      title: "Second doc",
      category: "Doc",
      description: "",
    })
  })

  it("resets the complete draft when a pasted source replaces a selection", () => {
    const selected = reduceAddEntry(initialAddEntryState(), {
      type: "select-source",
      artifact: artifact("first", "First page", "text/html"),
    })
    expect(reduceAddEntry(selected, { type: "paste-source", source: "another" })).toEqual({
      ...initialAddEntryState(),
      source: "another",
    })
  })
})
