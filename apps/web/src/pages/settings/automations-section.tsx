import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Zap } from "lucide-react"
import { useMemo, useState } from "react"
import { type Automation, type AutomationTrigger, api, type Run } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { agentsQuery, automationsQuery, runsQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import {
  EVENT_KINDS,
  runOutcome,
  runStatusLabel,
  SCHEDULE_PRESETS,
  triggerLabel,
} from "./automation-format"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

export function AutomationsSection() {
  const qc = useQueryClient()
  const { data: automations, isPending, isError, refetch } = useQuery(automationsQuery())
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
          Every run lands in the activity below.
        </>
      }
    >
      <NewAutomation onCreated={reload} />

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
        <EmptyState>No automations yet. Create one above.</EmptyState>
      ) : (
        <SettingsGroup>
          {automations.map((a) => (
            <AutomationRow key={a.id} automation={a} onDone={reload} />
          ))}
        </SettingsGroup>
      )}

      <Activity />
    </SettingsSection>
  )
}

function NewAutomation({ onCreated }: { onCreated: () => void }) {
  const { data: agents } = useQuery(agentsQuery())
  const [agentId, setAgentId] = useState("")
  const [instruction, setInstruction] = useState("")
  const [kind, setKind] = useState<AutomationTrigger["kind"]>("manual")
  const [cron, setCron] = useState<string>(SCHEDULE_PRESETS[0].cron)
  const [on, setOn] = useState<string>(EVENT_KINDS[0].id)
  const [route, setRoute] = useState<"auto" | "proposal">("proposal")
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", [])

  const buildTrigger = (): AutomationTrigger =>
    kind === "schedule" ? { kind, cron, tz } : kind === "event" ? { kind, on } : { kind }

  const create = useApiMutation({
    mutationFn: () =>
      api.createAutomation({
        agentId,
        trigger: buildTrigger(),
        instruction: instruction.trim(),
        route,
      }),
    success: "Automation created",
    onSuccess: () => {
      setInstruction("")
      onCreated()
    },
  })
  const ready = agentId !== "" && instruction.trim() !== ""

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap gap-2">
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger data-testid="automation-agent" aria-label="Agent" className="w-45">
            <SelectValue placeholder="Pick an agent" />
          </SelectTrigger>
          <SelectContent>
            {(agents ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                @{a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={route} onValueChange={(v) => setRoute(v as "auto" | "proposal")}>
          <SelectTrigger data-testid="automation-route" aria-label="Route" className="w-45">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="proposal">Propose for review</SelectItem>
            <SelectItem value="auto">Publish, then review</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Textarea
        data-testid="automation-instruction"
        aria-label="Instruction"
        placeholder="What should the agent do? e.g. Keep this doc's dates and statuses current."
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={2}
      />

      <Tabs value={kind} onValueChange={(v) => setKind(v as AutomationTrigger["kind"])}>
        <TabsList>
          <TabsTrigger data-testid="automation-trigger-manual" value="manual">
            Manual
          </TabsTrigger>
          <TabsTrigger data-testid="automation-trigger-schedule" value="schedule">
            Schedule
          </TabsTrigger>
          <TabsTrigger data-testid="automation-trigger-event" value="event">
            Event
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {kind === "manual" && (
        <p className="text-sm text-muted-foreground">Runs only when you press Run now.</p>
      )}
      {kind === "schedule" && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={cron} onValueChange={setCron}>
            <SelectTrigger data-testid="automation-schedule" aria-label="Schedule" className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.cron}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="font-mono text-2xs text-muted-foreground">{tz}</span>
        </div>
      )}
      {kind === "event" && (
        <Select value={on} onValueChange={setOn}>
          <SelectTrigger data-testid="automation-event" aria-label="Event" className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENT_KINDS.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex justify-end">
        <Button
          data-testid="automation-create"
          variant="secondary"
          size="sm"
          onClick={() => ready && create.mutate()}
          loading={create.isPending}
          disabled={create.isPending || !ready}
        >
          {create.isPending ? "Creating…" : "Create automation"}
        </Button>
      </div>
    </div>
  )
}

function AutomationRow({ automation, onDone }: { automation: Automation; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const run = useApiMutation({
    mutationFn: () => api.runAutomation(automation.id),
    success: "Run queued",
    onSuccess: () => onDone(),
  })
  const remove = useApiMutation({
    mutationFn: () => api.deleteAutomation(automation.id),
    success: "Automation removed",
    onSuccess: () => onDone(),
  })
  return (
    <div data-testid={`automation-row-${automation.id}`} className="flex items-center gap-3 py-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent">
        <Zap className="size-4 text-muted-foreground" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <span className="truncate">{automation.instruction}</span>
          <Badge variant="secondary">{triggerLabel(automation.trigger)}</Badge>
        </div>
        <div className="text-sm text-muted-foreground">
          Runs as this workspace's agent ·{" "}
          {automation.route === "auto" ? "publishes for review" : "proposes"}
        </div>
      </div>
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
      <Button
        data-testid={`automation-remove-${automation.id}`}
        variant="destructive-ghost"
        size="sm"
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
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
  const { data: runs, isPending } = useQuery(runsQuery())
  if (isPending) return null
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
            className="flex items-center gap-3 border-b py-2.5 text-sm last:border-0"
          >
            <RunStatus status={r.status} />
            <span className="min-w-0 truncate text-muted-foreground">{r.reason}</span>
            {runOutcome(r.meta) && <Badge variant="outline">{runOutcome(r.meta)}</Badge>}
            <span className="ml-auto font-mono text-2xs text-muted-foreground">
              {ago(r.created_at)}
            </span>
          </li>
        ))}
      </ul>
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
