import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
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
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { SearchField } from "@/components/shared/search-field"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionTitle } from "@/components/shared/section-title"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { toast } from "@/components/ui/sonner"
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

// Human labels for the GitHub App permission/event diff (the banner). Keys mirror
// the scopes/events in the server's REQUIRED_PERMISSIONS / REQUIRED_EVENTS.
const PERMISSION_LABELS: Record<string, string> = {
  contents: "Contents",
  metadata: "Metadata",
  pull_requests: "Pull requests",
  issues: "Issues",
  checks: "Checks",
  statuses: "Commit statuses",
  members: "Members",
}
const EVENT_LABELS: Record<string, string> = {
  push: "Push",
  pull_request: "Pull request",
  issues: "Issues",
  issue_comment: "Issue comment",
  check_run: "Check run",
}
const LEVEL_LABELS: Record<string, string> = {
  read: "Read-only",
  write: "Read & write",
  admin: "Admin",
}

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

// Open the repo picker automatically the first time a configured + installed
// workspace lands here without a repo connected yet (once per browser session), so
// connecting is one step instead of "find the account button, then pick". Stops once
// any repo is connected.
const AUTO_PICKER_KEY = "derive:gh-auto-picker"

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

  // Onboarding shortcut: an App is configured and installed but no repo is connected
  // yet → open the picker for the first installation so the user goes straight to
  // choosing a repo. Once per session (so a return visit isn't hijacked) and never
  // once a repo exists or the redirect already opened a picker.
  useEffect(() => {
    if (!status?.app.configured || pickerInstall || status.sources.length > 0) return
    const first = status.installations[0]
    if (!first || sessionStorage.getItem(AUTO_PICKER_KEY)) return
    sessionStorage.setItem(AUTO_PICKER_KEY, "1")
    setPickerInstall(first.installation_id)
  }, [status, pickerInstall])

  const appConfigured = status?.app.configured ?? false

  return (
    <section className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
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

      {/* Rendered only once status is known — an empty placeholder div would still
          claim a flex gap slot and double the section rhythm. */}
      {status !== null && (
        <div className="flex flex-col gap-2.5">
          {status.sources.length === 0 ? (
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
          )}
        </div>
      )}

      {/* PR previews — read-only mirrors of the docs an OPEN pull request changes,
          each in its own "PR #<n>" collection. Created automatically as PRs open; they
          disappear when the PR closes/merges. Review the plan in Derive during the PR. */}
      {status !== null && status.prs.length > 0 && (
        <div>
          <SectionTitle>Pull request previews</SectionTitle>
          <p className="mt-0.5 mb-2 text-sm text-muted-foreground">
            Open PRs that change docs appear here while they're open. Review them in Derive; on
            merge they fold into the collection above.
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
        <SectionTitle>Connect GitHub</SectionTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Create a read-only GitHub App for this instance, then install it on the repos you want to
          mirror. No tokens to paste, and pushes sync automatically.
        </p>
      </div>
      <Button variant="default" asChild data-testid="github-setup-app">
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
  const { slug, upToDate, missing, permissionsUrl, approveUrl } = status.app
  const needsPerms =
    upToDate === false &&
    !!missing &&
    (Object.keys(missing.permissions).length > 0 || missing.events.length > 0)
  return (
    <>
      {/* The fragment's children land directly in the section's gap-6 column, so the
          banner needs no margin of its own. */}
      {needsPerms && missing && (
        <div data-testid="github-perms-banner">
          <StatusPanel
            tone="warning"
            layout="inline"
            icon={<AlertTriangle aria-hidden />}
            title="Derive needs updated GitHub permissions"
            description="A new feature needs access GitHub hasn't granted this App yet. Update it on GitHub, save, then approve on your installation."
            action={
              <div className="flex flex-col gap-3">
                <ul role="list" className="flex flex-col gap-1 text-sm text-foreground">
                  {Object.entries(missing.permissions).map(([scope, level]) => (
                    <li key={scope} className="flex items-center gap-1.5">
                      <span className="size-1 rounded-full bg-foreground" aria-hidden />
                      <span className="font-medium">{PERMISSION_LABELS[scope] ?? scope}</span>
                      <span className="text-muted-foreground">
                        → {LEVEL_LABELS[level] ?? level}
                      </span>
                    </li>
                  ))}
                  {missing.events.map((ev) => (
                    <li key={ev} className="flex items-center gap-1.5">
                      <span className="size-1 rounded-full bg-foreground" aria-hidden />
                      <span className="text-muted-foreground">Subscribe to</span>
                      <span className="font-medium">{EVENT_LABELS[ev] ?? ev}</span>
                      <span className="text-muted-foreground">events</span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  {permissionsUrl && (
                    <Button variant="secondary" size="sm" data-testid="github-perms-update" asChild>
                      <a href={permissionsUrl} target="_blank" rel="noreferrer">
                        Update on GitHub →
                      </a>
                    </Button>
                  )}
                  {approveUrl && (
                    <Button variant="outline" size="sm" data-testid="github-perms-approve" asChild>
                      <a href={approveUrl} target="_blank" rel="noreferrer">
                        Approve on installation →
                      </a>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="github-perms-recheck"
                    onClick={onRefresh}
                  >
                    Re-check
                  </Button>
                </div>
              </div>
            }
          />
        </div>
      )}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 flex-1">
            <SectionTitle>GitHub App connected</SectionTitle>
            {installed ? (
              <p className="mt-0.5 text-sm text-muted-foreground">
                Pick a repository to mirror into Derive, or install on more accounts.
              </p>
            ) : (
              <>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Install Derive on the GitHub repos you want to mirror — then pick them here.
                </p>
                <Button
                  data-testid="github-install"
                  variant="default"
                  className="mt-3"
                  onClick={install}
                  disabled={busy}
                >
                  {busy ? "Opening GitHub…" : "Install on GitHub →"}
                </Button>
              </>
            )}
          </div>
          {installed && (
            <Button
              data-testid="github-install-more"
              variant="outline"
              size="sm"
              onClick={install}
              disabled={busy}
            >
              {busy ? "Opening GitHub…" : "Install on more"}
            </Button>
          )}
        </div>
        {installed && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">Pick a repository:</span>
            {status.installations.map((i) => (
              <Button
                key={i.installation_id}
                data-testid="github-pick-installation"
                variant="secondary"
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
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
              data-testid="github-app-settings-link"
            >
              Manage App on GitHub
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
            <span className="text-sm text-muted-foreground">— update permissions or uninstall</span>
          </div>
        )}
      </Card>
    </>
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
  const [query, setQuery] = useState("")
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

  // Filter the (already most-recent-first) list by a case-insensitive substring.
  const q = query.trim().toLowerCase()
  const shown = repos?.filter((r) => !q || r.full_name.toLowerCase().includes(q)) ?? null

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

        {repos && repos.length > 0 && (
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Filter repositories…"
            aria-label="Filter repositories"
            testId="github-repo-search"
            autoFocus
            className="mb-2"
          />
        )}

        <div className="max-h-[34vh] overflow-y-auto">
          {repos === null ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner />
            </div>
          ) : repos.length === 0 ? (
            <EmptyState>This installation has no repositories Derive can read.</EmptyState>
          ) : shown && shown.length === 0 ? (
            <EmptyState>No repositories match “{query.trim()}”.</EmptyState>
          ) : (
            <RadioGroup value={repo ?? ""} onValueChange={setRepo} className="gap-1">
              {shown?.map((r) => (
                <label
                  key={r.full_name}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-secondary"
                >
                  <RadioGroupItem value={r.full_name} data-testid="github-repo-radio" />
                  <span className="font-mono text-xs text-foreground">{r.full_name}</span>
                  {r.private && <Eyebrow>private</Eyebrow>}
                  {r.pushed_at && (
                    <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground">
                      {ago(r.pushed_at)}
                    </span>
                  )}
                </label>
              ))}
            </RadioGroup>
          )}
        </div>

        {repo && (
          <div className="mt-1 flex flex-col gap-2.5 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-muted-foreground">Include:</span>
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  data-testid="github-include-md"
                  checked={md}
                  onCheckedChange={(v) => setMd(v === true)}
                />{" "}
                Markdown
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  data-testid="github-include-html"
                  checked={html}
                  onCheckedChange={(v) => setHtml(v === true)}
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
              className="font-mono"
            />
            <div className="text-sm text-muted-foreground" data-testid="github-preview">
              {!includes ? (
                <span className="text-destructive">Pick at least one file type.</span>
              ) : preview === "loading" ? (
                "Counting…"
              ) : preview ? (
                <>
                  <span className="font-mono font-medium tabular-nums text-foreground">
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
            variant="default"
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
    <Card
      data-testid={`github-pr-${pr.pr_number}`}
      className="flex-row items-center gap-3 px-4 py-3"
    >
      <Icon name="review" className="text-muted-foreground" />
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
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          </a>
          <span aria-hidden>·</span>
          <span className="truncate">{pr.repo}</span>
          <span aria-hidden>·</span>
          {active ? (
            <span className="inline-flex items-center gap-1 text-primary">
              {/* Decorative — the "syncing…" text right here announces the state. */}
              <Spinner role="presentation" aria-label={undefined} className="size-3 shrink-0" />
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
      <Button data-testid={`github-pr-view-${pr.pr_number}`} variant="outline" size="sm" asChild>
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
    <Card data-testid={`github-row-${source.id}`} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm text-foreground">
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
          variant="outline"
          size="sm"
          onClick={sync}
          disabled={active}
        >
          {active ? "Syncing…" : "Sync now"}
        </Button>
        <Button
          data-testid={`github-remove-${source.id}`}
          variant="destructive-ghost"
          size="sm"
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
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
              {/* Decorative — the phase headline beside it announces the state. */}
              <Spinner role="presentation" aria-label={undefined} className="size-4 shrink-0" />
              <span className="truncate">{phaseHeadline(prog, source.repo)}</span>
            </div>
            {!indeterminate && (
              <span className="shrink-0 font-mono text-sm font-medium tabular-nums text-primary">
                {pct}%
              </span>
            )}
          </div>

          <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full rounded-full bg-primary transition-[width] duration-500 ${indeterminate ? "w-1/3 animate-pulse" : ""}`}
              style={indeterminate ? undefined : { width: `${pct}%` }}
            />
          </div>

          <div
            className="font-mono text-2xs text-muted-foreground"
            data-testid={`github-progress-detail-${source.id}`}
          >
            {phaseDetail(prog)}
          </div>

          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckCircle2 className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            Running on our servers — you can close this tab, it’ll keep going.
          </div>
        </div>
      )}

      {/* ERROR — danger callout with the message and a one-click retry. */}
      {errored && !active && (
        <div data-testid={`github-error-${source.id}`}>
          <StatusPanel
            tone="danger"
            layout="inline"
            icon={<AlertTriangle aria-hidden />}
            className="p-3"
            title="Sync failed"
            description={
              <span className="break-words font-mono text-2xs">
                {prog?.message ?? status.last_status ?? "Unknown error"}
              </span>
            }
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={sync}
                data-testid={`github-retry-${source.id}`}
              >
                Try again
              </Button>
            }
          />
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
    <div>
      <Button
        variant="link"
        data-testid="github-advanced-toggle"
        className="h-auto p-0"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide advanced" : "Advanced: connect with a token or a public repo"}
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
              disabled={busy || !valid}
            >
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
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
