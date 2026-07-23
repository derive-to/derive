import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { type AutomationTrigger, api } from "@/api"
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
import { agentsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { EVENT_KINDS, SCHEDULE_PRESETS } from "./automation-format"

// The create-automation form, shared by the Settings manager and the per-artifact Automate
// dialog. Pass `refs` to scope the automation to specific artifacts (the per-artifact flow)
// and `defaultInstruction` to seed the box. Renders just the fields — the caller frames it.

export function AutomationForm({
  refs,
  defaultInstruction,
  submitLabel = "Create automation",
  onCreated,
}: {
  refs?: string[]
  defaultInstruction?: string
  submitLabel?: string
  onCreated: () => void
}) {
  const { data: agents, isError: agentsError } = useQuery(agentsQuery())
  const [agentId, setAgentId] = useState("")
  const [instruction, setInstruction] = useState(defaultInstruction ?? "")
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
        refs,
        route,
      }),
    success: "Automation created",
    onSuccess: () => {
      setInstruction(defaultInstruction ?? "")
      onCreated()
    },
  })
  const ready = agentId !== "" && instruction.trim() !== "" && !agentsError

  return (
    <div className="flex flex-col gap-3">
      {agentsError && (
        <p className="text-sm text-destructive">Couldn't load agents. Reload and try again.</p>
      )}
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
          {create.isPending ? "Creating…" : submitLabel}
        </Button>
      </div>
    </div>
  )
}
