import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Zap } from "lucide-react"
import { useState } from "react"
import { type Automation, api, type Run } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { automationsQuery, runsQuery, workspaceQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AutomationForm } from "./automation-form"
import {
  runOutcome,
  runStatusLabel,
  runWrites,
  targetSummary,
  triggerLabel,
} from "./automation-format"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

export function AutomationsSection() {
  const qc = useQueryClient()
  const { data: automations, isPending, isError, refetch } = useQuery(automationsQuery())
  // Creating / removing / activity are Admin-gated server-side; Run now needs a write seat.
  // Read the caller's role once and render only what they can actually do — never a form
  // whose submit is guaranteed a 403.
  const { data: ws } = useQuery(workspaceQuery())
  const isAdmin = ws?.role === "owner"
  const canRun = ws?.role === "owner" || ws?.role === "editor"
  const reload = () => {
    qc.invalidateQueries({ queryKey: automationsQuery().queryKey })
    qc.invalidateQueries({ queryKey: runsQuery().queryKey })
  }

  return (
    <SettingsSection
      title="Automations"
      description={
        <>
          An automation is a standing job: an agent, a trigger, and an instruction. It runs on
          demand, on a schedule, or on an event — always through the review loop, never around it.
        </>
      }
    >
      {isAdmin ? (
        <div className="rounded-lg border bg-card p-4">
          <AutomationForm onDone={reload} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only a workspace Admin can create automations. Ask an Admin to set one up.
        </p>
      )}

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load automations"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="automations-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : !automations || automations.length === 0 ? (
        <EmptyState>
          {isAdmin ? "No automations yet. Create one above." : "No automations yet."}
        </EmptyState>
      ) : (
        <SettingsGroup>
          {automations.map((a) => (
            <AutomationRow
              key={a.id}
              automation={a}
              canRun={canRun}
              canRemove={isAdmin}
              onDone={reload}
            />
          ))}
        </SettingsGroup>
      )}

      {/* The runs endpoint is Admin-gated: don't issue a query that can only 403. */}
      {isAdmin && <Activity />}
    </SettingsSection>
  )
}

function AutomationRow({
  automation,
  canRun,
  canRemove,
  onDone,
}: {
  automation: Automation
  canRun: boolean
  canRemove: boolean
  onDone: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const run = useApiMutation({
    mutationFn: () => api.runAutomation(automation.id),
    success: "Run queued",
    onSuccess: () => onDone(),
  })
  const pause = useApiMutation({
    mutationFn: () => api.updateAutomation(automation.id, { enabled: !automation.enabled }),
    success: automation.enabled ? "Automation paused" : "Automation resumed",
    onSuccess: () => onDone(),
  })
  const remove = useApiMutation({
    mutationFn: () => api.deleteAutomation(automation.id),
    success: "Automation removed",
    onSuccess: () => onDone(),
  })
  const summary = targetSummary(automation.refs)
  return (
    <div data-testid={`automation-row-${automation.id}`} className="flex items-center gap-3 py-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent">
        <Zap className="size-4 text-muted-foreground" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <span className="truncate">{automation.instruction}</span>
          <Badge variant="secondary">{triggerLabel(automation.trigger)}</Badge>
          {!automation.enabled && <Badge variant="outline">Paused</Badge>}
          <ExecutorBadge seenAt={automation.executor_seen_at ?? null} />
        </div>
        <div className="truncate text-sm text-muted-foreground">
          {automation.refs.some((r) => r.mode === "publish")
            ? "Publishes live"
            : "Proposes for review"}
          {summary && ` · ${summary}`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canRun && automation.enabled && (
          <Button
            data-testid={`automation-run-${automation.id}`}
            variant="secondary"
            size="sm"
            onClick={() => run.mutate()}
            loading={run.isPending}
            disabled={run.isPending}
          >
            Run now
          </Button>
        )}
        {canRemove && (
          <Button
            data-testid={`automation-edit-${automation.id}`}
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
        {canRemove && (
          <Button
            data-testid={`automation-pause-${automation.id}`}
            variant="ghost"
            size="sm"
            onClick={() => pause.mutate()}
            loading={pause.isPending}
            disabled={pause.isPending}
          >
            {automation.enabled ? "Pause" : "Resume"}
          </Button>
        )}
        {canRemove && (
          <Button
            data-testid={`automation-remove-${automation.id}`}
            variant="destructive-ghost"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        )}
      </div>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent data-testid="automation-edit-dialog">
          <DialogHeader>
            <DialogTitle>Edit automation</DialogTitle>
          </DialogHeader>
          {/* Remount per open so stale state never leaks between edit sessions. */}
          {editing && (
            <AutomationForm
              automation={automation}
              onDone={() => {
                setEditing(false)
                onDone()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove this automation?"
        description="Its queued runs are cancelled. Past runs stay in the activity."
        confirmLabel="Remove"
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}

function Activity() {
  const { data: runs, isPending, isError } = useQuery(runsQuery())
  if (isPending) return null
  if (isError)
    return <p className="mt-6 text-sm text-muted-foreground">Couldn't load recent activity.</p>
  if (!runs || runs.length === 0) return null
  return (
    <div className="mt-6">
      <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Recent activity
      </div>
      <ul className="flex flex-col">
        {runs.slice(0, 12).map((r) => (
          <li
            key={r.id}
            data-testid={`run-row-${r.id}`}
            className="flex flex-col gap-1 border-b py-2.5 text-sm last:border-0"
          >
            <div className="flex items-center gap-3">
              <RunStatus status={r.status} />
              <span className="min-w-0 truncate text-muted-foreground">{r.reason}</span>
              {runOutcome(r.meta) && <Badge variant="outline">{runOutcome(r.meta)}</Badge>}
              <span className="ml-auto font-mono text-2xs text-muted-foreground">
                {ago(r.created_at)}
              </span>
            </div>
            <RunWrites meta={r.meta} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** What the run actually wrote, from meta.writes[] — each write linked to its artifact,
 *  the verb (created/proposed/revised) shown. Parsing lives in runWrites (unit-tested);
 *  absent or empty writes render nothing (asks and failed runs). */
function RunWrites({ meta }: { meta: string | null }) {
  const writes = runWrites(meta)
  if (writes.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 pl-1 text-2xs text-muted-foreground">
      {writes.map((w) => (
        <Link
          key={w.shortId}
          to="/artifacts/$ref"
          params={{ ref: w.shortId }}
          className="font-mono underline-offset-2 hover:underline"
        >
          {w.verb} · {w.shortId}
        </Link>
      ))}
    </div>
  )
}

function RunStatus({ status }: { status: Run["status"] }) {
  const variant =
    status === "succeeded"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "running"
          ? "brand"
          : "secondary"
  return (
    <Badge variant={variant} shape="pill">
      {runStatusLabel(status)}
    </Badge>
  )
}

/** Honesty over silence (the Buzz rule): an automation whose agent has no executor
 *  polling for runs is INERT, and the row must say so instead of looking configured.
 *  Quiet when live — the badge only appears when something's wrong. Thresholds match
 *  the context console's RunnerLiveness. */
function ExecutorBadge({ seenAt }: { seenAt: string | null }) {
  const age = seenAt ? Date.now() - new Date(seenAt).getTime() : Number.POSITIVE_INFINITY
  if (seenAt && age < 600_000) return null
  return (
    <Badge variant="outline" className="border-warning/40 text-warning">
      {seenAt ? `Executor offline · seen ${ago(seenAt)}` : "No executor"}
    </Badge>
  )
}
