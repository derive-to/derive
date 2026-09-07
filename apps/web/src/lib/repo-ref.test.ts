import { describe, expect, it } from "vitest"
import { previewRepoRef } from "./repo-ref"

// The same table packages/core/src/repo-ref.test.ts pins for the server's parser: the
// preview must agree with the decision, or the form would promise what the server refuses.
describe("previewRepoRef", () => {
  const accepted: [string, string][] = [
    [
      "https://github.com/graphdeco-inria/gaussian-splatting",
      "github.com/graphdeco-inria/gaussian-splatting",
    ],
    ["https://github.com/o/r/", "github.com/o/r"],
    ["https://github.com/o/r.git", "github.com/o/r"],
    ["https://www.github.com/o/r", "github.com/o/r"],
    ["http://github.com/o/r", "github.com/o/r"],
    ["github.com/o/r", "github.com/o/r"],
    ["o/r", "github.com/o/r"],
    ["  https://github.com/o/r.  ", "github.com/o/r"],
    ["<https://github.com/o/r>", "github.com/o/r"],
    ["git@github.com:o/r.git", "github.com/o/r"],
    ["git://github.com/o/r.git", "github.com/o/r"],
    ["https://github.com/o/r?tab=readme", "github.com/o/r"],
    ["https://github.com/o/r#install", "github.com/o/r"],
    ["https://github.com/o/r/tree/dr_aa", "github.com/o/r@dr_aa"],
    ["https://github.com/o/r/tree/main/submodules/x", "github.com/o/r@main"],
    ["https://gitlab.inria.fr/bkerbl/simple-knn", "gitlab.inria.fr/bkerbl/simple-knn"],
    ["https://gitlab.com/group/sub/proj", "gitlab.com/group/sub/proj"],
    ["https://gitlab.com/group/proj/-/tree/dev", "gitlab.com/group/proj@dev"],
    ["git@gitlab.inria.fr:bkerbl/simple-knn.git", "gitlab.inria.fr/bkerbl/simple-knn"],
  ]
  it.each(accepted)("accepts %s", (input, canonical) => {
    expect(previewRepoRef(input)?.canonical).toBe(canonical)
  })

  const refused = [
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,github.com/o/r",
    "file:///etc/passwd",
    "https://github.com",
    "https://github.com/o",
    "https://user:pw@github.com/o/r",
    "https://github.com:8080/o/r",
    "https://bitbucket.org/o/r",
    "https://github.com.evil.com/o/r",
    "https://evil.com/github.com/o/r",
    "https://codeberg.org/o/r",
    "https://github.com/../r",
    "https://github.com/o/r extra",
    "https://github.com/a/b/c",
  ]
  it.each(refused)("refuses %s", (input) => {
    expect(previewRepoRef(input)).toBeNull()
  })

  it("gives the link the console opens", () => {
    expect(previewRepoRef("git@github.com:o/r.git")?.webUrl).toBe("https://github.com/o/r")
    expect(previewRepoRef("https://github.com/o/r/tree/dev")?.webUrl).toBe(
      "https://github.com/o/r/tree/dev",
    )
    expect(previewRepoRef("https://gitlab.inria.fr/bkerbl/simple-knn.git")?.webUrl).toBe(
      "https://gitlab.inria.fr/bkerbl/simple-knn",
    )
  })
})
