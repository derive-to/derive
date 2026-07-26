import { useQueries, useQuery } from "@tanstack/react-query"
import { FileText, FolderOpen, Hash, Plus, X } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { type Automation, type AutomationRef, type AutomationTrigger, api } from "@/api"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  agentsQuery,
  artifactQuery,
  automationsQuery,
  collectionsQuery,
  runsQuery,
  targetPickerQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { EVENT_KINDS, SCHEDULE_PRESETS, stampMode } from "./automation-format"

// The automation form, shared by the Settings manager (create + edit) and the per-artifact
// Automate dialog. Targets are first-class: one "Add target" search over documents and
// collections, plus free tags — a doc is revised, a collection receives new editions, a tag
// stamps (and archives) whatever the run writes. Write mode rides ON the targets (never a
// field of its own): the mode select stamps `mode:"publish"` onto every target at submit;
// propose is the default and stays unstored. Pass `automation` to edit in place (PATCH).

/** A chosen target plus a display label. Modes are stripped on load and re-applied at submit
 *  from the single mode select; titles resolve lazily (see below). */
type Target = { ref: AutomationRef; label: string }

const stripMode = (r: AutomationRef): AutomationRef => {
  const { mode: _mode, ...rest } = r
  return rest as AutomationRef
}
const keyOf = (r: AutomationRef): string =>
  r.kind === "tag" ? `tag:${r.tag}` : `${r.kind}:${r.id}`
const seedLabel = (r: AutomationRef): string => (r.kind === "tag" ? `#${r.tag}` : r.id)

