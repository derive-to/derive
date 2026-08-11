import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { api, parseProgress, type RepoSource, type SyncProgress, type SyncStatus } from "@/api"
import { ListRow } from "@/components/shared/list-row"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"

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

export function RepoSourceRow({ source, onDone }: { source: RepoSource; onDone: () => void }) {
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
      // The sync runs on the server; the poll (not a client mutation) detects the outcome.
      if (phase === "done") {
        toast.success(`Synced ${source.repo}`)
        onDone()
      } else if (phase === "error") toast.error(prog?.message ?? "Sync failed") // mutation-ignore: server-side sync outcome from the poll, not a client mutation
    }
    wasActive.current = active
  }, [active, phase, prog?.message, source.repo, onDone])

  // Trigger + adopt the server's state. With a runner this returns "queued" (the poll
  // takes over); without one (self-host) it returns the finished source.
  const sync = useApiMutation({
    mutationFn: () => api.runRepoSync(source.id),
    onSuccess: (r) =>
      setStatus((s) => ({
        ...s,
        progress: r.progress,
        last_status: r.last_status,
        last_synced_at: r.last_synced_at,
        file_count: r.file_count,
      })),
  })

  const [disconnectDialog, setDisconnectDialog] = useState(false)
  const remove = useApiMutation({
    mutationFn: (wipe: boolean) => api.deleteRepoSource(source.id, wipe),
    success: (_data, wipe) =>
      wipe ? "Repo disconnected and docs deleted" : "Repo disconnected (docs kept)",
    onSuccess: () => {
      setDisconnectDialog(false)
      onDone()
    },
  })

  const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0
  // Queued / listing have no count yet → an indeterminate, pulsing bar.
  const indeterminate = active && (!prog || prog.total === 0)

  return (
    <ListRow
      data-testid={`github-row-${source.id}`}
      mono
      title={
        <>
          {source.repo}
          <span className="text-muted-foreground"> · {source.ref}</span>
          {source.installation_id && <span className="text-muted-foreground"> · app</span>}
        </>
      }
      meta={
        !active && !errored ? (
          <span className="flex items-center gap-1 truncate font-mono">
            {(status.last_status?.startsWith("ok") || status.last_synced_at) && (
              <CheckCircle2 className="size-3 shrink-0 text-success" aria-hidden />
            )}
            {status.file_count} doc{status.file_count === 1 ? "" : "s"}
            {status.last_synced_at ? ` · synced ${ago(status.last_synced_at)}` : " · never synced"}
          </span>
        ) : undefined
      }
      actions={
        <>
          <Button
            data-testid={`github-sync-${source.id}`}
            variant="ghost"
            size="sm"
            onClick={() => sync.mutate()}
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
        </>
      }
      below={
        <>
          {/* Hand-rolled on purpose: a two-outcome CHOICE (keep vs delete the synced docs), not a
              yes/no confirm — ConfirmDialog has no second verb. */}
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
                    disabled={remove.isPending}
                    data-testid={`github-disconnect-keep-${source.id}`}
                    onClick={() => remove.mutate(false)}
                  >
                    Keep docs — stop syncing, docs stay readable
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={remove.isPending}
                    data-testid={`github-disconnect-wipe-${source.id}`}
                    onClick={() => remove.mutate(true)}
                  >
                    {remove.isPending ? "Deleting…" : "Delete docs — remove all synced content"}
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
                    onClick={() => sync.mutate()}
                    data-testid={`github-retry-${source.id}`}
                  >
                    Try again
                  </Button>
                }
              />
            </div>
          )}
        </>
      }
    />
  )
}
