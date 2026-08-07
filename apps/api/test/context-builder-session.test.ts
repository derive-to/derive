import { describe, expect, it } from "vitest"
import type { ModelTurn } from "../src/lib/agent-loop"
import { catalogOf } from "../src/lib/model-catalog"
import { as, makeAuthedApp } from "./helpers"

const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }
const viewer = { id: "u-vi", email: "vi@x.com", name: "Vi" }
const MANIFEST = "# Pricing Helper\n\nAnswer from the pricing page only."
const draftArgs = {
  name: "Pricing Helper",
  description: "Answers pricing questions",
  kind: "knowledge",
  knows: ["Pricing page"],
  answers: "Short",
  wont: ["Legal advice"],
  manifest_md: MANIFEST,
  source_short_ids: [],
}

type Made = ReturnType<typeof makeAuthedApp>

const scripted = () => {
  let call = 0
  return async (): Promise<ModelTurn> => {
    call++
    if (call === 1)
      return {
        text: "",
        costUsd: null,
        done: false,
        toolUses: [{ id: "t1", name: "draft_manifest", input: draftArgs }],
      }
    return { text: "Here's the plan — look right?", toolUses: [], costUsd: null, done: true }
  }
}

const setup = async (
  name: string,
  model: () => Promise<ModelTurn>,
  members = [owner],
  role?: "viewer",
  user = owner,
): Promise<Made> => {
  const made = makeAuthedApp(name, members, role, {
    deps: {
      callModel: model,
      models: catalogOf([{ id: "model-a", label: "A", isDefault: true, build: () => model }]),
    },
  })
  await made.app.request("/v1/me", { headers: as(user.email) })
  await made.meta.setOrgSettings("default", {
    ...(await made.meta.getOrgSettings("default")),
    chatBeta: true,
  })
  return made
}

const openBuilder = (app: Made["app"], email: string, body = "A helper for pricing docs") =>
  app.request("/v1/chat-session", {
    method: "POST",
    headers: { ...as(email), "content-type": "application/json" },
    body: JSON.stringify({ workspace: "default", body_md: body, purpose: "context_builder" }),
  })

const waitForAgents = async (meta: Made["meta"], sessionId: string, count: number) => {
  let agents = (await meta.listSessionMessages(sessionId)).filter(
    (message) => message.author_kind === "agent",
  )
  for (let i = 0; i < 100 && agents.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    agents = (await meta.listSessionMessages(sessionId)).filter(
      (message) => message.author_kind === "agent",
    )
  }
  return agents
}

describe("builder session", () => {
  it("stores the complete draft but exposes only the public card", async () => {
    const { app, meta } = await setup("builder-ses", scripted())
    const response = await openBuilder(app, owner.email)
    expect(response.status).toBe(201)
    const { session } = (await response.json()) as { session: { id: string } }
    const [agent] = await waitForAgents(meta, session.id, 1)

    const stored = JSON.parse(agent?.meta ?? "{}")
    expect(stored.card?.draft).toMatchObject({ name: "Pricing Helper", manifest_md: MANIFEST })

    const read = await app.request(`/v1/sessions/${session.id}`, { headers: as(owner.email) })
    const payload = await read.text()
    expect(payload).toContain("Pricing Helper")
    expect(payload).not.toContain("Answer from the pricing page only")
    expect(payload).not.toContain("published_artifact_id")
  })

  it("uses the ordinary chat availability gate", async () => {
    const made = await setup("builder-ses-off", scripted())
    await made.meta.setOrgSettings("default", {
      ...(await made.meta.getOrgSettings("default")),
      chatBeta: false,
    })
    expect((await openBuilder(made.app, owner.email, "hi")).status).toBe(404)
  })

  it("refuses a read-only seat before the interview", async () => {
    const made = await setup("builder-ses-seat", scripted(), [owner, viewer], "viewer", viewer)
    const refused = await openBuilder(made.app, viewer.email)
    expect(refused.status).toBe(403)
    const said = ((await refused.json()) as { error: string }).error
    expect(said).toMatch(/permission to create/i)
    expect(said).toMatch(/Settings/)
    expect(said).not.toMatch(/manifest|short id|role|forbidden/i)
    expect((await openBuilder(made.app, owner.email)).status).toBe(201)
  })

  it("creates on a later turn from the exact approved draft", async () => {
    let call = 0
    const model = async (): Promise<ModelTurn> => {
      call++
      if (call === 1)
        return {
          text: "",
          costUsd: null,
          done: false,
          toolUses: [{ id: "t1", name: "draft_manifest", input: draftArgs }],
        }
      if (call === 3)
        return {
          text: "",
          costUsd: null,
          done: false,
          toolUses: [{ id: "t2", name: "create_context_from_draft", input: {} }],
        }
      return { text: "Done — it is ready.", toolUses: [], costUsd: null, done: true }
    }
    const { app, meta, ctx } = await setup("builder-ses-two-turn", model)
    const opened = await openBuilder(app, owner.email)
    const { session } = (await opened.json()) as { session: { id: string } }
    expect(await waitForAgents(meta, session.id, 1)).toHaveLength(1)

    const followed = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "Yes, create it" }),
    })
    expect(followed.status).toBe(201)
    const agents = await waitForAgents(meta, session.id, 2)
    const card = JSON.parse(agents[1]?.meta ?? "{}").card as {
      created: { context_id: string }
      published_artifact_id: string
    }
    expect(await meta.getContext(card.created.context_id)).toMatchObject({ name: "Pricing Helper" })

    const artifact = await meta.getArtifactById(card.published_artifact_id)
    const version = artifact ? await meta.getVersion(artifact.id, artifact.current_version) : null
    expect(version ? await ctx.sourceText(version) : null).toBe(
      '<!-- This document is the instruction set for the "Pricing Helper" context in Derive.\n' +
        "     Agents read it to learn what the context knows and how it should answer.\n" +
        "     Edit it like any document; the context uses the newest version. -->\n\n" +
        MANIFEST,
    )
  })
})
