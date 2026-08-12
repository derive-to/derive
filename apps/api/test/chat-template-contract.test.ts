import type { SessionMessageRecord, SessionRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import type { ModelTurn } from "../src/lib/agent-loop"
import { runChatTurn } from "../src/lib/chat-turn"

describe("agentic template job contract", () => {
  it("requires read → adapted publish with exact lineage → rendered visual inspection", async () => {
    const templateUri = "derive://template-libraries/lib_1/entry_1"
    const calls: Array<{ name: string; input: Record<string, unknown> }> = []
    let turn = 0
    let sawPixels = false
    const callModel = async (request: {
      messages: Array<{ content: unknown }>
    }): Promise<ModelTurn> => {
      turn++
      if (turn === 1)
        return {
          text: "",
          toolUses: [
            {
              id: "premature-publish",
              name: "publish",
              input: { title: "Copy", content: "unchanged" },
            },
          ],
          costUsd: null,
          done: false,
        }
      if (turn === 2)
        return {
          text: "",
          toolUses: [{ id: "read-starter", name: "read", input: { short_id: templateUri } }],
          costUsd: null,
          done: false,
        }
      if (turn === 3)
        return {
          text: "",
          toolUses: [
            {
              id: "adapted-publish",
              name: "publish",
              input: {
                title: "Acme launch room",
                content: "<main><h1>Acme launch room</h1><p>Adapted for November.</p></main>",
                derived_from: "wrong-reference",
              },
            },
          ],
          costUsd: null,
          done: false,
        }
      if (turn === 4)
        return {
          text: "",
          toolUses: [
            {
              id: "inspect",
              name: "read",
              input: { short_id: "made1234", render: "top", wait: 30 },
            },
          ],
          costUsd: null,
          done: false,
        }
      sawPixels = JSON.stringify(request.messages.at(-1)?.content).includes("image-data")
      return {
        text: "Your adapted artifact is ready: [Acme launch room](/artifacts/made1234).",
        toolUses: [],
        costUsd: null,
        done: true,
      }
    }

    const result = await runChatTurn(
      {
        model: {
          id: "test-model",
          label: "Test model",
          callModel,
        } as never,
      },
      {
        session: { id: "session-1" } as SessionRecord,
        transcript: [
          {
            author_kind: "asker",
            body_md: "Take this launch template and make it ours for November.",
          } as SessionMessageRecord,
        ],
        tools: {
          tools: [
            { name: "read", description: "Read", params: {} },
            { name: "publish", description: "Publish", params: {} },
          ],
          skills: [],
          execute: async (name, input) => {
            const values = input as Record<string, unknown>
            calls.push({ name, input: values })
            if (name === "publish")
              return { published: true, short_id: "made1234", title: values.title }
            if (values.render)
              return {
                type: "content",
                value: [
                  { type: "text", text: "Rendered page" },
                  { type: "image-data", data: "iVBORw0KGgo=", mediaType: "image/png" },
                ],
              }
            return { uri: templateUri, starter: "<main>Reusable structure</main>" }
          },
        },
        workspaceName: "Derive",
        asker: { name: "Ari", role: "owner" },
        skills: [],
        templateStart: { uri: templateUri, title: "Launch room", kind: "artifact" },
      },
    )

    expect(result.outcome).toBe("answered")
    expect(turn).toBe(5)
    expect(sawPixels).toBe(true)
    expect(calls.map((call) => call.name)).toEqual(["read", "publish", "read"])
    expect(calls.find((call) => call.name === "publish")?.input.derived_from).toBe(templateUri)
  })
})
