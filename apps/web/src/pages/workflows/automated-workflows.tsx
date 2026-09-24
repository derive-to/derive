import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ExternalLink, GitBranch, Sparkles } from "lucide-react"
import { useState } from "react"
import { type Automation, api, type Run } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { RunReceipt } from "@/components/shared/run-receipt"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge } from "@/components/shared/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { automationsQuery, runsQuery, workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { runtimeReport } from "@/lib/runtime-report"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "../settings/settings-list-skeleton"
import { AutomationForm } from "./automation-form"
import {
  githubActionRunReceipt,
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
  const reload = () => {
    qc.invalidateQueries({ queryKey: automationsQuery().queryKey })
    qc.invalidateQueries({ queryKey: runsQuery().queryKey })
  }

  return (
    <section className="flex flex-col gap-4">
      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <LoadError
          title="Couldn’t load automated workflows"
          testId="automations-retry"
          onRetry={() => refetch()}
        />
      ) : !automations || automations.length === 0 ? (
        <SettingsEmpty>
          No other configured workflows yet. Use New workflow to add a task or GitHub Action.
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
    success: automation.trigger.action ? "Workflow dispatched" : "Run queued",
    onSuccess: () => onDone(),
  })
  const pause = useApiMutation({
    mutationFn: () => api.updateAutomation(automation.id, { enabled: !automation.enabled }),
    success: automation.enabled ? "Workflow disabled" : "Workflow enabled",
    onSuccess: () => onDone(),
  })
  const remove = useApiMutation({
    mutationFn: () => api.deleteAutomation(automation.id),
    success: "Workflow removed",
    onSuccess: () => onDone(),
  })
  const action = automation.trigger.action
  const summary = action
    ? `${action.owner}/${action.repo} · ${action.workflow} · ${action.ref}`
    : targetSummary(automation.refs)
  return (
    <ListRow
      data-testid={`automation-row-${automation.id}`}
      className="[&>div:first-child]:flex-wrap [&>div:first-child>div:last-child]:w-full sm:[&>div:first-child>div:last-child]:w-auto"
      leading={
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent">
          {action ? (
            <GitBranch className="size-4 text-muted-foreground" aria-hidden />
          ) : (
            <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          )}
        </div>
      }
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 max-w-full truncate">{automation.instruction}</span>
          <Badge variant="outline">
            {action ? "GitHub Action" : automation.provider === "codex" ? "Codex" : "Claude Code"}
          </Badge>
          {automation.context_id && <Badge variant="outline">Context</Badge>}
          <Badge variant="secondary">{triggerLabel(automation.trigger)}</Badge>
          {!automation.enabled && <Badge variant="outline">Disabled</Badge>}
          {!automation.trigger.action ? (
            <ExecutorBadge seenAt={automation.executor_seen_at ?? null} />
          ) : null}
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
              {automation.enabled ? "Disable" : "Enable"}
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

export function RecentRuns() {
  const workspace = useQuery(workspaceQuery())
  if (workspace.isPending) return <SettingsListSkeleton />
  if (workspace.isError)
    return (
      <LoadError
        title="Couldn’t check run access"
        testId="workflow-run-access-retry"
        onRetry={() => workspace.refetch()}
      />
    )
  if (workspace.data.role !== "owner")
    return (
      <p className="text-sm text-muted-foreground">
        Open a cloud workflow to see its runs and the reports available to you. Workspace-wide run
        history is available to owners.
      </p>
    )
  return <WorkspaceRuns />
}

function WorkspaceRuns() {
  const definitions = useQuery(automationsQuery())
  const {
    data: runs,
    isPending,
    isError,
    refetch,
  } = useQuery({
    ...runsQuery(),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === "queued" || run.status === "running")
        ? 5000
        : false,
  })
  if (isPending || definitions.isPending) return <SettingsListSkeleton />
  if (isError || definitions.isError)
    return (
      <LoadError
        title="Couldn’t load recent runs"
        testId="workflow-runs-retry"
        onRetry={() => {
          void refetch()
          void definitions.refetch()
        }}
      />
    )
  const automations = definitions.data
  if (!runs || runs.length === 0)
    return <SettingsEmpty>No runs yet. Open a workflow to start one.</SettingsEmpty>
  return (
    <div className="mt-6">
      <Eyebrow as="div" className="mb-1">
        Recent runs
      </Eyebrow>
      <div className="grid gap-2">
        {runs.slice(0, 12).map((run, index) => {
          const automation = automations.find((item) => item.id === run.automation_id)
          const presentation = presentAutomationRun(run, automation)
          const cloud = runtimeReport(run.meta)
          const writes = runWrites(run.meta)
          const receipt = runExecutionReceipt(run.meta)
          const githubReceipt = githubActionRunReceipt(run.meta)
          const timeline = run.timeline
          const hasDetails = Boolean(
            run.context_id ||
              cloud?.report_short_id ||
              writes.length ||
              githubReceipt ||
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
              statusLabel={githubReceipt && run.status === "succeeded" ? "Dispatched" : undefined}
              title={presentation.title}
              summary={presentation.summary}
              facts={presentation.facts}
              createdAt={run.created_at}
              defaultOpen={index === 0 && hasDetails}
              testId={`run-row-${run.id}`}
            >
              {hasDetails ? (
                <div className="grid gap-2">
                  {cloud?.report_short_id && (
                    <Link
                      to="/artifacts/$ref"
                      params={{ ref: cloud.report_short_id }}
                      className="text-sm text-primary underline"
                      data-testid={`workflow-run-report-${run.id}`}
                    >
                      Open report
                    </Link>
                  )}
                  {run.context_id && (
                    <Link
                      to="/workflows"
                      search={{ workflow: run.context_id }}
                      className="text-sm text-primary underline"
                      data-testid={`workflow-run-detail-${run.id}`}
                    >
                      Open workflow
                    </Link>
                  )}
                  <RunOutcome meta={run.meta} />
                  <RunGithubAction meta={run.meta} />
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

function RunGithubAction({ meta }: { meta: string | null }) {
  const receipt = githubActionRunReceipt(meta)
  if (!receipt) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-2xs text-muted-foreground">
      <span className="font-medium text-foreground">GitHub Action</span>
      <a
        href={receipt.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-w-0 items-center gap-1 font-mono text-foreground underline underline-offset-2"
      >
        <span className="truncate">View run #{receipt.runId}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden />
      </a>
      <span className="min-w-0 truncate">
        {receipt.repository} · {receipt.workflow} · {receipt.ref}
      </span>
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
