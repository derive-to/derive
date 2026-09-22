import type { AutomationRecord } from "@derive/core"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { contextRuntimeQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

export function RuntimeScheduleCard({
  contextId,
  schedule,
  nextRunAt,
}: {
  contextId: string
  schedule: AutomationRecord | null
  nextRunAt: string | null
}) {
  const queryClient = useQueryClient()
  const trigger = schedule ? JSON.parse(schedule.trigger) : null
  const saved = {
    instruction: schedule?.instruction ?? "",
    provider: schedule?.provider ?? "codex",
    cron: String(trigger?.cron ?? "0 9 * * *"),
    timezone: String(trigger?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    revision: schedule?.revision ?? null,
  }
  // Capture the revision on the first edit. Polling may refresh the saved definition,
  // but must neither erase the draft nor silently authorize overwriting another edit.
  const [draft, setDraft] = useState<typeof saved | null>(null)
  const values = draft ?? saved
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
    <div data-testid="context-runtime-schedule" className="flex flex-col gap-3 border-t pt-3">
      <h3 className="text-sm font-medium">Schedule</h3>
      <p className="text-xs text-muted-foreground">
        Runs one job at a time. If several runs are missed, it catches up once. Pausing or editing
        cancels queued work. A job that has started finishes normally. Reports are private to
        whoever last saved this schedule.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Recurring task
        <Textarea
          data-testid="context-runtime-schedule-instruction"
          value={instruction}
          maxLength={16000}
          onChange={(e) => setDraft({ ...values, instruction: e.target.value })}
          disabled={save.isPending}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Scheduled agent
        <select
          data-testid="context-runtime-schedule-provider"
          value={provider}
          className="rounded-md border bg-background p-2 text-sm"
          disabled={save.isPending}
          onChange={(e) =>
            setDraft({ ...values, provider: e.target.value as "codex" | "claude-code" })
          }
        >
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Cron expression
        <Input
          data-testid="context-runtime-schedule-cron"
          value={cron}
          disabled={save.isPending}
          onChange={(e) => setDraft({ ...values, cron: e.target.value })}
          placeholder="0 9 * * *"
        />
        <span className="text-xs text-muted-foreground">
          Minute, hour, day, month, weekday. 0 9 * * * means every day at 9 AM.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Timezone
        <Input
          data-testid="context-runtime-schedule-timezone"
          value={timezone}
          disabled={save.isPending}
          onChange={(e) => setDraft({ ...values, timezone: e.target.value })}
          placeholder="America/New_York"
        />
      </label>
      {schedule && (
        <p className="text-xs text-muted-foreground">
          {schedule.enabled && nextRunAt
            ? `Next run: ${new Date(nextRunAt).toLocaleString(undefined, { timeZone: trigger.tz })} (${trigger.tz})`
            : "Schedule paused"}
        </p>
      )}
      {stale && (
        <div className="text-xs text-muted-foreground">
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
      <Button
        data-testid="context-runtime-schedule-save"
        disabled={
          save.isPending || stale || !instruction.trim() || !cron.trim() || !timezone.trim()
        }
        onClick={() => save.mutate(false)}
      >
        {schedule?.enabled ? "Save schedule" : "Start schedule"}
      </Button>
      {!!schedule?.enabled && (
        <Button
          variant="outline"
          data-testid="context-runtime-schedule-pause"
          disabled={save.isPending}
          onClick={() => save.mutate(true)}
        >
          Pause schedule
        </Button>
      )}
    </div>
  )
}
