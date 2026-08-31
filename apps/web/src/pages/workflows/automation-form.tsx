import { useQueries, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  Hash,
  Plug,
  Plus,
  Sparkles,
  Workflow,
  X,
} from "lucide-react"
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
  githubQuery,
  modelCredentialsQuery,
  runsQuery,
  targetPickerQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import {
  EVENT_KINDS,
  githubRepositoryError,
  githubRepositoryParts,
  githubWorkflowFileError,
  githubWorkflowRefError,
  parseGithubWorkflowInputs,
  SCHEDULE_PRESETS,
} from "./automation-format"

// Shared by the Workflow directory and the per-artifact Automate dialog. Targets determine where
// a run writes: artifacts receive revisions, collections receive new artifacts, and tags classify
// and archive the artifacts a run produces. Pass `automation` to edit an existing definition.

/** A chosen target plus a display label. Titles resolve lazily (see below). */
type Target = { ref: AutomationRef; label: string }

const keyOf = (r: AutomationRef): string =>
  r.kind === "tag" ? `tag:${r.tag}` : `${r.kind}:${r.id}`
const seedLabel = (r: AutomationRef): string => (r.kind === "tag" ? `#${r.tag}` : r.id)

/** A small labelled field wrapper so the form reads as aligned groups, not a pile of controls. */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow>{label}</Eyebrow>
      {children}
      {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function SetupStep({
  number,
  title,
  detail,
  complete = false,
}: {
  number: number
  title: string
  detail: string
  complete?: boolean
}) {
  return (
    <li className="flex min-w-0 gap-3">
      <span
        className={`grid size-6 shrink-0 place-items-center rounded-full border font-mono text-2xs ${
          complete
            ? "border-success/30 bg-success/10 text-success"
            : "bg-background text-muted-foreground"
        }`}
        aria-hidden
      >
        {complete ? <CheckCircle2 className="size-3.5" /> : number}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </li>
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
  const github = useQuery(githubQuery())
  const contexts = useQuery(contextsQuery())
  const modelCredentials = useQuery(modelCredentialsQuery())
  const personalPlan = modelCredentials.data?.find((c) => c.provider === provider)
  const runConnections = useMemo(
    () => (connections.data ?? []).filter((c) => c.status === "active"),
    [connections.data],
  )
  const githubConnections = useMemo(
    () =>
      runConnections.filter(
        (connection) => connection.kind === "github_app" && connection.toolkit === "github",
      ),
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

  const selectedGithubConnectionId =
    githubConnectionId || (githubConnections.length === 1 ? (githubConnections[0]?.id ?? "") : "")
  const parsedRepository = githubRepositoryParts(repository)
  const repositoryError = githubRepositoryError(repository)
  const workflowError = githubWorkflowFileError(workflowFile)
  const refError = githubWorkflowRefError(workflowRef)
  const parsedInputs = parseGithubWorkflowInputs(workflowInputs)
  const buildTrigger = (): AutomationTrigger => {
    if (workflowType === "github_workflow")
      return {
        kind: "manual",
        action: {
          kind: "github_workflow",
          owner: parsedRepository?.owner ?? "",
          repo: parsedRepository?.repo ?? "",
          workflow: workflowFile.trim(),
          ref: workflowRef.trim(),
          ...(parsedInputs.value && Object.keys(parsedInputs.value).length
            ? { inputs: parsedInputs.value }
            : {}),
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
        connectionIds: workflowType === "agent" ? connectionIds : [selectedGithubConnectionId],
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
        ? "Workflow created and started"
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
    parsedRepository !== null &&
    workflowError === null &&
    refError === null &&
    selectedGithubConnectionId !== "" &&
    parsedInputs.error === null
  const ready =
    workflowType === "github_workflow"
      ? directReady
      : instruction.trim() !== "" && (automation ? agentId !== "" : !(agentId && agentsError))
  const githubSetupPending = github.isPending || connections.isPending
  // A transient status-check failure must not strand an already active installation. The
  // connection row is the authority used by dispatch; the live App check is extra guidance for
  // workspaces that have not connected yet.
  const githubSetupError = !selectedGithubConnectionId && (github.isError || connections.isError)
  const connectedGithubAccount = github.data?.accounts.find(
    (account) => account.state === "active" && account.connection_id === selectedGithubConnectionId,
  )?.account_login
  const githubSetupDetail = selectedGithubConnectionId
    ? `Connected${connectedGithubAccount ? ` to ${connectedGithubAccount}` : ""} with repository-scoped access.`
    : githubSetupPending
      ? "Checking this workspace's GitHub setup…"
      : githubSetupError
        ? "Derive couldn't confirm the GitHub setup. Retry before running."
        : !github.data?.available
          ? "An instance operator must create the shared Derive GitHub App."
          : github.data.app_permissions_state === "update_required"
            ? "The App owner must grant Actions read/write and approve the update."
            : "Connect the Derive GitHub App and choose which repositories it can access."

  return (
    <div className="flex flex-col gap-4">
      <Field label="Choose how this runs">
        <Tabs
          value={workflowType}
          onValueChange={(value) => setWorkflowType(value as "agent" | "github_workflow")}
        >
          <TabsList className="grid w-full grid-cols-1 items-stretch gap-1 group-data-horizontal/tabs:h-auto sm:grid-cols-2">
            <TabsTrigger
              data-testid="automation-mode-simple"
              value="agent"
              className="h-auto min-w-0 items-start justify-start gap-2.5 px-3 py-3"
            >
              <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 text-left">
                <span className="block">Simple · AI task</span>
                <span className="block whitespace-normal font-normal text-2xs text-muted-foreground">
                  Ask, analyze, or update Derive work
                </span>
              </span>
            </TabsTrigger>
            <TabsTrigger
              data-testid="automation-mode-advanced"
              value="github_workflow"
              className="h-auto min-w-0 items-start justify-start gap-2.5 px-3 py-3"
            >
              <Workflow className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 text-left">
                <span className="block">Advanced · GitHub Action</span>
                <span className="block whitespace-normal font-normal text-2xs text-muted-foreground">
                  Dispatch a safe derive-*.yml workflow
                </span>
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Field>

      {workflowType === "github_workflow" ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border bg-muted/20 p-4" data-testid="automation-github-setup">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
                <GitBranch className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">First GitHub run</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Set this up once per workspace. Derive never exposes the App credential to a model
                  or workflow.
                </p>
                <ol className="mt-4 grid gap-3">
                  <SetupStep
                    number={1}
                    title="Connect the Derive GitHub App"
                    detail={githubSetupDetail}
                    complete={selectedGithubConnectionId !== ""}
                  />
                  <SetupStep
                    number={2}
                    title="Add a safe adapter workflow"
                    detail="On the repository's default branch, add a workflow_dispatch file named derive-*.yml."
                    complete={workflowError === null}
                  />
                  <SetupStep
                    number={3}
                    title="Choose the target and run"
                    detail="Derive mints a short-lived token for only this repository and records the GitHub run link."
                    complete={directReady}
                  />
                </ol>
              </div>
              <div className="flex shrink-0 gap-2 sm:flex-col">
                {githubSetupError ? (
                  <Button
                    data-testid="automation-github-setup-retry"
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void Promise.all([github.refetch(), connections.refetch()])}
                  >
                    Retry
                  </Button>
                ) : null}
                {!selectedGithubConnectionId ? (
                  <Button
                    data-testid="automation-github-open-integrations"
                    variant="outline"
                    size="sm"
                    asChild
                  >
                    <Link
                      to="/settings/$section"
                      params={{ section: "integrations" }}
                      target="_blank"
                    >
                      Open Integrations <ExternalLink className="size-3.5" aria-hidden />
                    </Link>
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
            <div className="min-w-0 sm:col-span-2">
              <Field
                label="GitHub connection"
                hint="The installation controls which repositories Derive can reach."
              >
                <Select
                  value={selectedGithubConnectionId}
                  onValueChange={setGithubConnectionId}
                  disabled={githubSetupPending || githubConnections.length === 0}
                >
                  <SelectTrigger
                    data-testid="automation-github-connection"
                    aria-label="GitHub connection"
                    className="w-full"
                  >
                    <SelectValue
                      placeholder={
                        githubSetupPending ? "Checking GitHub…" : "Select a GitHub App installation"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {githubConnections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.scopes_label ?? "GitHub App"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field
              label="Repository"
              hint="GitHub owner/name — not a URL."
              error={repository ? repositoryError : null}
            >
              <Input
                data-testid="automation-github-repository"
                aria-label="Repository"
                aria-invalid={repository ? repositoryError !== null : undefined}
                placeholder="Niftory/sift"
                value={repository}
                maxLength={201}
                spellCheck={false}
                autoCapitalize="none"
                onChange={(event) => setRepository(event.target.value)}
              />
            </Field>
            <Field
              label="Git ref"
              hint="Branch, tag, or commit SHA."
              error={workflowRef ? refError : null}
            >
              <Input
                data-testid="automation-github-ref"
                aria-label="Git ref"
                aria-invalid={workflowRef ? refError !== null : undefined}
                placeholder="main"
                value={workflowRef}
                maxLength={1_024}
                spellCheck={false}
                autoCapitalize="none"
                onChange={(event) => setWorkflowRef(event.target.value)}
              />
            </Field>
            <div className="min-w-0 sm:col-span-2">
              <Field
                label="Workflow file"
                hint="Only deliberately exposed derive-*.yml or derive-*.yaml files can run."
                error={workflowFile ? workflowError : null}
              >
                <Input
                  data-testid="automation-github-workflow"
                  aria-label="Workflow file"
                  aria-invalid={workflowFile ? workflowError !== null : undefined}
                  placeholder="derive-docs-refresh.yml"
                  value={workflowFile}
                  maxLength={200}
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(event) => setWorkflowFile(event.target.value)}
                />
              </Field>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <Field
                label="Inputs"
                hint="Optional JSON object; up to 25 text, number, or boolean values."
                error={parsedInputs.error}
              >
                <Textarea
                  data-testid="automation-github-inputs"
                  aria-label="Inputs"
                  aria-invalid={parsedInputs.error !== null}
                  value={workflowInputs}
                  onChange={(event) => setWorkflowInputs(event.target.value)}
                  rows={4}
                  className="min-w-0 font-mono text-xs"
                  spellCheck={false}
                />
              </Field>
            </div>
          </div>
        </div>
      ) : (
        <>
          <Field label="What should Derive do?">
            <Textarea
              data-testid="automation-instruction"
              aria-label="Instruction"
              aria-invalid={instruction.trim() ? undefined : true}
              placeholder="For example: Review this week's customer notes and update the launch brief."
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
            />
          </Field>

          <Field label="When should it run?">
            <Tabs value={kind} onValueChange={(v) => setKind(v as AutomationTrigger["kind"])}>
              <TabsList className="max-w-full">
                <TabsTrigger data-testid="automation-trigger-manual" value="manual">
                  Run on demand
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
              <p className="text-sm text-muted-foreground">
                It runs once when you create it, then only when you press Run now.
              </p>
            )}
            {kind === "schedule" && (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={cron} onValueChange={setCron}>
                  <SelectTrigger
                    data-testid="automation-schedule"
                    aria-label="Schedule"
                    className="w-60 max-w-full"
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

          <details className="group rounded-lg border bg-card">
            <summary className="cursor-pointer list-none rounded-lg px-4 py-3 text-sm font-medium outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-3">
                Optional settings
                <span className="font-normal text-xs text-muted-foreground group-open:hidden">
                  Context, model, sources, and output
                </span>
                <span className="hidden font-normal text-xs text-muted-foreground group-open:inline">
                  Hide
                </span>
              </span>
            </summary>
            <div className="grid gap-4 border-t p-4">
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
                      {provider === "codex" ? "Codex" : "Claude"} plan connected ·{" "}
                      {personalPlan.hint}
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
                                  <FileText
                                    className="size-3.5 text-muted-foreground"
                                    aria-hidden
                                  />
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
                                    addTarget({
                                      ref: { kind: "collection", id: c.id },
                                      label: c.title,
                                    })
                                  }
                                >
                                  <FolderOpen
                                    className="size-3.5 text-muted-foreground"
                                    aria-hidden
                                  />
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
            </div>
          </details>
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

      <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {workflowType === "github_workflow"
            ? ready
              ? `Ready to dispatch ${workflowFile.trim()} on ${repository.trim()} at ${workflowRef.trim()}.`
              : "Complete the GitHub connection and workflow fields to continue."
            : ready
              ? runOnCreate
                ? "Ready. Derive will create this workflow and start its first run."
                : "Ready to save this workflow."
              : "Add an instruction to continue."}
        </p>
        <Button
          data-testid="automation-create"
          variant="secondary"
          size="sm"
          onClick={() => ready && save.mutate()}
          loading={save.isPending}
          disabled={save.isPending || !ready || !!mintedToken}
          className="self-end sm:self-auto"
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