/** A small labelled field wrapper so the form reads as aligned groups, not a pile of controls. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
      {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function TargetIcon({ kind }: { kind: AutomationRef["kind"] }) {
  const Icon = kind === "collection" ? FolderOpen : kind === "tag" ? Hash : FileText
  return <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
}

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
  // "" = auto-mint on create (the default; nobody picks an agent). Edit mode keeps
  // the automation's existing agent. A non-empty id = run as a service agent.
  const [agentId, setAgentId] = useState(automation?.agent_id ?? "")
  // The minted agent's bearer, shown exactly once; onDone waits for Done so the
  // token's only display can't be lost to the dialog closing.
  const [mintedToken, setMintedToken] = useState<string | null>(null)
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
    return (seed ?? []).map((r) => ({ ref: stripMode(r), label: seedLabel(r) }))
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [q, setQ] = useState("")
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", [])

  const docs = useQuery(targetPickerQuery(q))
  const collections = useQuery(collectionsQuery())
  const collectionMatches = useMemo(() => {
    const all = collections.data ?? []
    const needle = q.trim().toLowerCase()
    return (needle ? all.filter((c) => c.title.toLowerCase().includes(needle)) : all).slice(0, 6)
  }, [collections.data, q])
  const tagDraft = q.trim().toLowerCase().replace(/^#/, "")

  // Resolve real titles for targets seeded from an edit-load (their label is the id).
  // Collections come free from the already-loaded list; documents get per-id queries
  // (cache-deduped, error-isolated — a deleted target keeps its id rather than breaking).
  const collectionTitles = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of collections.data ?? []) m[c.id] = c.title
    return m
  }, [collections.data])
  const docIds = useMemo(() => {
    const ids: string[] = []
    for (const t of targets) if (t.ref.kind === "artifact") ids.push(t.ref.id)
    return [...new Set(ids)]
  }, [targets])
  const docResults = useQueries({
    queries: docIds.map((id) => ({ ...artifactQuery(id), retry: false })),
  })
  const docTitles = useMemo(() => {
    const m: Record<string, string> = {}
    docResults.forEach((r, i) => {
      const id = docIds[i]
      if (id && r.data?.title) m[id] = r.data.title
    })
    return m
  }, [docResults, docIds])
  const labelFor = (t: Target): string => {
    if (t.ref.kind === "artifact") return docTitles[t.ref.id] ?? t.label
    if (t.ref.kind === "collection") return collectionTitles[t.ref.id] ?? t.label
    return t.label
  }

  const addTarget = (t: Target) => {
    setTargets((cur) => (cur.some((x) => keyOf(x.ref) === keyOf(t.ref)) ? cur : [...cur, t]))
    setQ("")
    setPickerOpen(false)
  }
  const removeTarget = (r: AutomationRef) =>
    setTargets((cur) => cur.filter((x) => keyOf(x.ref) !== keyOf(r)))

  const buildTrigger = (): AutomationTrigger =>
    kind === "schedule" ? { kind, cron, tz } : kind === "event" ? { kind, on } : { kind }
  const buildRefs = (): AutomationRef[] =>
    stampMode(
      targets.map((t) => t.ref),
      mode,
    )

  const save = useApiMutation({
    mutationFn: () => {
      const body = {
        ...(agentId ? { agentId } : {}),
        trigger: buildTrigger(),
        instruction: instruction.trim(),
        refs: buildRefs(),
      }
      return automation
        ? api.updateAutomation(automation.id, { agentId, ...body })
        : api.createAutomation(body)
    },
    success: automation ? "Automation updated" : "Automation created",
    // Invalidate HERE, not in each caller — both the manager and the artifact dialog write
    // through this form, and a change from either must refresh both views.
    invalidate: [automationsQuery().queryKey, runsQuery().queryKey],
    onSuccess: (a) => {
      if (!automation) setInstruction(defaultInstruction ?? "")
      // An auto-minted runner token arrives exactly once — hold the form open on
      // its panel; onDone fires from its Done button instead.
      const token = (a as { agent_token?: string }).agent_token
      if (!automation && token) {
        setMintedToken(token)
        return
      }
      onDone()
    },
  })
  // Edit keeps requiring its agent; create no longer needs one (auto-mint), and a
  // roster error only blocks someone who actually picked a service agent.
  const ready =
    instruction.trim() !== "" && (automation ? agentId !== "" : !(agentId && agentsError))

  return (
    <div className="flex flex-col gap-4">
      {(automation || (agents ?? []).some((a) => !a.managed)) && (
        <Field label="Runs as">
          <Select
            value={agentId || "auto"}
            onValueChange={(v) => setAgentId(v === "auto" ? "" : v)}
          >
            <SelectTrigger data-testid="automation-agent" aria-label="Runs as" className="w-full">
              <SelectValue placeholder="Its own agent" />
            </SelectTrigger>
            <SelectContent>
              {!automation && <SelectItem value="auto">Its own agent (default)</SelectItem>}
              {(agents ?? [])
                .filter((a) => !a.managed || a.id === automation?.agent_id)
                .map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    @{a.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Instruction">
        <Textarea
          data-testid="automation-instruction"
          aria-label="Instruction"
          placeholder="What should the agent do? e.g. Keep this doc's dates and statuses current."
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={2}
        />
      </Field>

      <Field
        label="Targets"
        hint="Documents it revises, collections it files new work into, and tags it stamps on its output."
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {targets.map((t) => (
            <Badge
              key={keyOf(t.ref)}
              variant="outline"
              className="h-6 gap-1 pr-1 pl-1.5 font-normal"
            >
              <TargetIcon kind={t.ref.kind} />
              <span className="max-w-40 truncate">{labelFor(t)}</span>
              <button
                type="button"
                data-testid={`automation-target-remove-${keyOf(t.ref)}`}
                aria-label={`Remove ${labelFor(t)}`}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => removeTarget(t.ref)}
              >
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                data-testid="automation-add-target"
                variant="outline"
                size="sm"
                className="h-6"
              >
                <Plus className="size-3.5" aria-hidden /> Add target
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  data-testid="automation-target-search"
                  placeholder="Search docs, collections, or type a tag…"
                  value={q}
                  onValueChange={setQ}
                />
                <CommandList>
                  <CommandEmpty>
                    {docs.isError ? "Couldn't search. Try again." : "No matches."}
                  </CommandEmpty>
                  {(docs.data?.artifacts ?? []).length > 0 && (
                    <CommandGroup heading="Documents">
                      {(docs.data?.artifacts ?? []).map((a) => (
                        <CommandItem
                          key={a.short_id}
                          value={`doc:${a.short_id}`}
                          onSelect={() =>
                            addTarget({
                              ref: { kind: "artifact", id: a.short_id },
                              label: a.title || a.short_id,
                            })
                          }
                        >
                          <FileText className="size-3.5 text-muted-foreground" aria-hidden />
                          <span className="truncate">{a.title || a.short_id}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {collectionMatches.length > 0 && (
                    <CommandGroup heading="Collections">
                      {collectionMatches.map((c) => (
                        <CommandItem
                          key={c.id}
                          value={`col:${c.id}`}
                          onSelect={() =>
                            addTarget({ ref: { kind: "collection", id: c.id }, label: c.title })
                          }
                        >
                          <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden />
                          <span className="truncate">{c.title}</span>
                          <span className="ml-auto text-2xs text-muted-foreground">{c.count}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {tagDraft !== "" && (
                    <CommandGroup heading="Tag">
                      <CommandItem
                        data-testid="automation-add-tag"
                        value={`tag:${tagDraft}`}
                        onSelect={() =>
                          addTarget({ ref: { kind: "tag", tag: tagDraft }, label: `#${tagDraft}` })
                        }
                      >
                        <Hash className="size-3.5 text-muted-foreground" aria-hidden />
                        <span>
                          Stamp with <span className="text-foreground">#{tagDraft}</span>
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </Field>

      {targets.length > 0 && (
        <Field label="When it writes">
          <Select value={mode} onValueChange={(v) => setMode(v as "propose" | "publish")}>
            <SelectTrigger data-testid="automation-mode" aria-label="Write mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="propose">Propose for review</SelectItem>
              <SelectItem value="publish">Publish live</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Trigger">
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
              <SelectTrigger
                data-testid="automation-schedule"
                aria-label="Schedule"
                className="w-60"
              >
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
            <SelectTrigger data-testid="automation-event" aria-label="Event" className="w-full">
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
      </Field>

      {mintedToken && (
        <div data-testid="automation-agent-token">
          <StatusPanel
            tone="warning"
            layout="inline"
            title="Runner token for this automation — copy it now, it won't be shown again."
            description={
              <code className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground">
                {mintedToken}
              </code>
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  data-testid="automation-agent-token-copy"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(mintedToken)
                    toast.success("Token copied")
                  }}
                >
                  Copy
                </Button>
                <Button
                  data-testid="automation-agent-token-done"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMintedToken(null)
                    onDone()
                  }}
                >
                  Done
                </Button>
              </div>
            }
          />
        </div>
      )}

      <div className="flex justify-end">
        <Button
          data-testid="automation-create"
          variant="secondary"
          size="sm"
          onClick={() => ready && save.mutate()}
          loading={save.isPending}
          disabled={save.isPending || !ready || !!mintedToken}
        >
          {save.isPending
            ? "Saving…"
            : (submitLabel ?? (automation ? "Save changes" : "Create automation"))}
        </Button>
      </div>
    </div>
  )
}
