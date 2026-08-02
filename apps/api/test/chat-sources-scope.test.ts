import { describe, expect, it } from "vitest"
import { boundSources } from "../src/lib/chat-sources"

// WHO REACHES WHICH SOURCE. The declaration says WHETHER a connection is exposed to chat at
// all; the connection's SCOPE says whose chat. Declaring a personal connection must not lend
// one person's credential to the whole team — and the borrower would never know whose account
// answered, which is what makes that failure worse than a refusal.

const store = (conns: { id: string; user_id: string; scope: string }[], declared: string[]) =>
  ({
    getOrgSettings: async () => ({ chatSources: declared }),
    listConnections: async () =>
      conns.map((c) => ({ ...c, toolkit: `tk-${c.id}`, kind: "mcp", org_id: "o" })),
  }) as never

const ALICE = "u-alice"
const BOB = "u-bob"

describe("which declared sources a person reaches", () => {
  it("a WORKSPACE source reaches everyone", async () => {
    const meta = store([{ id: "c1", user_id: ALICE, scope: "workspace" }], ["c1"])
    expect((await boundSources(meta, "o", BOB)).map((s) => s.id)).toEqual(["c1"])
  })

  it("a PERSONAL source reaches only its owner, even when declared", async () => {
    // The leak this prevents: Alice connects her own Stripe, an admin declares it for chat,
    // and Bob's turn spends Alice's credential.
    const meta = store([{ id: "c1", user_id: ALICE, scope: "personal" }], ["c1"])
    expect((await boundSources(meta, "o", ALICE)).map((s) => s.id)).toEqual(["c1"])
    expect(await boundSources(meta, "o", BOB)).toEqual([])
  })

  it("an UNDECLARED source reaches nobody, whatever its scope or owner", async () => {
    const meta = store([{ id: "c1", user_id: BOB, scope: "workspace" }], [])
    expect(await boundSources(meta, "o", BOB)).toEqual([])
  })

  it("reaches nothing when there is no asker at all", async () => {
    // Belt and braces on the membership gate: chat already refuses a non-member before this
    // runs, but a null asker must never widen into "personal sources for everyone".
    const meta = store([{ id: "c1", user_id: ALICE, scope: "personal" }], ["c1"])
    expect(await boundSources(meta, "o", null)).toEqual([])
  })
})
