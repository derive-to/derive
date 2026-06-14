import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { api, type RepoSource } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

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

export function GithubSection() {
  const [sources, setSources] = useState<RepoSource[] | null>(null)
  const load = useCallback(
    () =>
      api
        .listRepoSources()
        .then((r) => setSources(r.sources))
        .catch(() => setSources([])),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  return (
    <section>
      <p className="mb-4 text-sm text-muted-foreground">
        Mirror a GitHub repo's Markdown and HTML into a collection. Sync is one-way — GitHub stays
        the source of truth, so synced docs are read-only here but stay fully commentable. Use a
        read-only token for private repos.
      </p>

      <NewRepoSource
        onCreated={() => {
          toast.success("Repo connected — hit Sync now")
          load()
        }}
        onError={(m) => toast.error(m)}
      />

      <div className="mt-4 flex flex-col gap-2.5">
        {sources === null ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner />
          </div>
        ) : sources.length === 0 ? (
          <EmptyState>No repos connected yet. Add one above.</EmptyState>
        ) : (
          sources.map((s) => (
            <RepoSourceRow
              key={s.id}
              source={s}
              onChanged={(m) => {
                toast.success(m)
                load()
              }}
              onError={(m) => toast.error(m)}
            />
          ))
        )}
      </div>
    </section>
  )
}

function NewRepoSource({
  onCreated,
  onError,
}: {
  onCreated: () => void
  onError: (m: string) => void
}) {
  const [repo, setRepo] = useState("")
  const [ref, setRef] = useState("")
  const [includes, setIncludes] = useState("")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const valid = validRepo(repo)
  const add = async () => {
    if (!valid) return
    setBusy(true)
    try {
      await api.connectRepoSource({
        repo: repo.trim(),
        ref: ref.trim() || undefined,
        includes: includes.trim() || undefined,
        token: token.trim() || undefined,
      })
      setRepo("")
      setRef("")
      setIncludes("")
      setToken("")
      onCreated()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-testid="github-repo"
          aria-label="Repository"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/repo"
          className="min-w-[200px] flex-1 font-mono"
        />
        <Input
          data-testid="github-ref"
          aria-label="Branch"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="branch (default HEAD)"
          className="w-[170px]"
        />
        <Button
          data-testid="github-connect"
          variant="primary"
          onClick={add}
          disabled={busy || !valid}
        >
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          data-testid="github-includes"
          aria-label="Include globs"
          value={includes}
          onChange={(e) => setIncludes(e.target.value)}
          placeholder="**/*.md,**/*.html"
          className="min-w-[200px] flex-1 font-mono text-xs"
        />
        <Input
          data-testid="github-token"
          aria-label="Access token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="read-only token (private repos)"
          className="min-w-[200px] flex-1"
        />
      </div>
    </Card>
  )
}

function RepoSourceRow({
  source,
  onChanged,
  onError,
}: {
  source: RepoSource
  onChanged: (m: string) => void
  onError: (m: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const sync = async () => {
    setBusy(true)
    try {
      const r = await api.runRepoSync(source.id)
      onChanged(
        `Synced ${source.repo}: +${r.added} new · ${r.updated} updated · ${r.removed} removed · ${r.skipped} unchanged`,
      )
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    try {
      await api.deleteRepoSource(source.id)
      onChanged("Repo disconnected (docs kept)")
    } catch (e) {
      onError((e as Error).message)
    }
  }
  const status = source.last_status ?? "never synced"
  const errored = status.startsWith("error")
  return (
    <Card data-testid={`github-row-${source.id}`} className="flex items-center gap-2.5 p-3.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">
          {source.repo}
          <span className="text-muted-foreground"> · {source.ref}</span>
        </div>
        <div
          className={`mt-px truncate font-mono text-2xs ${errored ? "text-destructive" : "text-muted-foreground"}`}
        >
          {source.file_count} file{source.file_count === 1 ? "" : "s"} · {status}
        </div>
      </div>
      <Button
        data-testid={`github-sync-${source.id}`}
        variant="default"
        size="sm"
        onClick={sync}
        disabled={busy}
      >
        {busy ? "Syncing…" : "Sync now"}
      </Button>
      <Button
        data-testid={`github-remove-${source.id}`}
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={remove}
      >
        Disconnect
      </Button>
    </Card>
  )
}
