import { describe, expect, it } from "vitest"
import { parseLastCommit } from "../src/lib/github"

// The Commits API response carries the date under commit.committer, the raw git author
// under commit.author (always present), and the resolved GitHub account under the
// TOP-LEVEL author (null when GitHub can't map the commit email). parseLastCommit pulls
// all three into one { date, author } without a network round-trip.
describe("parseLastCommit", () => {
  it("extracts date + full author when GitHub mapped the commit to an account", () => {
    const { date, author } = parseLastCommit([
      {
        commit: {
          committer: { date: "2025-03-04T05:06:07Z" },
          author: { name: "Ada Lovelace", email: "ada@example.com" },
        },
        author: { login: "ada", id: 4242, avatar_url: "https://avatars/ada.png" },
      },
    ])
    expect(date).toBe("2025-03-04T05:06:07Z")
    expect(author).toEqual({
      login: "ada",
      ghId: "4242", // numeric id stringified (matches account.accountId)
      name: "Ada Lovelace",
      email: "ada@example.com",
      avatar: "https://avatars/ada.png",
    })
  })

  it("falls back to the git author name/email when the top-level account is null", () => {
    const { date, author } = parseLastCommit([
      {
        commit: {
          committer: { date: "2024-01-01T00:00:00Z" },
          author: { name: "Grace Hopper", email: "grace@example.com" },
        },
        author: null, // GitHub couldn't map the email → no account
      },
    ])
    expect(date).toBe("2024-01-01T00:00:00Z")
    expect(author).toEqual({
      login: null,
      ghId: null,
      name: "Grace Hopper",
      email: "grace@example.com",
      avatar: null,
    })
  })

  it("returns a null author when there's no identity at all (date may still resolve)", () => {
    const { date, author } = parseLastCommit([
      { commit: { committer: { date: "2023-12-31T23:59:59Z" } } },
    ])
    expect(date).toBe("2023-12-31T23:59:59Z")
    expect(author).toBeNull()
  })

  it("returns nulls for an empty / missing history", () => {
    expect(parseLastCommit([])).toEqual({ date: null, author: null })
    expect(parseLastCommit(null)).toEqual({ date: null, author: null })
    expect(parseLastCommit(undefined)).toEqual({ date: null, author: null })
  })
})
