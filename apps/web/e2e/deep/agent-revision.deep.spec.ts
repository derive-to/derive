import { Buffer } from "node:buffer"
import type { APIRequestContext, Page } from "@playwright/test"
import { expect, publishArtifact, test } from "../fixtures"

// The agent-native moat, end to end: a human hands a scoped change to a registered
// agent from a text selection; the request lands as an @mention the agent reads from
// its MCP pull inbox; the agent proposes a revision citing the thread; the request
// card walks its lifecycle (awaiting → revision ready → applied) as the proposal is
// created and approved. Drives the real UI for the human side and the real agent
// token/API for the agent side, so the whole loop is covered — not a mock.

// Register an agent in the owner's workspace; returns its bearer token + id.
async function createAgent(
  req: APIRequestContext,
  name: string,
): Promise<{ id: string; token: string }> {
  const res = await req.post("/v1/agents", { data: { name, role: "editor" } })
  expect(res.ok(), `create agent failed: ${res.status()}`).toBeTruthy()
  const j = (await res.json()) as { id: string; token: string }
  return { id: j.id, token: j.token }
}

// The agent proposes a new version citing the thread it addresses — the same
// multipart path the MCP `propose` tool takes, authed by the agent's token.
async function agentPropose(
  req: APIRequestContext,
  token: string,
  shortId: string,
  body: string,
  addressesThreadId: string,
): Promise<string> {
  const res = await req.post(`/v1/artifacts/${shortId}/proposals`, {
    headers: { authorization: `Bearer ${token}` },
    multipart: {
      file: { name: "doc.md", mimeType: "text/markdown", buffer: Buffer.from(body) },
      message: "Tightened the selected paragraph",
      addresses: addressesThreadId,
    },
  })
  expect(res.ok(), `agent propose failed: ${res.status()}`).toBeTruthy()
  return ((await res.json()) as { id: string }).id
}

async function approve(req: APIRequestContext, shortId: string, proposalId: string): Promise<void> {
  const res = await req.post(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
    data: {},
  })
  expect(res.ok(), `approve failed: ${res.status()}`).toBeTruthy()
}

// The thread_id of the newest comment on the artifact (the request we just posted).
async function latestThreadId(req: APIRequestContext, shortId: string): Promise<string> {
  const res = await req.get(`/v1/artifacts/${shortId}/comments`)
  const { comments } = (await res.json()) as { comments: { thread_id: string; body_md: string }[] }
  const last = comments.at(-1)
  expect(last, "expected a comment to exist").toBeTruthy()
  return (last as { thread_id: string }).thread_id
}

test.describe("agent revision requests — the select→agent→propose→review loop", () => {
  test("ask an agent to revise a selection, then watch the request go awaiting → ready → applied", async ({
    owner,
  }) => {
    const agent = await createAgent(owner.request, "Reviser")
    const shortId = await publishArtifact(
      owner,
      "doc.md",
      "# Title\n\nA paragraph that could be tightened up quite a bit.",
    )

    // --- Human side (real UI): select text in the render → the desktop pill appears --
    const page: Page = owner
    await page.goto(`/artifacts/doc-${shortId}`)
    const frame = page.frameLocator("iframe")
    await expect(frame.getByText(/could be tightened/)).toBeVisible()
    // Programmatically select the paragraph's text inside the sandboxed frame and fire
    // mouseup — the exact path the anchor client turns into a `select` message, so the
    // host floats its selection pill (Comment · Ask an agent).
    const renderFrame = page.frames().find((f) => f.url().includes("/raw/"))
    if (!renderFrame) throw new Error("render frame not found")
    await renderFrame.evaluate(() => {
      const p = document.querySelector("p")
      if (!p) throw new Error("no paragraph")
      const range = document.createRange()
      range.selectNodeContents(p)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    })
    // The selection pill surfaces both actions; hand the selection to the agent.
    await expect(page.getByTestId("ask-agent")).toBeVisible({ timeout: 10_000 })
    await page.getByTestId("ask-agent").click()

    // The composer opens in request mode, pre-addressed to the agent. Send it.
    await expect(page.getByTestId("agent-request-composer")).toBeVisible()
    const input = page.getByTestId("composer-input")
    await expect(input).toHaveValue(/@Reviser/)
    await input.fill("@Reviser tighten this paragraph")
    await page.getByTestId("composer-submit").click()

    // The request posts and its card shows the "awaiting revision" stage.
    await expect(page.getByTestId("agent-request-requested")).toBeVisible({ timeout: 10_000 })

    // --- Agent side (real token + API): read context, propose citing the thread ------
    const threadId = await latestThreadId(owner.request, shortId)
    // (The mention is in the agent's pull inbox; here we drive the propose directly,
    // the same call the agent would make after reading it.)
    const proposalId = await agentPropose(
      owner.request,
      agent.token,
      shortId,
      "# Title\n\nA tighter paragraph.",
      threadId,
    )

    // The request flips to "revision ready" once the proposal cites it, with a direct
    // Review button that opens the review overlay — the loop closed in one click.
    await expect(page.getByTestId("agent-request-ready")).toBeVisible({ timeout: 10_000 })
    await page.getByTestId("agent-request-review").click()
    await expect(page.getByTestId("review-close")).toBeVisible({ timeout: 10_000 })
    await page.getByTestId("review-close").click()

    // --- Approve → the request resolves and reads "applied" -------------------------
    await approve(owner.request, shortId, proposalId)
    // An applied request is done, so it files into the collapsed "Resolved" drawer —
    // expand it to see the final "revision applied" stage on the card.
    await expect(page.getByRole("button", { name: /Resolved \(\d+\)/ })).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole("button", { name: /Resolved \(\d+\)/ }).click()
    await expect(page.getByTestId("agent-request-applied")).toBeVisible({ timeout: 10_000 })
  })
})
