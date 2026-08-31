import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Zap } from "lucide-react"
import { useState } from "react"
import { type Automation, api, type Run } from "@/api"
import { AdminNote } from "@/components/shared/admin-note"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { RunReceipt } from "@/components/shared/run-receipt"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionHeading } from "@/components/shared/section-title"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge } from "@/components/shared/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { automationsQuery, runsQuery, workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "../settings/settings-list-skeleton"
import { AutomationForm } from "./automation-form"
import {
  runExecutionReceipt,
  runOutcome,
  runOutcomeLabel,
  runWrites,
  targetSummary,
  triggerLabel,
} from "./automation-format"
import { presentAutomationRun } from "./run-presentation"

export function AutomatedWorkflows() {
  const qc = useQueryClient()
  const { data: automations, isPending, isError, refetch } = useQuery(automationsQuery())
  const workspace = useQuery(workspaceQuery())
  const settingsQuery = useQuery(workspaceSettingsQuery())
  const { data: ws } = workspace
  const { data: settings } = settingsQuery
  const isAdmin = ws?.role === "owner"
  const canRun = ws?.role === "owner" || ws?.role === "editor"
  const standingRunsEnabled = settings?.automateBeta === true
  const accessPending = workspace.isPending || settingsQuery.isPending
  const accessError = workspace.isError || settingsQuery.isError
  const retryAccess = () => {
    void Promise.all([workspace.refetch(), settingsQuery.refetch()])
  }
  const reload = () => {
    qc.invalidateQueries({ queryKey: automationsQuery().queryKey })
    qc.invalidateQueries({ queryKey: runsQuery().queryKey })
  }
  const enable = useApiMutation({
    mutationFn: () => api.updateWorkspaceSettings({ automateBeta: true }),
    success: "Workflows enabled",
    onSuccess: (next) => qc.setQueryData(workspaceSettingsQuery().queryKey, next),
  })

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <SectionHeading>Single-agent workflows</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Give one Agent a standing instruction, then run it on demand, on a schedule, or after an
          event. Each start creates a separate run.
        </p>
      </div>
      {accessPending ? (
        <Skeleton className="h-20 w-full rounded-lg" />
      ) : accessError ? (
        <LoadError
          title="Couldn’t load workflow permissions"
          testId="workflow-permissions-retry"
          layout="inline"
          onRetry={retryAccess}
        />
      ) : isAdmin && standingRunsEnabled ? (
        <div className="rounded-lg border bg-card p-4">
          <AutomationForm onDone={reload} />
        </div>
      ) : isAdmin ? (
        <SettingsGroup>
          <SettingRow
            label="Enable single-agent workflows"
            description="Create reusable jobs and run them here, on a schedule, or from an event."
          >
            <Button
              data-testid="automations-enable"
              variant="secondary"
              size="sm"
              onClick={() => enable.mutate()}
              loading={enable.isPending}
              disabled={enable.isPending}
            >
              Enable workflows
            </Button>
          </SettingRow>
        </SettingsGroup>
      ) : (
        <AdminNote can="create workflows" />
      )}

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <LoadError
          title="Couldn’t load single-agent workflows"
          testId="automations-retry"
          onRetry={() => refetch()}
        />
      ) : !automations || automations.length === 0 ? (
        <SettingsEmpty>
          {isAdmin
            ? "No single-agent workflows yet. Nothing is running on a schedule or trigger."
            : "No single-agent workflows yet."}
        </SettingsEmpty>
      ) : (
        <SettingsGroup>
          {automations.map((a) => (
            <AutomationRow
              key={a.id}
              automation={a}
              canRun={canRun && standingRunsEnabled}
              canRemove={isAdmin}
              onDone={reload}
            />
          ))}
        </SettingsGroup>
      )}

      {/* The runs endpoint is Admin-gated: don't issue a query that can only 403. */}
      {isAdmin && automations ? <RecentRuns automations={automations} /> : null}
    </section>
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
    success: automation.enabled ? "Workflow paused" : "Workflow resumed",
    onSuccess: () => onDone(),
  })
  const remove = useApiMutation({
    mutationFn: () => api.deleteAutomation(automation.id),
    success: "Workflow removed",
    onSuccess: () => onDone(),
  })
  const summary = targetSummary(automation.refs)
  return (
    <ListRow
      data-testid={`automation-row-${automation.id}`}
      leading={
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent">
          <Zap className="size-4 text-muted-foreground" aria-hidden />
        </div>
      }
      title={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{automation.instruction}</span>
          <Badge variant="outline">
            {automation.provider === "codex" ? "Codex" : "Claude Code"}
          </Badge>
          {automation.context_id && <Badge variant="outline">Context</Badge>}
          <Badge variant="secondary">{triggerLabel(automation.trigger)}</Badge>
          {!automation.enabled && <Badge variant="outline">Paused</Badge>}
          <ExecutorBadge seenAt={automation.executor_seen_at ?? null} />
        </span>
      }
      meta={summary || undefined}
      actions={
        <>
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
          <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent
              data-testid="automation-edit-dialog"
              className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
            >
              <DialogHeader>
                <DialogTitle>Edit workflow</DialogTitle>
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
            title="Remove this workflow?"
            description="Its queued runs are cancelled. Past runs remain visible."
            confirmLabel="Remove"
            onConfirm={() => remove.mutate()}
          />
        </>
      }
    />
  )
}

