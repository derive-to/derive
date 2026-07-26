import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { anonApp, app, bearer, meta, TEST_TOKEN, upload } from "./helpers"

const idOf = async (res: Response): Promise<string> => (await res.json()).short_id

const grantCommentLink = async (short: string) => {
  const res = await app.request(`/v1/artifacts/${short}/access`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...bearer(TEST_TOKEN) },
    body: JSON.stringify({ linkRole: "commenter" }),
  })
  if (res.status !== 200) throw new Error(`access patch failed: ${res.status}`)
}

const seedComment = async (short: string, threadId: string, state?: "resolved") => {
  const art = await meta.getByShortId(short)
  if (!art) throw new Error("artifact missing")
  await meta.createComment({
    id: randomUUID(),
    artifact_id: art.id,
    thread_id: threadId,
    base_version: 1,
    body_md: "hi",
    author: "amy",
  })
  if (state === "resolved") await meta.setThreadState(art.id, threadId, "resolved")
}

// The comment-nudge pill (GTM step 09): the public viewer needs an open-thread
// count to render "N comments · sign in to join", but anon never sees comment
// BODIES (collaboration, not content). So the detail response carries a single
// derived count, and only where the prompt can fire: an anonymous caller on a
// link that grants commenting.
describe("comment-nudge count", () => {
  it("anon on a can-comment link gets open_comment_count (resolved threads excluded)", async () => {
    const short = await idOf(await upload("cn.md", "# Hi", { visibility: "public", title: "CN" }))
    await grantCommentLink(short)
    await seedComment(short, "t-open-1")
    await seedComment(short, "t-open-1") // same thread — still one open thread
    await seedComment(short, "t-open-2")
    await seedComment(short, "t-done", "resolved")

    const detail = await (await anonApp.request(`/v1/artifacts/${short}`)).json()
    expect(detail.open_comment_count).toBe(2)
  })

  it("present as 0 on a can-comment link with no comments", async () => {
    const short = await idOf(await upload("cn0.md", "# Hi", { visibility: "public", title: "CN0" }))
    await grantCommentLink(short)

    const detail = await (await anonApp.request(`/v1/artifacts/${short}`)).json()
    expect(detail.open_comment_count).toBe(0)
  })

  it("absent on a view-only link — no activity leak where the prompt can't fire", async () => {
    const short = await idOf(await upload("cnv.md", "# Hi", { visibility: "public", title: "CNV" }))
    await seedComment(short, "t-open")

    const detail = await (await anonApp.request(`/v1/artifacts/${short}`)).json()
    expect(detail.link_role).toBe("viewer")
    expect(detail.open_comment_count).toBeUndefined()
  })

  it("absent for authenticated callers — they load real threads instead", async () => {
    const short = await idOf(await upload("cna.md", "# Hi", { visibility: "public", title: "CNA" }))
    await grantCommentLink(short)

    const detail = await (
      await app.request(`/v1/artifacts/${short}`, { headers: bearer(TEST_TOKEN) })
    ).json()
    expect(detail.open_comment_count).toBeUndefined()
  })
})
