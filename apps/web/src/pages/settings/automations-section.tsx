import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Zap } from "lucide-react"
import { useState } from "react"
import { type Automation, api, type Run } from "@/api"
import { AdminNote } from "@/components/shared/admin-note"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge } from "@/components/shared/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { automationsQuery, runsQuery, workspaceQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AutomationForm } from "./automation-form"
import {
  runExecutionReceipt,
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
        <AdminNote can="create automations" />
      )}

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <LoadError
          title="Couldn’t load automations"
          testId="automations-retry"
          onRetry={() => refetch()}
        />
      ) : !automations || automations.length === 0 ? (
        <SettingsEmpty>
          {isAdmin
            ? "No automations yet — nothing runs on a schedule or trigger."
            : "No automations yet."}
        </SettingsEmpty>
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
  const mode = automation.refs.some((r) => r.mode === "publish")
    ? "Publishes live"
    : "Proposes for review"
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
      meta={summary ? `${mode} · ${summary}` : mode}
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
        </>
      }
    />
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
      <Eyebrow as="div" className="mb-1">
        Recent activity
      </Eyebrow>
      <ul className="flex flex-col">
        {runs.slice(0, 12).map((r) => (
          <li
            key={r.id}
            data-testid={`run-row-${r.id}`}
            className="flex flex-col gap-1 border-b py-3 text-sm last:border-0"
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
            <RunExecution meta={r.meta} />
            <RunTimeline timeline={r.timeline} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function RunExecution({ meta }: { meta: string | null }) {
  const receipt = runExecutionReceipt(meta)
  if (!receipt) return null
  return (
    <div className="flex flex-wrap items-center gap-2 pl-1 text-2xs text-muted-foreground">
      <span>{receipt.location === "hosted" ? "Hosted" : "Local"}</span>
      <span>·</span>
      <span>{receipt.provider === "codex" ? "Codex" : "Claude Code"}</span>
      {receipt.actions > 0 && <span>· {receipt.actions} actions recorded</span>}
    </div>
  )
}

/** Why a run is where it is: retries spent, when it will next be tried, and what went wrong
 *  last time. Renders nothing for the ordinary case (a first-try run that just worked), so the
 *  activity list stays quiet until there is something an operator would actually want to know. */
function RunTimeline({ timeline }: { timeline?: Run["timeline"] }) {
  if (!timeline) return null
  const { retries, waiting_until, last_error } = timeline
  const waiting = waiting_until && Date.parse(waiting_until) > Date.now() ? waiting_until : null
  if (retries === 0 && !waiting && !last_error) return null
  return (
    <div className="flex flex-wrap items-center gap-2 pl-1 text-2xs text-muted-foreground">
      {retries > 0 && (
        <Badge variant="outline">{retries === 1 ? "1 retry" : `${retries} retries`}</Badge>
      )}
      {waiting && <span>next try {ago(waiting)}</span>}
      {last_error && <span className="min-w-0 truncate italic">{last_error}</span>}
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
  const tone =
    status === "succeeded"
      ? "ok"
      : status === "failed"
        ? "error"
        : status === "running"
          ? "busy"
          : "muted"
  return (
    <StatusBadge tone={tone} shape="pill">
      {runStatusLabel(status)}
    </StatusBadge>
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
    <StatusBadge tone="attention">
      {seenAt ? `Executor offline · seen ${ago(seenAt)}` : "No executor"}
    </StatusBadge>
  )
}
