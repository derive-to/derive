import type { AutomationRecord } from "@derive/core"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { SectionTitle } from "@/components/shared/section-title"
import { StatusBadge } from "@/components/shared/status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

export function RuntimeScheduleCard({
  contextId,
  schedule,
  nextRunAt,
  fixedProvider,
}: {
  contextId: string
  schedule: AutomationRecord | null
  nextRunAt: string | null
  fixedProvider?: "codex" | "claude-code"
}) {
  const queryClient = useQueryClient()
  const trigger = schedule ? JSON.parse(schedule.trigger) : null
  const saved = {
    instruction: schedule?.instruction ?? "",
    provider: fixedProvider ?? schedule?.provider ?? "codex",
    cron: String(trigger?.cron ?? "0 9 * * *"),
    timezone: String(trigger?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    revision: schedule?.revision ?? null,
  }
  // Capture the revision on the first edit. Polling may refresh the saved definition,
  // but must neither erase the draft nor silently authorize overwriting another edit.
  const [draft, setDraft] = useState<typeof saved | null>(null)
  const values = { ...(draft ?? saved), ...(fixedProvider ? { provider: fixedProvider } : {}) }
  const { instruction, provider, cron, timezone } = values
  const stale = draft !== null && draft.revision !== saved.revision
  const save = useApiMutation({
    mutationFn: (pause: boolean) =>
      api.saveContextRuntimeSchedule(contextId, {
        instruction: pause && schedule ? schedule.instruction : instruction.trim(),
        provider: pause && schedule ? schedule.provider : provider,
        cron: pause ? trigger.cron : cron.trim(),
        timezone: pause ? trigger.tz : timezone.trim(),
        enabled: !pause,
        revision: pause ? saved.revision : values.revision,
      }),
    invalidate: [contextRuntimeQuery(contextId).queryKey],
    success: "Schedule saved",
    onSuccess: (result, pause) => {
      queryClient.setQueryData<Awaited<ReturnType<typeof api.getContextRuntime>>>(
        contextRuntimeQuery(contextId).queryKey,
        (previous) =>
          previous && (previous.schedule?.revision ?? -1) <= result.schedule.revision
            ? { ...previous, ...result }
            : previous,
      )
      setDraft(
        pause && draft
          ? {
              ...draft,
              revision:
                draft.revision === result.schedule.revision - 1
                  ? result.schedule.revision
                  : draft.revision,
            }
          : null,
      )
    },
  })
  return (
    <div
      data-testid="context-runtime-schedule"
      className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-col gap-1">
        <SectionTitle
          action={
            <StatusBadge tone={schedule?.enabled ? "ok" : "muted"}>
              {schedule?.enabled ? "Active" : schedule ? "Paused" : "Not scheduled"}
            </StatusBadge>
          }
        >
          Schedule
        </SectionTitle>
        <p className="text-sm text-muted-foreground">Repeat a task at the times you choose.</p>
      </div>
      <label className="flex min-w-0 flex-col gap-1.5 text-sm">
        Recurring task
        <Textarea
          data-testid="context-runtime-schedule-instruction"
          className="min-h-28"
          placeholder="Check for new issues and update your findings…"
          value={instruction}
          maxLength={16000}
          onChange={(e) => setDraft({ ...values, instruction: e.target.value })}
          disabled={save.isPending}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5 text-sm">
        Agent
        <select
          data-testid="context-runtime-schedule-provider"
          value={provider}
          className="h-8 w-fit rounded-lg border border-input bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
          disabled={!!fixedProvider || save.isPending}
          onChange={(e) =>
            setDraft({ ...values, provider: e.target.value as "codex" | "claude-code" })
          }
        >
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
        </select>
      </label>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          Cron expression
          <Input
            data-testid="context-runtime-schedule-cron"
            className="font-mono"
            value={cron}
            disabled={save.isPending}
            onChange={(e) => setDraft({ ...values, cron: e.target.value })}
            placeholder="0 9 * * *"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          Timezone
          <Input
            data-testid="context-runtime-schedule-timezone"
            value={timezone}
            disabled={save.isPending}
            onChange={(e) => setDraft({ ...values, timezone: e.target.value })}
            placeholder="America/New_York"
          />
        </label>
      </div>
      <p className="text-sm text-muted-foreground">
        <code className="font-mono">0 9 * * *</code> runs daily at 9 AM in the selected timezone.
      </p>
      {schedule && (
        <p className="text-sm text-muted-foreground">
          {schedule.enabled && nextRunAt
            ? `Next run: ${new Date(nextRunAt).toLocaleString(undefined, { timeZone: trigger.tz })} (${trigger.tz})`
            : "Schedule paused"}
        </p>
      )}
      {stale && (
        <div className="text-sm text-muted-foreground">
          <p>The schedule changed elsewhere. Your unsaved draft has been kept.</p>
          <Button
            variant="outline"
            data-testid="context-runtime-schedule-reload"
            disabled={save.isPending}
            onClick={() => setDraft(null)}
          >
            Discard draft and load latest
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          loading={save.isPending}
          data-testid="context-runtime-schedule-save"
          disabled={
            save.isPending || stale || !instruction.trim() || !cron.trim() || !timezone.trim()
          }
          onClick={() => save.mutate(false)}
        >
          {save.isPending ? "Saving…" : schedule?.enabled ? "Save schedule" : "Start schedule"}
        </Button>
        {!!schedule?.enabled && (
          <Button
            variant="ghost"
            data-testid="context-runtime-schedule-pause"
            disabled={save.isPending}
            onClick={() => save.mutate(true)}
          >
            Pause schedule
          </Button>
        )}
      </div>
      <details className="text-sm text-muted-foreground">
        <summary
          className="cursor-pointer text-foreground"
          data-testid="context-runtime-schedule-details"
        >
          How schedules work
        </summary>
        <p className="mt-2">
          Runs one job at a time. Missed runs are combined into one catch-up. Pausing or editing
          cancels queued work; a job that has started finishes normally. Scheduled reports are
          private to whoever last saved the schedule. Manual reports are private to the person who
          started the run.
        </p>
      </details>
    </div>
  )
}
