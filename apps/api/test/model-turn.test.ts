import { describe, expect, it } from "vitest"
import { asMessages } from "../src/lib/model-turn"

describe("model message adapter", () => {
  it("preserves rendered screenshots in tool results instead of flattening pixels to JSON", () => {
    const messages = asMessages("system", [
      {
        role: "assistant",
        content: [{ id: "inspect", name: "read", input: { render: "top" } }],
      },
      {
        role: "user",
        content: [
          {
            tool_use_id: "inspect",
            content: {
              type: "content",
              value: [
                { type: "text", text: "Rendered artifact" },
                { type: "image-data", data: "iVBORw0KGgo=", mediaType: "image/png" },
              ],
            },
          },
        ],
      },
    ])

    expect(JSON.stringify(messages)).toContain("image-data")
    expect(JSON.stringify(messages)).toContain("iVBORw0KGgo=")
  })
})
