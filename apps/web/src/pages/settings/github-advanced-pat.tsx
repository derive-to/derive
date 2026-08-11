import { useState } from "react"
import { api } from "@/api"
import { fieldError } from "@/components/shared/field-error"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApiMutation } from "@/lib/use-api-mutation"

// "owner/name", tolerating a github.com URL or a trailing .git (mirrors the
// server's parseRepo) — gates the Connect button so we don't POST junk.
const validRepo = (raw: string): boolean =>
  /^[\w.-]+\/[\w.-]+$/.test(
    raw
      .trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, ""),
  )

// Advanced: paste a read-only PAT (or connect a public repo) without the App.
// Collapsed by default so it doesn't compete with the App flow.
export function AdvancedPat({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [repo, setRepo] = useState("")
  const [ref, setRef] = useState("")
  const [includes, setIncludes] = useState("")
  const [token, setToken] = useState("")
  const valid = validRepo(repo)
  const repoField = fieldError(
    "github-repo-error",
    repo.trim() && !valid ? "Use owner/repo — e.g. acme/docs (a github.com URL works too)." : null,
  )
  const connect = useApiMutation({
    mutationFn: () =>
      api.connectRepoSource({
        repo: repo.trim(),
        ref: ref.trim() || undefined,
        includes: includes.trim() || undefined,
        token: token.trim() || undefined,
      }),
    success: "Repo connected — syncing",
    onSuccess: () => {
      setRepo("")
      setRef("")
      setIncludes("")
      setToken("")
      onCreated()
    },
  })
  const add = () => {
    if (valid) connect.mutate()
  }
  return (
    <div>
      <Button
        variant="link"
        data-testid="github-advanced-toggle"
        className="h-auto p-0 font-normal text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide advanced" : "Advanced: connect with a token or a public repo…"}
      </Button>
      {open && (
        <Card className="mt-2 gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            For a private repo without the GitHub App, paste a read-only token. Public repos need no
            token.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-testid="github-repo"
              aria-label="Repository"
              {...repoField.aria}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
              className="min-w-50 flex-1 font-mono"
            />
            <Input
              data-testid="github-ref"
              aria-label="Branch"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="branch (default HEAD)"
              className="w-42.5"
            />
            <Button
              data-testid="github-connect"
              variant="secondary"
              size="sm"
              onClick={add}
              loading={connect.isPending}
              disabled={connect.isPending || !valid}
            >
              {connect.isPending ? "Connecting…" : "Connect"}
            </Button>
          </div>
          {repoField.node}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-testid="github-includes"
              aria-label="Include globs"
              value={includes}
              onChange={(e) => setIncludes(e.target.value)}
              placeholder="**/*.md,**/*.html"
              className="min-w-50 flex-1 font-mono"
            />
            <Input
              data-testid="github-token"
              aria-label="Access token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="read-only token (private repos)"
              className="min-w-50 flex-1"
            />
          </div>
        </Card>
      )}
    </div>
  )
}
