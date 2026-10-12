import { useState } from "react"
import { type AgentTrigger, api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApiMutation } from "@/lib/use-api-mutation"

/** One schedule flow on a task page or an expanded task row. */
export function TaskSchedule({
  agentId,
  instruction,
  triggers,
}: {
  agentId: string
  instruction: string
  triggers: AgentTrigger[]
}) {
  const [open, setOpen] = useState(false)
  const [time, setTime] = useState("09:00")
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const saved = triggers.find(
    (t) => t.kind === "schedule" && t.enabled && t.instruction === instruction,
  )
  const save = useApiMutation({
    errorToast: false,
    mutationFn: async () => {
      const [hour, minute] = time.split(":").map(Number)
      const cron = `${minute} ${hour} * * *`
      const current = await api.getAgent(agentId)
      const found = current.triggers.find(
        (t) => t.cron === cron && t.tz === tz && t.instruction === instruction,
      )
      return found
        ? found.enabled
          ? found
          : api.updateTrigger(found.id, { enabled: true })
        : api.addTrigger(agentId, { cron, tz, instruction })
    },
    invalidate: [["agents"]],
    onSuccess: () => setOpen(false),
  })
  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="ghost"
        size="sm"
        data-testid="task-make-daily"
        disabled={!!saved}
        onClick={() => setOpen(!open)}
      >
        {saved ? "On a schedule" : "Make this daily"}
      </Button>
      {open && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (time && !save.isPending) save.mutate()
          }}
        >
          <label className="flex flex-col gap-2 text-sm">
            Every day · {tz}
            <Input
              type="time"
              required
              value={time}
              data-testid="task-schedule-time"
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" data-testid="task-schedule-save" loading={save.isPending}>
            Let’s go
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="task-schedule-cancel"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            The next run starts at this time. Each run gets its own task and conversation.
          </p>
          {save.error && (
            <p role="alert" className="w-full text-sm text-destructive">
              {save.error.message}
            </p>
          )}
        </form>
      )}
    </div>
  )
}
