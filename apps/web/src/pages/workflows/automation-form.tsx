import { useQueries, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { FileText, FolderOpen, Hash, Plug, Plus, X } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { type Automation, type AutomationRef, type AutomationTrigger, api } from "@/api"
import { SecretReveal } from "@/components/shared/secret-reveal"
import { Eyebrow } from "@/components/shared/section-eyebrow"
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
import {
  agentsQuery,
  artifactQuery,
  automationConnectionsQuery,
  automationsQuery,
  collectionsQuery,
  contextsQuery,
  modelCredentialsQuery,
  runsQuery,
  targetPickerQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { EVENT_KINDS, SCHEDULE_PRESETS } from "./automation-format"

// Shared by the Workflow directory and the per-artifact Automate dialog. Targets determine where
// a run writes: artifacts receive revisions, collections receive new artifacts, and tags classify
// and archive the artifacts a run produces. Pass `automation` to edit an existing definition.

/** A chosen target plus a display label. Titles resolve lazily (see below). */
type Target = { ref: AutomationRef; label: string }

const keyOf = (r: AutomationRef): string =>
  r.kind === "tag" ? `tag:${r.tag}` : `${r.kind}:${r.id}`
const seedLabel = (r: AutomationRef): string => (r.kind === "tag" ? `#${r.tag}` : r.id)

/** A small labelled field wrapper so the form reads as aligned groups, not a pile of controls. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow>{label}</Eyebrow>
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
  runOnCreate = false,
  onDone,
}: {
  refs?: string[]
  defaultInstruction?: string
  submitLabel?: string
  /** When present, edit this automation instead of creating one. */
  automation?: Automation
  /** Artifact-local creation can enqueue its proof run atomically. */
  runOnCreate?: boolean
  onDone: () => void
}) {
  const { data: agents, isError: agentsError } = useQuery(agentsQuery())
  // An empty id creates a dedicated Agent. Existing automations retain their assigned Agent.
  const [agentId, setAgentId] = useState(automation?.agent_id ?? "")
  // A newly minted Agent's bearer is shown once. Keep the form open until it is acknowledged.
  const [mintedToken, setMintedToken] = useState<string | null>(null)
  const [instruction, setInstruction] = useState(
    automation?.instruction ?? defaultInstruction ?? "",
  )
  const directAction = automation?.trigger.action
  const [workflowType, setWorkflowType] = useState<"agent" | "github_workflow">(
    directAction ? "github_workflow" : "agent",
  )
  const [repository, setRepository] = useState(
    directAction ? `${directAction.owner}/${directAction.repo}` : "",
  )
  const [workflowFile, setWorkflowFile] = useState(directAction?.workflow ?? "")
  const [workflowRef, setWorkflowRef] = useState(directAction?.ref ?? "main")
  const [workflowInputs, setWorkflowInputs] = useState(
    JSON.stringify(directAction?.inputs ?? {}, null, 2),
  )
  // Existing automations retain their provider. API clients that omit one retain the server's
  // Claude default.
  const [provider, setProvider] = useState<Automation["provider"]>(automation?.provider ?? "codex")
  const [contextId, setContextId] = useState(automation?.context_id ?? "")
  const [kind, setKind] = useState<AutomationTrigger["kind"]>(automation?.trigger.kind ?? "manual")
  const [cron, setCron] = useState<string>(automation?.trigger.cron ?? SCHEDULE_PRESETS[0].cron)
  const [on, setOn] = useState<string>(automation?.trigger.on ?? EVENT_KINDS[0].id)
  const [targets, setTargets] = useState<Target[]>(() => {
    const seed = automation?.refs ?? refs?.map((id) => ({ kind: "artifact" as const, id }))
    return (seed ?? []).map((r) => ({ ref: r, label: seedLabel(r) }))
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  // Ids, not objects: the row a connection resolves to can change under us (a pending source
  // signs in mid-edit), and holding the id means the label always reflects the CURRENT row.
  const [connectionIds, setConnectionIds] = useState<string[]>(automation?.connection_ids ?? [])
  const [q, setQ] = useState("")
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", [])

  const docs = useQuery(targetPickerQuery(q))
  const collections = useQuery(collectionsQuery())
  // ACTIVE only. A pending connection cannot provide tools, so offering it here would let
  // someone build an automation that silently reads nothing.
  const connections = useQuery(automationConnectionsQuery())
  const contexts = useQuery(contextsQuery())
  const modelCredentials = useQuery(modelCredentialsQuery())
  const personalPlan = modelCredentials.data?.find((c) => c.provider === provider)
  const runConnections = useMemo(
    () => (connections.data ?? []).filter((c) => c.status === "active"),
    [connections.data],
  )
  const githubConnections = useMemo(
    () => runConnections.filter((connection) => connection.kind === "github_app"),
    [runConnections],
  )
  const [githubConnectionId, setGithubConnectionId] = useState(
    directAction ? (automation?.connection_ids[0] ?? "") : "",
  )
  const connectionLabel = (id: string): string =>
    runConnections.find((connection) => connection.id === id)?.toolkit ??
    "a disconnected connection"
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

  const parsedRepository = repository.trim().split("/")
  const parsedInputs = (() => {
    try {
      const value = JSON.parse(workflowInputs) as unknown
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, string | number | boolean>)
        : null
    } catch {
      return null
    }
  })()
  const buildTrigger = (): AutomationTrigger => {
    if (workflowType === "github_workflow")
      return {
        kind: "manual",
        action: {
          kind: "github_workflow",
          owner: parsedRepository[0] ?? "",
          repo: parsedRepository[1] ?? "",
          workflow: workflowFile.trim(),
          ref: workflowRef.trim(),
          ...(parsedInputs && Object.keys(parsedInputs).length ? { inputs: parsedInputs } : {}),
        },
      }
    return kind === "schedule" ? { kind, cron, tz } : kind === "event" ? { kind, on } : { kind }
  }
  const buildRefs = (): AutomationRef[] => targets.map((t) => t.ref)

  const save = useApiMutation({
    mutationFn: () => {
      const body = {
        ...(workflowType === "agent" && !contextId && agentId ? { agentId } : {}),
        provider,
        ...(workflowType === "agent" && contextId ? { contextId } : {}),
        trigger: buildTrigger(),
        instruction:
          workflowType === "github_workflow"
            ? `Run ${repository.trim()} · ${workflowFile.trim()}`
            : instruction.trim(),
        ...(!automation && runOnCreate ? { runNow: true } : {}),
        refs: workflowType === "agent" ? buildRefs() : [],
        connectionIds: workflowType === "agent" ? connectionIds : [githubConnectionId],
      }
      return automation
        ? api.updateAutomation(automation.id, {
            ...body,
            contextId: contextId || null,
            ...(!contextId ? { agentId } : {}),
          })
        : api.createAutomation(body)
    },
    success: automation
      ? "Workflow updated"
      : runOnCreate
        ? "Workflow created and queued"
        : "Workflow created",
    // Invalidate HERE, not in each caller — both the manager and the artifact dialog write
    // through this form, and a change from either must refresh both views.
    invalidate: [automationsQuery().queryKey, runsQuery().queryKey],
    onSuccess: (a) => {
      // NOT reset. Blanking the instruction back to its default left a filled-in create form
      // sitting behind the token panel, which reads as "that did not take, press it again" —
      // an invitation to create the same automation twice. The form either closes (onDone) or
      // holds on the token panel, and in both cases what was typed should stay on screen.
      //
      // An auto-minted runner token arrives exactly once — hold the form open on
      // its panel; onDone fires from its Done button instead.
      const token = (a as { agent_token?: string }).agent_token
      // A hosted first run uses a short-lived run capability, not this standing bearer. Do not
      // interrupt the one-click flow with a token it does not need; local polling setups still
      // receive the existing one-time token panel.
      if (!automation && token && !runOnCreate) {
        setMintedToken(token)
        return
      }
      onDone()
    },
  })
  // Edit keeps requiring its agent; create no longer needs one (auto-mint), and a
  // roster error only blocks someone who actually picked a service agent.
  const directReady =
    parsedRepository.length === 2 &&
    parsedRepository.every(Boolean) &&
    workflowFile.trim() !== "" &&
    workflowRef.trim() !== "" &&
    githubConnectionId !== "" &&
    parsedInputs !== null
  const ready =
    workflowType === "github_workflow"
      ? directReady
      : instruction.trim() !== "" && (automation ? agentId !== "" : !(agentId && agentsError))

  return (
    <div className="flex flex-col gap-4">
      <Field label="Workflow type">
        <Select
          value={workflowType}
          onValueChange={(value) => setWorkflowType(value as "agent" | "github_workflow")}
        >
          <SelectTrigger data-testid="automation-type" aria-label="Workflow type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="github_workflow">GitHub Actions</SelectItem>
            <SelectItem value="agent">Agent instruction</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {workflowType === "github_workflow" ? (
        <>
          <Field label="GitHub connection">
            <Select value={githubConnectionId} onValueChange={setGithubConnectionId}>
              <SelectTrigger
                data-testid="automation-github-connection"
                aria-label="GitHub connection"
              >
                <SelectValue placeholder="Select a GitHub App installation" />
              </SelectTrigger>
              <SelectContent>
                {githubConnections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.scopes_label ?? "GitHub App"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!connections.isPending && githubConnections.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Connect GitHub under Settings → Integrations first.
              </p>
            ) : null}
          </Field>
          <Field label="Repository" hint="Use owner/repository, for example Niftory/sift.">
            <Input
              data-testid="automation-github-repository"
              aria-label="Repository"
              placeholder="owner/repository"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
            />
          </Field>
          <Field
            label="Workflow file"
            hint="For safety, the file name must start with derive- and end with .yml or .yaml."
          >
            <Input
              data-testid="automation-github-workflow"
              aria-label="Workflow file"
              placeholder="derive-tests.yml"
              value={workflowFile}
              onChange={(event) => setWorkflowFile(event.target.value)}
            />
          </Field>
          <Field label="Git ref">
            <Input
              data-testid="automation-github-ref"
              aria-label="Git ref"
              placeholder="main"
              value={workflowRef}
              onChange={(event) => setWorkflowRef(event.target.value)}
            />
          </Field>
          <Field
            label="Inputs"
            hint="Optional JSON object. Values can be text, numbers, or booleans."
          >
            <Textarea
              data-testid="automation-github-inputs"
              aria-label="Inputs"
              value={workflowInputs}
              onChange={(event) => setWorkflowInputs(event.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
            {parsedInputs === null ? (
              <p className="text-xs text-destructive">Enter a valid JSON object.</p>
            ) : null}
          </Field>
        </>
      ) : (
        <>
          <Field
            label="Use a Context"
            hint="Optional. A Context packages reusable instructions, repository pointers, skills, and permitted sources for complex work."
          >
            <Select
              value={contextId || "none"}
              onValueChange={(v) => setContextId(v === "none" ? "" : v)}
              disabled={contexts.isPending || contexts.isError}
            >
              <SelectTrigger
                data-testid="automation-context"
                aria-label="Use a Context"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Context · use this instruction directly</SelectItem>
                {(contexts.data ?? []).map((context) => (
                  <SelectItem key={context.id} value={context.id}>
                    {context.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!contexts.isPending && !contexts.isError && (contexts.data ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">
                Need a reusable method for this job?{" "}
                <Link
                  to="/contexts/new"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Create a Context in a new tab
                </Link>
                .
              </p>
            )}
          </Field>

          {!contextId && (automation || (agents ?? []).some((a) => !a.managed)) && (
            <Field label="Execution connection">
              <Select
                value={agentId || "auto"}
                onValueChange={(v) => setAgentId(v === "auto" ? "" : v)}
              >
                <SelectTrigger
                  data-testid="automation-agent"
                  aria-label="Execution connection"
                  className="w-full"
                >
                  <SelectValue placeholder="Dedicated connection" />
                </SelectTrigger>
                <SelectContent>
                  {!automation && (
                    <SelectItem value="auto">Dedicated connection (default)</SelectItem>
                  )}
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

          <Field
            label="Runs with"
            hint="The selected coding agent executes through an available connected or hosted runner."
          >
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as Automation["provider"])}
            >
              <SelectTrigger
                data-testid="automation-provider"
                aria-label="Runs with"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="claude-code">Claude Code</SelectItem>
              </SelectContent>
            </Select>
            <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
              {modelCredentials.isPending ? (
                <span>Checking your connected model plans…</span>
              ) : personalPlan ? (
                <span>
                  {provider === "codex" ? "Codex" : "Claude"} plan connected · {personalPlan.hint}
                </span>
              ) : (
                <span>
                  {modelCredentials.isError
                    ? "Couldn't check your personal plan. "
                    : `No personal ${provider === "codex" ? "Codex" : "Claude"} plan connected. `}
                  An agent owner or shared workspace plan may still cover this run, or you can{" "}
                  <Link
                    to="/settings/$section"
                    params={{ section: "model-plans" }}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    connect yours in a new tab
                  </Link>
                  .
                </span>
              )}
            </div>
          </Field>

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
            label="Connections"
            hint="Connected tools this run can use. Add GitHub under Integrations, or add any runner adapter as an MCP source."
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {connectionIds.map((id) => (
                <Badge key={id} variant="outline" className="h-6 gap-1 pr-1 pl-1.5 font-normal">
                  <Plug className="size-3.5 text-muted-foreground" aria-hidden />
                  <span className="max-w-40 truncate">{connectionLabel(id)}</span>
                  <button
                    type="button"
                    data-testid={`automation-source-remove-${id}`}
                    aria-label={`Remove ${connectionLabel(id)}`}
                    className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setConnectionIds((cur) => cur.filter((x) => x !== id))}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              ))}
              {runConnections.length > connectionIds.length ? (
                <Popover open={connectionsOpen} onOpenChange={setConnectionsOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      data-testid="automation-add-source"
                      variant="outline"
                      size="sm"
                      className="h-6"
                    >
                      <Plus className="size-3.5" aria-hidden /> Add source
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search connections…" />
                      <CommandList>
                        <CommandEmpty>No matches.</CommandEmpty>
                        <CommandGroup>
                          {runConnections
                            .filter((c) => !connectionIds.includes(c.id))
                            .map((c) => (
                              <CommandItem
                                key={c.id}
                                value={c.toolkit}
                                data-testid={`automation-source-${c.id}`}
                                onSelect={() => {
                                  setConnectionIds((cur) => [...cur, c.id])
                                  setConnectionsOpen(false)
                                }}
                              >
                                <Plug className="size-3.5 text-muted-foreground" aria-hidden />
                                <span className="truncate">{c.toolkit}</span>
                                <span className="ml-auto max-w-36 truncate text-2xs text-muted-foreground">
                                  {c.scopes_label ?? c.base_url ?? c.kind ?? ""}
                                </span>
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              ) : runConnections.length === 0 ? (
                // Said plainly rather than hidden: a run with no connection can only read what is
                // already in Derive, and that is the difference this field exists to explain.
                <span className="text-muted-foreground text-xs">
                  No connections yet. Add GitHub under Settings → Integrations or an MCP source
                  under Settings → Sources.
                </span>
              ) : null}
            </div>
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
                        <CommandGroup heading="Artifacts">
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
                              <span className="ml-auto text-2xs text-muted-foreground">
                                {c.count}
                              </span>
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
                              addTarget({
                                ref: { kind: "tag", tag: tagDraft },
                                label: `#${tagDraft}`,
                              })
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
        </>
      )}

      {mintedToken && (
        <div data-testid="automation-agent-token">
          <SecretReveal
            title="Copy this runner token now. It will not be shown again."
            secret={mintedToken}
            onDone={() => {
              setMintedToken(null)
              onDone()
            }}
            copyTestId="automation-agent-token-copy"
            doneTestId="automation-agent-token-done"
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
            : (submitLabel ??
              (automation ? "Save changes" : runOnCreate ? "Create & run now" : "Create workflow"))}
        </Button>
      </div>
    </div>
  )
}
