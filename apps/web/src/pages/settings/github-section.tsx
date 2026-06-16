import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import {
  api,
  type GithubSyncStatus,
  type InstallationRepo,
  type RepoSource,
  type SyncPreview,
} from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ago } from "@/lib/time"

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

// Read (and clear) the one-shot query params the App install flow lands back on.
const takeInstallParams = (): { install?: string; error?: string } => {
  if (typeof window === "undefined") return {}
  const qs = new URLSearchParams(window.location.search)
  const install = qs.get("gh_install") ?? undefined
  const error = qs.get("gh_error") ?? undefined
  if (install || error) {
    qs.delete("gh_install")
    qs.delete("gh_error")
    const rest = qs.toString()
    window.history.replaceState({}, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`)
  }
  return { install, error }
}

export function GithubSection() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<GithubSyncStatus | null>(null)
  const [pickerInstall, setPickerInstall] = useState<string | null>(null)

  const load = useCallback(
    () =>
      api
        .githubSync()
        .then(setStatus)
        .catch(() => setStatus({ sources: [], app: { configured: false }, installations: [] })),
    [],
  )
  // After a sync/connect, the mirrored collection changed → drop the library's
  // artifact caches so a freshly-populated collection isn't shown stale/empty.
  const refresh = useCallback(() => {
    load()
    qc.invalidateQueries({ queryKey: ["artifacts"] })
  }, [load, qc])
  useEffect(() => {
    load()
  }, [load])

  // After the GitHub redirect (?gh_install / ?gh_error), open the picker or toast.
  useEffect(() => {
    const { install, error } = takeInstallParams()
    if (error) toast.error(error === "install_expired" ? "Install link expired" : "Install failed")
    if (install) setPickerInstall(install)
  }, [])

  const appConfigured = status?.app.configured ?? false

  return (
    <section>
      <p className="mb-4 text-sm text-muted-foreground">
        Mirror a GitHub repo's Markdown and HTML into a collection. Sync is one-way: GitHub stays
        the source of truth, so synced docs are read-only here but stay fully commentable.
      </p>

      {status === null ? (
        <div className="flex h-20 items-center justify-center">
          <Spinner />
        </div>
      ) : appConfigured ? (
        <ConnectViaApp status={status} onPick={setPickerInstall} onError={(m) => toast.error(m)} />
      ) : (
        <SetUpApp />
      )}

      <div className="mt-4 flex flex-col gap-2.5">
        {status !== null &&
          (status.sources.length === 0 ? (
            <EmptyState>No repos connected yet. Add one above.</EmptyState>
          ) : (
            status.sources.map((s) => (
              <RepoSourceRow
                key={s.id}
                source={s}
                onChanged={(m) => {
                  toast.success(m)
                  refresh()
                }}
                onError={(m) => toast.error(m)}
              />
            ))
          ))}
      </div>

      {/* The PAT path stays available as an advanced fallback (self-host without a
          GitHub App, or a one-off public repo). */}
      <AdvancedPat
        onCreated={() => {
          toast.success("Repo connected — hit Sync now")
          load()
        }}
        onError={(m) => toast.error(m)}
      />

      {pickerInstall && (
        <RepoPicker
          installationId={pickerInstall}
          onClose={() => setPickerInstall(null)}
          onConnected={() => {
            setPickerInstall(null)
            toast.success("Repo connected — syncing")
            refresh()
          }}
          onError={(m) => toast.error(m)}
        />
      )}
    </section>
  )
}

// No App yet: one button that kicks off the manifest flow (a top-level nav, since
// it posts a form to GitHub).
function SetUpApp() {
  return (
    <Card className="flex flex-col items-start gap-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">Connect GitHub</div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Create a read-only GitHub App for this instance, then install it on the repos you want to
          mirror. No tokens to paste, and pushes sync automatically.
        </p>
      </div>
      <Button variant="primary" asChild>
        <a href="/settings/github/app/new">Set up GitHub App</a>
      </Button>
    </Card>
  )
}

// App is set up: install on (more) repos, or pick from an existing installation.
function ConnectViaApp({
  status,
  onPick,
  onError,
}: {
  status: GithubSyncStatus
  onPick: (installationId: string) => void
  onError: (m: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const install = async () => {
    setBusy(true)
    try {
      const { url } = await api.githubInstallUrl()
      window.location.href = url
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }
  const installed = status.installations.length > 0
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-500" aria-hidden />
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">GitHub connected</div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {installed
              ? "Pick the repositories to mirror — or install Dock on more accounts."
              : "Last step is on GitHub: install Dock on the repositories you want to mirror, then pick them."}
          </p>
        </div>
        <Button
          data-testid="github-install"
          variant={installed ? "outline" : "primary"}
          onClick={install}
          disabled={busy}
        >
          {busy ? "Opening GitHub…" : installed ? "Install on more" : "Install on GitHub"}
        </Button>
      </div>
      {installed && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">Pick repositories:</span>
          {status.installations.map((i) => (
            <Button
              key={i.installation_id}
              variant="primary"
              size="sm"
              onClick={() => onPick(i.installation_id)}
            >
              {i.account_login ? `${i.account_login} →` : "Choose repos →"}
            </Button>
          ))}
        </div>
      )}
      <div className="border-t border-border pt-2">
        <a
          href="/settings/github/app/new"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Replace GitHub App
        </a>
      </div>
    </Card>
  )
}

// Build the include-globs string from the content-type toggle + optional folder.
const buildIncludes = (md: boolean, html: boolean, folder: string): string => {
  const exts = [...(md ? ["md"] : []), ...(html ? ["html"] : [])]
  if (exts.length === 0) return ""
  const dir = folder.trim().replace(/^\/+|\/+$/g, "")
  const prefix = dir ? `${dir}/**/` : "**/"
  return exts.map((e) => `${prefix}*.${e}`).join(",")
}

// The repo picker: choose ONE repo, scope what to mirror (type + folder), see a
// live count, then connect. Sync runs afterward in the row (with progress).
function RepoPicker({
  installationId,
  onClose,
  onConnected,
  onError,
}: {
  installationId: string
  onClose: () => void
  onConnected: () => void
  onError: (m: string) => void
}) {
  const [repos, setRepos] = useState<InstallationRepo[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [md, setMd] = useState(true)
  const [html, setHtml] = useState(true)
  const [folder, setFolder] = useState("")
  const [preview, setPreview] = useState<SyncPreview | "loading" | null>(null)
  const [busy, setBusy] = useState(false)
  const includes = buildIncludes(md, html, folder)

  useEffect(() => {
    api
      .listInstallationRepos(installationId)
      .then((r) => setRepos(r.repos))
      .catch((e) => {
        onError((e as Error).message)
        setRepos([])
      })
  }, [installationId, onError])

  // Live preview count, debounced on repo/scope change.
  useEffect(() => {
    if (!repo || !includes) {
      setPreview(null)
      return
    }
    setPreview("loading")
    const t = setTimeout(() => {
      api
        .previewRepo(installationId, repo, includes)
        .then((p) => setPreview(p))
        .catch(() => setPreview(null))
    }, 350)
    return () => clearTimeout(t)
  }, [installationId, repo, includes])

  const connect = async () => {
    if (!repo || !includes) return
    setBusy(true)
    try {
      // Connect only — the row auto-syncs in batches with a progress bar.
      await api.connectRepoSource({ repo, installation_id: installationId, includes })
      onConnected()
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mirror a repository</DialogTitle>
          <DialogDescription>
            Pick a repo and what to pull in. GitHub stays the source of truth.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[34vh] overflow-y-auto">
          {repos === null ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner />
            </div>
          ) : repos.length === 0 ? (
            <EmptyState>This installation has no repositories Dock can read.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-1">
              {repos.map((r) => (
                <li key={r.full_name}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
                    <input
                      type="radio"
                      name="gh-repo"
                      checked={repo === r.full_name}
                      onChange={() => setRepo(r.full_name)}
                    />
                    <span className="font-mono text-xs text-foreground">{r.full_name}</span>
                    {r.private && (
                      <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                        private
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        {repo && (
          <div className="mt-1 flex flex-col gap-2.5 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground">Include:</span>
              <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input type="checkbox" checked={md} onChange={(e) => setMd(e.target.checked)} />{" "}
                Markdown
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input type="checkbox" checked={html} onChange={(e) => setHtml(e.target.checked)} />{" "}
                HTML
              </label>
            </div>
            <Input
              aria-label="Folder to scope to"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="folder (optional, e.g. docs) — blank = whole repo"
              className="font-mono text-xs"
            />
            <div className="text-xs text-muted-foreground" data-testid="github-preview">
              {!includes ? (
                <span className="text-destructive">Pick at least one file type.</span>
              ) : preview === "loading" ? (
                "Counting…"
              ) : preview ? (
                <>
                  <span className="font-semibold text-foreground">
                    {preview.total} file{preview.total === 1 ? "" : "s"}
                  </span>{" "}
                  · {preview.md} MD · {preview.html} HTML
                  {preview.truncated && " · (repo is large; some files not counted)"}
                </>
              ) : (
                " "
              )}
            </div>
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={connect}
            disabled={busy || !repo || !includes}
            data-testid="github-picker-connect"
          >
            {busy ? "Connecting…" : "Connect & sync"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // Drive the sync in bounded batches: call run repeatedly until nothing remains,
  // surfacing a live "done/total" so a large repo shows progress instead of hanging.
  const sync = useCallback(async () => {
    setBusy(true)
    let done = 0
    let total = 0
    try {
      for (;;) {
        const r = await api.runRepoSync(source.id)
        done += r.added + r.updated + r.skipped + r.renamed
        if (total === 0) total = done + r.remaining
        setProgress({ done: Math.min(done, total), total })
        if (r.remaining === 0) break
      }
      onChanged(`Synced ${source.repo}: ${total} doc${total === 1 ? "" : "s"}`)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [source.id, source.repo, onChanged, onError])

  // Auto-start the first sync when a freshly-connected repo appears. Run once on
  // mount only — re-running on every sync()/last_synced_at change would loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional run-once
  useEffect(() => {
    if (!source.last_synced_at) sync()
  }, [])

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
  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <Card data-testid={`github-row-${source.id}`} className="flex items-center gap-2.5 p-3.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">
          {source.repo}
          <span className="text-muted-foreground"> · {source.ref}</span>
          {source.installation_id && <span className="text-muted-foreground"> · app</span>}
        </div>
        {progress ? (
          <div
            className="mt-1 flex items-center gap-2"
            data-testid={`github-progress-${source.id}`}
          >
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {progress.done}/{progress.total}
            </span>
          </div>
        ) : (
          <div
            className={`mt-px truncate font-mono text-2xs ${errored ? "text-destructive" : "text-muted-foreground"}`}
          >
            {source.file_count} doc{source.file_count === 1 ? "" : "s"} · {status}
            {source.last_synced_at && ` · synced ${ago(source.last_synced_at)}`}
          </div>
        )}
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

// Advanced: paste a read-only PAT (or connect a public repo) without the App.
// Collapsed by default so it doesn't compete with the App flow.
function AdvancedPat({
  onCreated,
  onError,
}: {
  onCreated: () => void
  onError: (m: string) => void
}) {
  const [open, setOpen] = useState(false)
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
    <div className="mt-4">
      <Button variant="link" className="h-auto p-0 text-xs" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide advanced" : "Advanced: connect with a token or a public repo"}
      </Button>
      {open && (
        <Card className="mt-2 p-4">
          <p className="mb-3 text-xs text-muted-foreground">
            For a private repo without the GitHub App, paste a read-only token. Public repos need no
            token.
          </p>
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
      )}
    </div>
  )
}
