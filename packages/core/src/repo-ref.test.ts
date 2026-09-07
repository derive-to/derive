import { describe, expect, it } from "vitest"
import { parseGitmodules, parseRepoRef, type RepoRef, repoArchiveUrl, repoWebUrl } from "./repo-ref"

describe("parseRepoRef", () => {
  const accepted: [string, string][] = [
    [
      "https://github.com/graphdeco-inria/gaussian-splatting",
      "github.com/graphdeco-inria/gaussian-splatting",
    ],
    [
      "https://github.com/graphdeco-inria/gaussian-splatting/",
      "github.com/graphdeco-inria/gaussian-splatting",
    ],
    [
      "https://github.com/graphdeco-inria/gaussian-splatting.git",
      "github.com/graphdeco-inria/gaussian-splatting",
    ],
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
    ["https://github.com/o/r/tree/v1.2.3", "github.com/o/r@v1.2.3"],
    // A link into a subdirectory keeps the branch and drops the path.
    ["https://github.com/o/r/tree/main/submodules/x", "github.com/o/r@main"],
    ["https://gitlab.inria.fr/bkerbl/simple-knn", "gitlab.inria.fr/bkerbl/simple-knn"],
    ["https://gitlab.inria.fr/bkerbl/simple-knn.git", "gitlab.inria.fr/bkerbl/simple-knn"],
    ["https://gitlab.com/group/sub/proj", "gitlab.com/group/sub/proj"],
    ["https://gitlab.com/group/proj/-/tree/dev", "gitlab.com/group/proj@dev"],
    ["git@gitlab.inria.fr:bkerbl/simple-knn.git", "gitlab.inria.fr/bkerbl/simple-knn"],
  ]
  it.each(accepted)("accepts %s", (input, canonical) => {
    expect(parseRepoRef(input)?.canonical).toBe(canonical)
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
    // Not GitHub, and no `gitlab` label: reported as an unsupported host, never guessed at.
    "https://bitbucket.org/o/r",
    "https://github.com.evil.com/o/r",
    "https://evil.com/github.com/o/r",
    "https://codeberg.org/o/r",
    "https://github.com/../r",
    "https://github.com/o/../../etc",
    "https://github.com/o/r extra",
    // A group path is a GitLab shape; GitHub is always exactly owner/repo.
    "https://github.com/a/b/c",
  ]
  it.each(refused)("refuses %s", (input) => {
    expect(parseRepoRef(input)).toBeNull()
  })

  it("resolves a traversal to a plain path rather than following it", () => {
    // URL parsing collapses `..` before the grammar sees it, so what is left is an
    // ordinary project path on the same host, never an escape from it.
    const ref = parseRepoRef("https://gitlab.com/group/proj/-/tree/../../evil") as RepoRef
    expect(ref.origin).toBe("https://gitlab.com")
    expect(ref.canonical).toBe("gitlab.com/group/proj/evil")
  })

  it("pins the host, owner and project a link named", () => {
    const ref = parseRepoRef("https://gitlab.inria.fr/bkerbl/simple-knn") as RepoRef
    expect(ref.host).toBe("gitlab")
    expect(ref.origin).toBe("https://gitlab.inria.fr")
    expect(ref.owner).toBe("bkerbl")
    expect(ref.name).toBe("simple-knn")
    expect(ref.ref).toBeNull()
  })
})

describe("repoArchiveUrl", () => {
  const url = (input: string) => repoArchiveUrl(parseRepoRef(input) as RepoRef)

  it("asks GitHub for the default branch without naming it", () => {
    expect(url("https://github.com/o/r")).toBe("https://codeload.github.com/o/r/tar.gz/HEAD")
  })
  it("asks GitHub for the branch a link pinned", () => {
    expect(url("https://github.com/o/r/tree/dr_aa")).toBe(
      "https://codeload.github.com/o/r/tar.gz/dr_aa",
    )
  })
  it("asks a GitLab, self-hosted or not, for its archive", () => {
    expect(url("https://gitlab.inria.fr/bkerbl/simple-knn")).toBe(
      "https://gitlab.inria.fr/bkerbl/simple-knn/-/archive/HEAD/simple-knn-HEAD.tar.gz",
    )
    expect(url("https://gitlab.com/group/sub/proj/-/tree/dev")).toBe(
      "https://gitlab.com/group/sub/proj/-/archive/dev/proj-dev.tar.gz",
    )
  })
  it("sends a person to the repository's own page", () => {
    expect(repoWebUrl(parseRepoRef("git@github.com:o/r.git") as RepoRef)).toBe(
      "https://github.com/o/r",
    )
    expect(repoWebUrl(parseRepoRef("https://github.com/o/r/tree/dev") as RepoRef)).toBe(
      "https://github.com/o/r/tree/dev",
    )
  })
})

describe("parseGitmodules", () => {
  const parent = parseRepoRef("https://github.com/graphdeco-inria/gaussian-splatting") as RepoRef

  it("reads the paths, urls and branches a repository declares", () => {
    const subs = parseGitmodules(
      `[submodule "submodules/diff-gaussian-rasterization"]
	path = submodules/diff-gaussian-rasterization
	url = https://github.com/graphdeco-inria/diff-gaussian-rasterization
	branch = dr_aa
[submodule "submodules/simple-knn"]
	path = submodules/simple-knn
	url = https://gitlab.inria.fr/bkerbl/simple-knn.git
`,
      parent,
    )
    expect(subs).toEqual([
      {
        path: "submodules/diff-gaussian-rasterization",
        url: "https://github.com/graphdeco-inria/diff-gaussian-rasterization",
        branch: "dr_aa",
      },
      {
        path: "submodules/simple-knn",
        url: "https://gitlab.inria.fr/bkerbl/simple-knn.git",
        branch: null,
      },
    ])
  })

  it("resolves a relative url against the repository it sits in", () => {
    const subs = parseGitmodules(
      '[submodule "x"]\n path = vendor/x\n url = ../sibling.git\n',
      parent,
    )
    expect(subs[0]?.url).toBe("https://github.com/graphdeco-inria/sibling.git")
    expect(parseRepoRef(subs[0]?.url ?? "")?.canonical).toBe("github.com/graphdeco-inria/sibling")
  })

  it("keeps an unsupported url verbatim, so the notes can name it", () => {
    const subs = parseGitmodules(
      '[submodule "x"]\n path = vendor/x\n url = https://bitbucket.org/o/r.git\n',
    )
    expect(subs[0]?.url).toBe("https://bitbucket.org/o/r.git")
    expect(parseRepoRef(subs[0]?.url ?? "")).toBeNull()
  })

  it("drops an entry that would escape the tree it is placed in", () => {
    expect(
      parseGitmodules('[submodule "x"]\n path = ../../etc\n url = https://github.com/o/r\n'),
    ).toEqual([])
    expect(parseGitmodules('[submodule "x"]\n url = https://github.com/o/r\n')).toEqual([])
  })

  it("ignores comments and anything outside a submodule block", () => {
    expect(
      parseGitmodules('# a comment\npath = loose\n[submodule "x"]\n path = a\n url = u\n'),
    ).toEqual([{ path: "a", url: "u", branch: null }])
  })
})