function RecentRuns({ automations }: { automations: Automation[] }) {
  const {
    data: runs,
    isPending,
    isError,
  } = useQuery({
    ...runsQuery(),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === "queued" || run.status === "running")
        ? 5000
        : false,
  })
  if (isPending) return null
  if (isError)
    return <p className="mt-6 text-sm text-muted-foreground">Couldn't load recent runs.</p>
  if (!runs || runs.length === 0) return null
  return (
    <div className="mt-6">
      <Eyebrow as="div" className="mb-1">
        Recent runs
      </Eyebrow>
      <div className="grid gap-2">
        {runs.slice(0, 12).map((run, index) => {
          const automation = automations.find((item) => item.id === run.automation_id)
          const presentation = presentAutomationRun(run, automation)
          const writes = runWrites(run.meta)
          const receipt = runExecutionReceipt(run.meta)
          const timeline = run.timeline
          const hasDetails = Boolean(
            writes.length ||
              runOutcome(run.meta) ||
              receipt?.model ||
              receipt?.actions ||
              timeline?.retries ||
              timeline?.waiting_until ||
              timeline?.last_error,
          )
          return (
            <RunReceipt
              key={run.id}
              id={run.id}
              status={run.status}
              title={presentation.title}
              summary={presentation.summary}
              facts={presentation.facts}
              createdAt={run.created_at}
              defaultOpen={index === 0 && hasDetails}
              testId={`run-row-${run.id}`}
            >
              {hasDetails ? (
                <div className="grid gap-2">
                  <RunOutcome meta={run.meta} />
                  <RunWrites meta={run.meta} />
                  <RunExecution meta={run.meta} />
                  <RunTimeline timeline={run.timeline} />
                </div>
              ) : undefined}
            </RunReceipt>
          )
        })}
      </div>
    </div>
  )
}

function RunExecution({ meta }: { meta: string | null }) {
  const receipt = runExecutionReceipt(meta)
  if (!receipt || (!receipt.model && receipt.actions === 0)) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
      <span className="font-medium text-foreground">Execution</span>
      {receipt.model ? <span>{receipt.model}</span> : null}
      {receipt.actions > 0 ? <span>{receipt.actions} actions recorded</span> : null}
    </div>
  )
}

/** Retry details are omitted for ordinary first-attempt runs. */
function RunTimeline({ timeline }: { timeline?: Run["timeline"] }) {
  if (!timeline) return null
  const { retries, waiting_until, last_error } = timeline
  const waiting = waiting_until && Date.parse(waiting_until) > Date.now() ? waiting_until : null
  if (retries === 0 && !waiting && !last_error) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
      <span className="font-medium text-foreground">Attempts</span>
      {retries > 0 && (
        <Badge variant="outline">{retries === 1 ? "1 retry" : `${retries} retries`}</Badge>
      )}
      {waiting && <span>next try {ago(waiting)}</span>}
      {last_error && <span className="min-w-0 truncate italic">{last_error}</span>}
    </div>
  )
}

function RunWrites({ meta }: { meta: string | null }) {
  const writes = runWrites(meta)
  if (writes.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
      <span className="font-medium text-foreground">Artifacts</span>
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

function RunOutcome({ meta }: { meta: string | null }) {
  const outcome = runOutcome(meta)
  if (!outcome) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
      <span className="font-medium text-foreground">Outcome</span>
      <span>{runOutcomeLabel(outcome)}</span>
    </div>
  )
}

/** Warn when no executor has polled recently. Thresholds match RunnerLiveness. */
function ExecutorBadge({ seenAt }: { seenAt: string | null }) {
  const age = seenAt ? Date.now() - new Date(seenAt).getTime() : Number.POSITIVE_INFINITY
  if (seenAt && age < 600_000) return null
  return (
    <StatusBadge tone="attention">
      {seenAt ? `Executor offline · seen ${ago(seenAt)}` : "No executor"}
    </StatusBadge>
  )
}
