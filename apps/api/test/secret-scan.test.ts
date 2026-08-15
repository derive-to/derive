import { describe, expect, it } from "vitest"
import { likelySecrets } from "../src/lib/secret-scan"

describe("template publication secret scan", () => {
  it.each([
    ["private key", "-----BEGIN PRIVATE KEY-----\nabc"],
    ["AWS key", "access_key = AKIAIOSFODNN7EXAMPLE"],
    ["database URL", "postgres://admin:correct-horse-battery@db.example/app"],
    ["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
    ["JWT", "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop"],
    ["password", "password = ultraprivatepassword123"],
  ])("flags %s", (_name, source) => {
    expect(likelySecrets(source)).not.toEqual([])
  })

  it.each([
    "api_key: {{API_KEY}}",
    "password: ${DATABASE_PASSWORD}",
    "token: <YOUR_ACCESS_TOKEN>",
    "Explain where a user should enter their password.",
    "project_id: ordinary-public-id",
  ])("allows portable placeholder/prose: %s", (source) => {
    expect(likelySecrets(source)).toEqual([])
  })
})
