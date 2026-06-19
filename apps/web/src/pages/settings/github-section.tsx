import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AlertTriangle, CheckCircle2, ExternalLink, GitPullRequest, Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  api,
  type GithubSyncStatus,
  type InstallationRepo,
  type PrPreview,
  parseProgress,
  type RepoSource,
  type SyncPreview,
  type SyncProgress,
  type SyncStatus,
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
        .catch(() =>
          setStatus({ sources: [], prs: [], app: { configured: false }, installations: [] }),
        ),
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
        <ConnectViaApp
          status={status}
          onPick={setPickerInstall}
          onError={(m) => toast.error(m)}
          onRefresh={load}
        />
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

      {/* PR previews — read-only mirrors of the docs an OPEN pull request changes,
          each in its own "PR #<n>" collection. Created automatically as PRs open; they
          disappear when the PR closes/merges. Review the plan in Dock during the PR. */}
      {status !== null && status.prs.length > 0 && (
        <div className="mt-6">
          <div className="text-xs font-semibold text-foreground">Pull request previews</div>
          <p className="mt-0.5 mb-2 text-2xs text-muted-foreground">
            Open PRs that change docs appear here while they're open. Review them in Dock; on merge
            they fold into the collection above.
          </p>
          <div className="flex flex-col gap-2.5">
            {status.prs.map((pr) => (
              <PrPreviewRow key={pr.id} pr={pr} />
            ))}
          </div>
        </div>
      )}

      {/* The PAT path stays available as an advanced fallback (self-host without a
          GitHub App, or a one-off public repo). */}
      <AdvancedPat
        onCreated={() => {
          toast.success("Repo connected — syncing")
          refresh()
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
      <Button variant="primary" asChild data-testid="github-setup-app">
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
  onRefresh,
}: {
  status: GithubSyncStatus
  onPick: (installationId: string) => void
  onError: (m: string) => void
  onRefresh: () => void
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
  // On mount (and whenever installations list is empty), fetch from GitHub and seed
  // any existing installations the DB might be missing — covers the recovery case
  // where rows were lost without a full GitHub re-install.
  useEffect(() => {
    if (status.installations.length > 0) return
    api
      .resyncInstallations()
      .then(({ synced }) => {
        if (synced > 0) onRefresh()
      })
      .catch(() => {
        // silent — the Install button is still available as fallback
      })
  }, [status.installations.length, onRefresh])
  const installed = status.installations.length > 0
  const slug = "app" in status && (status.app as { slug?: string }).slug
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">GitHub App connected</div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {installed
              ? "Pick the repositories to mirror — or install Dock on more accounts."
              : "Last step: install Dock on the repos you want to mirror, then pick them here."}
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
              data-testid="github-pick-installation"
              variant="primary"
              size="sm"
              onClick={() => onPick(i.installation_id)}
            >
              {i.account_login ? `${i.account_login} →` : "Choose repos →"}
            </Button>
          ))}
        </div>
      )}
      {slug && (
        <div className="flex items-center gap-1.5 border-t border-border pt-2">
          <a
            href={`https://github.com/settings/apps/${slug}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            data-testid="github-app-settings-link"
          >
            Manage App on GitHub
            <ExternalLink className="size-3" aria-hidden />
          </a>
          <span className="text-xs text-muted-foreground">
            — update permissions, webhooks, or uninstall
          </span>
        </div>
      )}
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
                      data-testid="github-repo-radio"
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
                <input
                  type="checkbox"
                  data-testid="github-include-md"
                  checked={md}
                  onChange={(e) => setMd(e.target.checked)}
                />{" "}
                Markdown
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid="github-include-html"
                  checked={html}
                  onChange={(e) => setHtml(e.target.checked)}
                />{" "}
                HTML
              </label>
            </div>
            <Input
              aria-label="Folder to scope to"
              data-testid="github-folder"
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
          <Button variant="ghost" data-testid="github-cancel" onClick={onClose} disabled={busy}>
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

// Exact, human wording for each phase. The user wants zero guessing about what's
// happening, so every state is spelled out — headline + a detail line.
const phaseHeadline = (p: SyncProgress, repo: string): string => {
  switch (p.phase) {
    case "queued":
      return "Starting on our servers…"
    case "listing":
      return "Connecting to GitHub, listing files…"
    case "mirroring":
      return p.total > 0 ? `Mirroring ${repo}` : "Mirroring files…"
    case "done":
      return "Sync complete"
    case "error":
      return "Sync failed"
  }
}
const phaseDetail = (p: SyncProgress): string => {
  switch (p.phase) {
    case "queued":
      return "Queued — the server is picking this up"
    case "listing":
      return "Scanning the repository tree"
    case "mirroring":
      return p.total > 0 ? `${p.done} of ${p.total} files mirrored` : "Fetching the file list…"
    case "done":
      return `${p.total || p.done} doc${(p.total || p.done) === 1 ? "" : "s"} mirrored`
    case "error":
      return p.message ?? "Unknown error"
  }
}

// One PR preview row: a pull-request glyph, the PR title (the "PR #n:" prefix the API
// adds is dropped — the number rides the GitHub link), the repo + sync state, then a
// subtle link out to the PR and the primary "View" into the mirrored collection.
function PrPreviewRow({ pr }: { pr: PrPreview }) {
  const prog = parseProgress(pr.progress)
  const active =
    prog?.phase === "queued" || prog?.phase === "listing" || prog?.phase === "mirroring"
  // The API titles a preview "PR #<n>: <title>"; show just the <title> here.
  const label = pr.title.replace(/^PR #\d+:\s*/, "") || pr.title
  return (
    <Card data-testid={`github-pr-${pr.pr_number}`} className="flex items-center gap-3 p-3.5">
      <GitPullRequest className="size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{label}</div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-2xs text-muted-foreground">
          <a
            data-testid={`github-pr-link-${pr.pr_number}`}
            href={`https://github.com/${pr.repo}/pull/${pr.pr_number}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline"
          >
            #{pr.pr_number}
            <ExternalLink className="size-2.5" aria-hidden />
          </a>
          <span aria-hidden>·</span>
          <span className="truncate">{pr.repo}</span>
          <span aria-hidden>·</span>
          {active ? (
            <span className="inline-flex items-center gap-1 text-primary">
              <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
              syncing…
            </span>
          ) : (
            <span>
              {pr.file_count} doc{pr.file_count === 1 ? "" : "s"}
              {pr.last_synced_at ? ` · synced ${ago(pr.last_synced_at)}` : ""}
            </span>
          )}
        </div>
      </div>
      <Button data-testid={`github-pr-view-${pr.pr_number}`} variant="default" size="sm" asChild>
        <Link to="/" search={{ collection: pr.collection_id }}>
          View
        </Link>
      </Button>
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
  // Local live status, seeded from the source's persisted progress so the bar renders
  // instantly — even on a fresh page load mid-sync (the tab-independence proof). The
  // poll overwrites it every ~1.5s while a sync runs.
  const [status, setStatus] = useState<SyncStatus>(() => ({
    id: source.id,
    repo: source.repo,
    progress: source.progress,
    last_status: source.last_status,
    last_synced_at: source.last_synced_at,
    file_count: source.file_count,
  }))
  const prog = parseProgress(status.progress)
  const phase = prog?.phase
  const active = phase === "queued" || phase === "listing" || phase === "mirroring"
  const errored = phase === "error" || (!active && (status.last_status ?? "").startsWith("error"))

  // Poll the cheap status endpoint while a sync is active; stop on done/error. The
  // server runs the sync (a Durable Object on the edge, a detached loop on Node), so
  // this only reads progress — closing the tab never stops the work.
  useEffect(() => {
    if (!active) return
    let alive = true
    const iv = setInterval(async () => {
      try {
        const s = await api.syncStatus(source.id)
        if (alive) setStatus(s)
      } catch {
        // transient network blip — keep polling; a real failure lands as phase=error
      }
    }, 1500)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [active, source.id])

  // Fire the parent refresh exactly once when a sync finishes (active → done/error),
  // so the library's collection count updates and a toast confirms the outcome.
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) {
      if (phase === "done") onChanged(`Synced ${source.repo}`)
      else if (phase === "error") onError(prog?.message ?? "Sync failed")
    }
    wasActive.current = active
  }, [active, phase, prog?.message, source.repo, onChanged, onError])

  const sync = async () => {
    try {
      // Trigger + adopt the server's state. With a runner this returns "queued" (the
      // poll takes over); without one (self-host) it returns the finished source.
      const r = await api.runRepoSync(source.id)
      setStatus((s) => ({
        ...s,
        progress: r.progress,
        last_status: r.last_status,
        last_synced_at: r.last_synced_at,
        file_count: r.file_count,
      }))
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const [disconnectDialog, setDisconnectDialog] = useState(false)
  const [wipeBusy, setWipeBusy] = useState(false)

  const remove = async (wipe: boolean) => {
    setWipeBusy(true)
    try {
      await api.deleteRepoSource(source.id, wipe)
      setDisconnectDialog(false)
      onChanged(wipe ? "Repo disconnected and docs deleted" : "Repo disconnected (docs kept)")
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setWipeBusy(false)
    }
  }

  const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0
  // Queued / listing have no count yet → an indeterminate, pulsing bar.
  const indeterminate = active && (!prog || prog.total === 0)

  return (
    <Card data-testid={`github-row-${source.id}`} className="flex flex-col gap-3 p-3.5">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-foreground">
            {source.repo}
            <span className="text-muted-foreground"> · {source.ref}</span>
            {source.installation_id && <span className="text-muted-foreground"> · app</span>}
          </div>
          {!active && !errored && (
            <div className="mt-px flex items-center gap-1 truncate font-mono text-2xs text-muted-foreground">
              {(status.last_status?.startsWith("ok") || status.last_synced_at) && (
                <CheckCircle2 className="size-3 shrink-0 text-success" aria-hidden />
              )}
              {status.file_count} doc{status.file_count === 1 ? "" : "s"}
              {status.last_synced_at
                ? ` · synced ${ago(status.last_synced_at)}`
                : " · never synced"}
            </div>
          )}
        </div>
        <Button
          data-testid={`github-sync-${source.id}`}
          variant="default"
          size="sm"
          onClick={sync}
          disabled={active}
        >
          {active ? "Syncing…" : "Sync now"}
        </Button>
        <Button
          data-testid={`github-remove-${source.id}`}
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setDisconnectDialog(true)}
        >
          Disconnect
        </Button>
      </div>

      {disconnectDialog && (
        <Dialog open onOpenChange={(o) => !o && setDisconnectDialog(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect {source.repo}?</DialogTitle>
              <DialogDescription>
                Choose what happens to the {status.file_count} synced doc
                {status.file_count === 1 ? "" : "s"}.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-2 flex flex-col gap-2">
              <Button
                variant="outline"
                disabled={wipeBusy}
                data-testid={`github-disconnect-keep-${source.id}`}
                onClick={() => remove(false)}
              >
                Keep docs — stop syncing, docs stay readable
              </Button>
              <Button
                variant="destructive"
                disabled={wipeBusy}
                data-testid={`github-disconnect-wipe-${source.id}`}
                onClick={() => remove(true)}
              >
                {wipeBusy ? "Deleting…" : "Delete docs — remove all synced content"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ACTIVE — the giant, explicit progress block. Every phase named, live counts,
          a clear %, and a standing reassurance that it runs on the server. */}
      {active && prog && (
        <div
          className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
          data-testid={`github-progress-${source.id}`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
              <span className="truncate">{phaseHeadline(prog, source.repo)}</span>
            </div>
            {!indeterminate && (
              <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-primary">
                {pct}%
              </span>
            )}
          </div>

          <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full rounded-full bg-primary transition-all duration-500 ${indeterminate ? "w-1/3 animate-pulse" : ""}`}
              style={indeterminate ? undefined : { width: `${pct}%` }}
            />
          </div>

          <div
            className="font-mono text-2xs text-muted-foreground"
            data-testid={`github-progress-detail-${source.id}`}
          >
            {phaseDetail(prog)}
          </div>

          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <CheckCircle2 className="size-3 shrink-0 text-success" aria-hidden />
            Running on our servers — you can close this tab, it’ll keep going.
          </div>
        </div>
      )}

      {/* ERROR — red block with the message and a one-click retry. */}
      {errored && !active && (
        <div
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
          data-testid={`github-error-${source.id}`}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-destructive">Sync failed</div>
            <div className="mt-0.5 break-words font-mono text-2xs text-muted-foreground">
              {prog?.message ?? status.last_status ?? "Unknown error"}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={sync}
            data-testid={`github-retry-${source.id}`}
          >
            Try again
          </Button>
        </div>
      )}
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
      <Button
        variant="link"
        data-testid="github-advanced-toggle"
        className="h-auto p-0 text-xs"
        onClick={() => setOpen((o) => !o)}
      >
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
