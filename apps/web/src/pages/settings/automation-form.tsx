import { useQuery } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { useMemo, useState } from "react"
import { type Automation, type AutomationRef, type AutomationTrigger, api } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { agentsQuery, automationsQuery, runsQuery, targetPickerQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { EVENT_KINDS, SCHEDULE_PRESETS } from "./automation-format"

// The automation form, shared by the Settings manager (create + edit) and the
// per-artifact Automate dialog. Targets are first-class here — a doc picker and a
// tag input — so target-scoped automations no longer require starting from a doc's
// ⋯ menu. Write mode rides ON the targets (never a field): the mode select stamps
// `mode:"publish"` onto every target at submit; the default is always propose.
// Pass `automation` to edit in place (PATCH), `refs` to seed targets (the dialog).

/** A target being edited, with a display label (picker adds know titles; seeds and
 *  edit-loads fall back to the id). Modes are stripped on load and re-stamped at
 *  submit from the single mode select. */
type Target = { ref: AutomationRef; label: string }

const stripMode = (r: AutomationRef): AutomationRef => {
  const { mode: _mode, ...rest } = r
  return rest as AutomationRef
}
const keyOf = (r: AutomationRef): string =>
  r.kind === "tag" ? `tag:${r.tag}` : `${r.kind}:${r.id}`

export function AutomationForm({
  refs,
  defaultInstruction,
  submitLabel,
  automation,
  onDone,
}: {
  refs?: string[]
  defaultInstruction?: string
  submitLabel?: string
  /** Present ⇒ edit this automation in place instead of creating. */
  automation?: Automation
  onDone: () => void
}) {
  const { data: agents, isError: agentsError } = useQuery(agentsQuery())
  const [agentId, setAgentId] = useState(automation?.agent_id ?? "")
  const [instruction, setInstruction] = useState(
    automation?.instruction ?? defaultInstruction ?? "",
  )
  const [kind, setKind] = useState<AutomationTrigger["kind"]>(automation?.trigger.kind ?? "manual")
  const [cron, setCron] = useState<string>(automation?.trigger.cron ?? SCHEDULE_PRESETS[0].cron)
  const [on, setOn] = useState<string>(automation?.trigger.on ?? EVENT_KINDS[0].id)
  const [mode, setMode] = useState<"propose" | "publish">(
    automation?.refs.some((r) => r.mode === "publish") ? "publish" : "propose",
  )
  const [targets, setTargets] = useState<Target[]>(() => {
    const seed = automation?.refs ?? refs?.map((id) => ({ kind: "artifact" as const, id }))
    return (seed ?? []).map((r) => ({
      ref: stripMode(r),
      label: r.kind === "tag" ? `#${r.tag}` : r.id,
    }))
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState("")
  const [tagDraft, setTagDraft] = useState("")
  const picker = useQuery(targetPickerQuery(pickerQ))
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", [])

  const addTarget = (t: Target) =>
    setTargets((cur) => (cur.some((x) => keyOf(x.ref) === keyOf(t.ref)) ? cur : [...cur, t]))
  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase()
    if (tag === "") return
    addTarget({ ref: { kind: "tag", tag }, label: `#${tag}` })
    setTagDraft("")
  }

  const buildTrigger = (): AutomationTrigger =>
    kind === "schedule" ? { kind, cron, tz } : kind === "event" ? { kind, on } : { kind }
  // Write mode is an attribute OF the targets: stamp the explicit publish opt-in on
  // every target at submit; propose is the default and stays unstored (canonical).
  const buildRefs = (): AutomationRef[] =>
    targets.map((t) => (mode === "publish" ? { ...t.ref, mode: "publish" as const } : t.ref))

  const save = useApiMutation({
    mutationFn: () =>
      automation
        ? api.updateAutomation(automation.id, {
            agentId,
            trigger: buildTrigger(),
            instruction: instruction.trim(),
            refs: buildRefs(),
          })
        : api.createAutomation({
            agentId,
            trigger: buildTrigger(),
            instruction: instruction.trim(),
            refs: buildRefs(),
          }),
    success: automation ? "Automation updated" : "Automation created",
    // Invalidate HERE, not in each caller — the artifact dialog and the settings manager
    // both write through this form, and a change from either must refresh both views.
    invalidate: [automationsQuery().queryKey, runsQuery().queryKey],
    onSuccess: () => {
      if (!automation) setInstruction(defaultInstruction ?? "")
      onDone()
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
        {targets.length > 0 && (
          <Select value={mode} onValueChange={(v) => setMode(v as "propose" | "publish")}>
            <SelectTrigger data-testid="automation-mode" aria-label="Write mode" className="w-45">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="propose">Propose for review</SelectItem>
              <SelectItem value="publish">Publish live</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      <Textarea
        data-testid="automation-instruction"
        aria-label="Instruction"
        placeholder="What should the agent do? e.g. Keep this doc's dates and statuses current."
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={2}
      />

      {/* Targets: which docs it revises, which tags stamp (and archive) its output. A doc
          target means "revise this"; a tag-only target set means new work is created and
          stamped — the tag query is the archive. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {targets.map((t, i) => (
          <Badge key={keyOf(t.ref)} variant="outline" className="gap-1 pr-1">
            <span className="max-w-40 truncate">{t.label}</span>
            <button
              type="button"
              data-testid={`automation-target-remove-${i}`}
              aria-label={`Remove ${t.label}`}
              className="rounded-sm p-0.5 hover:bg-accent"
              onClick={() => setTargets((cur) => cur.filter((x) => keyOf(x.ref) !== keyOf(t.ref)))}
            >
              <X className="size-3" aria-hidden />
            </button>
          </Badge>
        ))}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button data-testid="automation-add-doc" variant="ghost" size="sm">
              <Plus className="size-3.5" aria-hidden /> Doc
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                data-testid="automation-target-search"
                placeholder="Search docs…"
                value={pickerQ}
                onValueChange={setPickerQ}
              />
              <CommandList>
                {picker.isError ? (
                  <CommandEmpty>Couldn't search docs. Try again.</CommandEmpty>
                ) : (
                  <CommandEmpty>No docs found.</CommandEmpty>
                )}
                {(picker.data?.artifacts ?? []).map((a) => (
                  <CommandItem
                    key={a.short_id}
                    value={a.short_id}
                    onSelect={() => {
                      addTarget({
                        ref: { kind: "artifact", id: a.short_id },
                        label: a.title || a.short_id,
                      })
                      setPickerOpen(false)
                      setPickerQ("")
                    }}
                  >
                    <span className="truncate">{a.title || a.short_id}</span>
                    <span className="ml-auto font-mono text-2xs text-muted-foreground">
                      {a.short_id}
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <div className="flex items-center gap-1">
          <Input
            data-testid="automation-tag-input"
            aria-label="Add tag target"
            placeholder="tag…"
            className="h-8 w-28"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addTag()
              }
            }}
          />
          <Button
            data-testid="automation-add-tag"
            variant="ghost"
            size="sm"
            onClick={addTag}
            disabled={tagDraft.trim() === ""}
          >
            <Plus className="size-3.5" aria-hidden /> Tag
          </Button>
        </div>
      </div>

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
          onClick={() => ready && save.mutate()}
          loading={save.isPending}
          disabled={save.isPending || !ready}
        >
          {save.isPending
            ? "Saving…"
            : (submitLabel ?? (automation ? "Save changes" : "Create automation"))}
        </Button>
      </div>
    </div>
  )
}
