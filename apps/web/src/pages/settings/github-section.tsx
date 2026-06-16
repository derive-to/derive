import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { api, type GithubSyncStatus, type InstallationRepo, type RepoSource } from "@/api"
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
                  load()
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
            toast.success("Repos connected — syncing")
            load()
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
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">Connect a repository</div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Install Dock on GitHub and choose which repos to mirror.
          </p>
        </div>
        <Button data-testid="github-install" variant="primary" onClick={install} disabled={busy}>
          {busy ? "Opening GitHub…" : "Install on GitHub"}
        </Button>
      </div>
      <div className="border-t border-border pt-2">
        <a
          href="/settings/github/app/new"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Replace GitHub App
        </a>
      </div>
      {status.installations.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">Already installed:</span>
          {status.installations.map((i) => (
            <Button
              key={i.installation_id}
              variant="outline"
              size="sm"
              onClick={() => onPick(i.installation_id)}
            >
              {i.account_login ? `Pick repos · ${i.account_login}` : "Pick repos"}
            </Button>
          ))}
        </div>
      )}
    </Card>
  )
}

// The repo picker: list the installation's repos and connect the chosen ones.
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
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .listInstallationRepos(installationId)
      .then((r) => setRepos(r.repos))
      .catch((e) => {
        onError((e as Error).message)
        setRepos([])
      })
  }, [installationId, onError])

  const toggle = (full: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(full)) next.delete(full)
      else next.add(full)
      return next
    })

  const connect = async () => {
    setBusy(true)
    try {
      // Connect each chosen repo, then kick its first sync so docs appear now.
      for (const full of chosen) {
        const src = await api.connectRepoSource({ repo: full, installation_id: installationId })
        await api.runRepoSync(src.id).catch(() => undefined)
      }
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
          <DialogTitle>Choose repositories to mirror</DialogTitle>
          <DialogDescription>
            Pick the repos this installation should sync into Dock.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto">
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
                      type="checkbox"
                      checked={chosen.has(r.full_name)}
                      onChange={() => toggle(r.full_name)}
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
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={connect}
            disabled={busy || chosen.size === 0}
            data-testid="github-picker-connect"
          >
            {busy ? "Connecting…" : `Connect ${chosen.size || ""}`.trim()}
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
          {source.installation_id && <span className="text-muted-foreground"> · app</span>}
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
