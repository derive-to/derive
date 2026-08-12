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

  it("does not count a render response as visual inspection until pixels reach the model", async () => {
    const templateUri = "derive://templates/narrative-pitch"
    let turn = 0
    let renderReads = 0
    let sawInspectionNudge = false
    const result = await runChatTurn(
      {
        model: {
          id: "test-model",
          label: "Test model",
          callModel: async (request: { messages: Array<{ content: unknown }> }) => {
            turn++
            if (turn === 1)
              return {
                text: "",
                toolUses: [{ id: "read", name: "read", input: { short_id: templateUri } }],
                costUsd: null,
                done: false,
              }
            if (turn === 2)
              return {
                text: "",
                toolUses: [
                  {
                    id: "publish",
                    name: "publish",
                    input: { title: "Adapted", content: "<h1>Adapted</h1>" },
                  },
                ],
                costUsd: null,
                done: false,
              }
            if (turn === 3 || turn === 5) {
              if (turn === 5)
                sawInspectionNudge = JSON.stringify(request.messages.at(-1)?.content).includes(
                  "visually inspect",
                )
              return {
                text: "",
                toolUses: [
                  {
                    id: `render-${turn}`,
                    name: "read",
                    input: { short_id: "made5678", render: "top", wait: 30 },
                  },
                ],
                costUsd: null,
                done: false,
              }
            }
            if (turn === 4) {
              return {
                text: "The adapted artifact is ready.",
                toolUses: [],
                costUsd: null,
                done: true,
              }
            }
            return {
              text: "The visually inspected artifact is ready.",
              toolUses: [],
              costUsd: null,
              done: true,
            }
          },
        } as never,
      },
      {
        session: { id: "session-render" } as SessionRecord,
        transcript: [{ author_kind: "asker", body_md: "Make this ours." } as SessionMessageRecord],
        tools: {
          tools: [
            { name: "read", description: "Read", params: {} },
            { name: "publish", description: "Publish", params: {} },
          ],
          skills: [],
          execute: async (name, input) => {
            const values = input as Record<string, unknown>
            if (name === "publish") return { published: true, short_id: "made5678" }
            if (values.render) {
              renderReads++
              if (renderReads === 1)
                return { render: "ready", note: "Too large to inline; open the URL." }
              return {
                type: "content",
                value: [
                  { type: "text", text: "Rendered page" },
                  { type: "image-data", data: "iVBORw0KGgo=", mediaType: "image/png" },
                ],
              }
            }
            return { uri: templateUri, starter: "<main>Reusable structure</main>" }
          },
        },
        workspaceName: "Derive",
        asker: { name: "Ari", role: "owner" },
        skills: [],
        templateStart: { uri: templateUri, title: "Narrative pitch", kind: "artifact" },
      },
    )

    expect(result.outcome).toBe("answered")
    expect(turn).toBe(6)
    expect(renderReads).toBe(2)
    expect(sawInspectionNudge).toBe(true)
  })

  it("requires a Context template read before the first adapted draft", async () => {
    const templateUri = "derive://templates/weekly-research-context"
    const calls: string[] = []
    let turn = 0
    const result = await runChatTurn(
      {
        model: {
          id: "test-model",
          label: "Test model",
          callModel: async () => {
            turn++
            if (turn === 1)
              return {
                text: "",
                toolUses: [{ id: "early-draft", name: "draft_manifest", input: { name: "Copy" } }],
                costUsd: null,
                done: false,
              }
            if (turn === 2)
              return {
                text: "",
                toolUses: [{ id: "read", name: "read", input: { short_id: templateUri } }],
                costUsd: null,
                done: false,
              }
            if (turn === 3)
              return {
                text: "",
                toolUses: [
                  {
                    id: "draft",
                    name: "draft_manifest",
                    input: { name: "Acme weekly research", manifest_md: "# Adapted setup" },
                  },
                ],
                costUsd: null,
                done: false,
              }
            return {
              text: "I adapted the weekly research setup for Acme.",
              toolUses: [],
              costUsd: null,
              done: true,
            }
          },
        } as never,
      },
      {
        session: { id: "session-context" } as SessionRecord,
        transcript: [
          { author_kind: "asker", body_md: "Set this up for Acme." } as SessionMessageRecord,
        ],
        tools: {
          tools: [
            { name: "read", description: "Read", params: {} },
            { name: "draft_manifest", description: "Draft", params: {} },
          ],
          skills: [],
          execute: async (name) => {
            calls.push(name)
            return name === "read"
              ? { uri: templateUri, starter: "# Weekly research" }
              : { ok: true }
          },
        },
        workspaceName: "Derive",
        asker: { name: "Ari", role: "owner" },
        skills: [],
        purpose: "context_builder",
        templateStart: { uri: templateUri, title: "Weekly research brief", kind: "context" },
      },
    )

    expect(result.outcome).toBe("answered")
    expect(turn).toBe(4)
    expect(calls).toEqual(["read", "draft_manifest"])
  })
})
