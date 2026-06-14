import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Sharing an artifact with someone should land in their notification bell, the
// same way an @mention does. A share has no comment thread, so the thread/comment
// ids are empty and the bell deep-links to the artifact itself.
describe("artifact share → notification", () => {
  const alice: TestUser = { id: "u_sh_alice", email: "sha@dock.test", name: "Alice" }
  const bob: TestUser = { id: "u_sh_bob", email: "shb@dock.test", name: "Bob" }
  const { app } = makeAuthedApp("share-notif", [alice, bob], "editor")
  let shortId: string

  const share = (email: string, role: string, by: string) =>
    app.request(`/v1/artifacts/${shortId}/members`, {
      ...jsonAs(as(by), { email, role }),
      method: "PUT",
    })

  it("notifies the person an artifact is shared with", async () => {
    shortId = (await (await publishAs(app, "<h1>doc</h1>", {}, as(alice.email))).json()).short_id
    expect((await share(bob.email, "viewer", alice.email)).status).toBe(201)

    const bobN = await (await app.request("/v1/notifications", { headers: as(bob.email) })).json()
    expect(bobN.unread).toBe(1)
    expect(bobN.notifications[0]).toMatchObject({
      kind: "share",
      actor: "Alice",
      artifact_short_id: shortId,
      thread_id: "",
      comment_id: "",
      read: 0,
    })
    expect(bobN.notifications[0].preview).toContain("viewer")
  })

  it("does not notify when you share with yourself", async () => {
    expect((await share(alice.email, "editor", alice.email)).status).toBe(201)
    const aliceN = await (
      await app.request("/v1/notifications", { headers: as(alice.email) })
    ).json()
    expect(aliceN.unread).toBe(0)
  })
})
