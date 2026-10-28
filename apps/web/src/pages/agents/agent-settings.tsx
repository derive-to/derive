import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import {
  type AgentDetail,
  type AgentPatch,
  type AgentSource,
  api,
  type Connection,
  type ModelAccount,
} from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SecretReveal } from "@/components/shared/secret-reveal"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { accountsQuery, agentConnectionsQuery, artifactQuery } from "@/lib/queries"
import { dayLabel } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { accountLabel } from "../settings/accounts-section"
import { PagesField } from "./agent-artifacts"
import { sourceName, useNoAccount } from "./agent-jobs"
import { RepositoryField } from "./agent-repository"
import { RunsOnField } from "./agent-runs-on"
import { TriggersField } from "./agent-triggers"
import { machineOf, modelChoices, ownerMachineName, runnerCommand, when } from "./format"
import { Field, Group, Segmented, Sub, Verb } from "./rows"

// An agent's Settings tab. Everything a coding session set when it made the agent is changed
// here; nothing is created here. A person who cannot manage the agent sees the same rows as
// plain text. Each row is a noun and its value; the grey line under a value appears only
// where the value needs explaining.

type Props = {
  agent: AgentDetail
  names: Map<string, string>
  workspaceName: string
  isWorkspaceOwner: boolean
}

export function AgentSettings({ agent, names, isWorkspaceOwner }: Props) {
  const edit = agent.can_manage
  const { me } = useAuth()
  const noAccount = useNoAccount(agent, me?.id ?? "")
  const update = useApiMutation({
    mutationFn: (patch: AgentPatch) => api.updateAgent(agent.id, patch),
    invalidate: [["agents"]],
  })
  const set = (patch: AgentPatch) => update.mutate(patch)

  return (
    <div className="flex max-w-2xl flex-col gap-10">
      <Group testId="agent-general">
        <Field
          label="Status"
          action={
            edit && (
              <Verb
                testId="agent-pause"
                disabled={update.isPending}
                onClick={() => set({ paused: !agent.paused })}
              >
                {agent.paused ? "Resume" : "Pause"}
              </Verb>
            )
          }
        >
          <span data-testid="agent-state" className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                agent.paused ? "border border-muted-foreground" : "bg-success",
              )}
            />
            {agent.paused ? "Paused" : "Active"}
          </span>
        </Field>
        <NameFields agent={agent} edit={edit} onSave={set} saving={update.isPending} />
        <InstructionsField agent={agent} edit={edit} onSave={set} />
        <PagesField agent={agent} />
      </Group>

      <Group label="Running" testId="agent-running">
        <TriggersField agent={agent} edit={edit} />
        <Field label="Machine">
          <Segmented
            testId="agent-machine"
            value={agent.machine}
            disabled={!edit}
            // Derive machines are on per workspace and nothing tells the web which; a
            // workspace without them gets the API's refusal as the error toast.
            onChange={(v) => set({ machine: v as AgentDetail["machine"] })}
            options={[
              { value: "owner", label: ownerMachineName(agent.created_by, names) },
              { value: "derive", label: "Derive" },
            ]}
          />
          {agent.machine === "owner" && (
            <Sub>
              {agent.seen_at
                ? `${machineOf(agent, names).on ? "Connected" : "Last seen"} ${when(agent.seen_at)}`
                : "Not connected yet"}
            </Sub>
          )}
          {agent.machine === "derive" && (
            <Sub>
              {agent.sandbox.fresh
                ? "A Derive sandbox, new for each task."
                : "A Derive sandbox that keeps its files between tasks."}
            </Sub>
          )}
          {agent.machine === "derive" && noAccount && (
            <p data-testid="agent-machine-needs-account" className="text-sm text-warning">
              Needs a model account below. A Derive machine has no login to borrow.
            </p>
          )}
          {agent.machine === "derive" && agent.sources.length === 0 && !agent.repository && (
            <Sub>
              <span data-testid="agent-machine-no-sources">
                Nothing on anyone’s computer reaches it. What the skill needs goes under Sources.
              </span>
            </Sub>
          )}
        </Field>
        <AccountField agent={agent} edit={edit} onSave={set} />
        <ModelField agent={agent} edit={edit} onSave={set} />
        <RunBudgetField agent={agent} edit={edit} onSave={set} />
        {agent.provider === "codex" && (
          <Field label="Effort">
            <Segmented
              testId="agent-effort"
              value={agent.effort ?? DEFAULT}
              disabled={!edit}
              onChange={(v) => set({ effort: v === DEFAULT ? null : (v as AgentPatch["effort"]) })}
              options={[
                { value: DEFAULT, label: "Default" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
          </Field>
        )}
        {agent.machine === "derive" && (
          <SandboxFields
            agent={agent}
            edit={edit}
            isWorkspaceOwner={isWorkspaceOwner}
            onSave={set}
            saving={update.isPending}
          />
        )}
      </Group>

      <Group label="Sources" testId="agent-sources">
        <SourcesField agent={agent} edit={edit} onSave={set} />
        <RepositoryField agent={agent} edit={edit} onSave={set} />
        <EnvironmentField agent={agent} edit={edit} onSave={set} />
      </Group>

      <Group label="Permissions" testId="agent-permissions">
        <Field label="Publishing">
          <Segmented
            testId="agent-write-policy"
            value={agent.write_policy}
            disabled={!edit}
            onChange={(v) => set({ write_policy: v as AgentDetail["write_policy"] })}
            options={[
              { value: "publish", label: "Direct" },
              { value: "review", label: "Review first" },
            ]}
          />
        </Field>
        <RunsOnField agent={agent} edit={edit} meId={me?.id ?? ""} names={names} onSave={set} />
        {agent.machine === "owner" && (
          <KeyField agent={agent} canReplace={edit && isWorkspaceOwner} />
        )}
      </Group>

      {edit && <DeleteAgent agent={agent} />}
    </div>
  )
}

/** One settings line: a grey label, the value, and an optional verb at the right. */
function NameFields({
  agent,
  edit,
  onSave,
  saving,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (p: AgentPatch) => void
  saving: boolean
}) {
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description ?? "")
  const dirty = name.trim() !== agent.name || description.trim() !== (agent.description ?? "")
  if (!edit)
    return (
      <>
        <Field label="Name">{agent.name}</Field>
        {agent.description && <Field label="Description">{agent.description}</Field>}
      </>
    )
  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    onSave({ name: name.trim(), description: description.trim() || null })
  }
  return (
    <form onSubmit={save} className="contents">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Name"
          data-testid="agent-name"
          maxLength={80}
        />
      </Field>
      <Field
        label="Description"
        action={
          dirty && (
            <Button
              type="submit"
              size="xs"
              data-testid="agent-name-save"
              loading={saving}
              disabled={!name.trim()}
            >
              Save
            </Button>
          )
        }
      >
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Description"
          data-testid="agent-description"
          maxLength={280}
        />
        {/* @Derive in Slack picks an agent by this text alone (docs/agent-dispatch.md §5.2),
            so it teaches the shape a router can choose by. */}
        <Sub>
          @Derive in Slack picks an agent by this line. Say what it does, what it returns, and the
          input it needs, like a PR link.
        </Sub>
      </Field>
    </form>
  )
}

function InstructionsField({
  agent,
  edit,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (p: AgentPatch) => void
}) {
  const [editing, setEditing] = useState(false)
  const [ref, setRef] = useState(agent.instructions_short_id ?? "")
  const short = agent.instructions_short_id
  // The page's title is what a person recognises; its short id is only a fallback.
  const page = useQuery({ ...artifactQuery(short ?? ""), enabled: !!short })
  return (
    <Field
      label="Skill"
      action={
        edit &&
        !editing && (
          <Verb testId="agent-instructions-change" onClick={() => setEditing(true)}>
            Change
          </Verb>
        )
      }
    >
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onSave({ instructions_short_id: ref.trim() || null })
            setEditing(false)
          }}
        >
          <Input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="Page short id"
            aria-label="Instructions page short id"
            data-testid="agent-instructions-input"
            className="max-w-48 font-mono"
          />
          <Button type="submit" size="xs" data-testid="agent-instructions-save">
            Save
          </Button>
          <Verb testId="agent-instructions-cancel" onClick={() => setEditing(false)}>
            Cancel
          </Verb>
        </form>
      ) : short ? (
        <Link
          to="/artifacts/$ref"
          params={{ ref: short }}
          data-testid="agent-instructions-link"
          className={cn(
            "text-foreground underline-offset-4 hover:underline",
            !page.data?.title && "font-mono",
          )}
        >
          {page.data?.title ?? short}
        </Link>
      ) : (
        <span className="text-muted-foreground">None</span>
      )}
      <Sub>
        The page it reads before every task. Edit it like any page; the next task uses the new
        version.
      </Sub>
    </Field>
  )
}

const DEFAULT = "default"

// The run budget (`max_run_ms`). A Derive machine stops a task at this deadline, so a skill
// that installs tools or runs a long suite needs more than the 15-minute default; an owner
// machine's claim lapses after it. Milliseconds on the wire, minutes and hours to a person.
const RUN_BUDGETS = [
  { value: DEFAULT, label: "Default" },
  { value: "900000", label: "15 min" },
  { value: "1800000", label: "30 min" },
  { value: "3600000", label: "1 hour" },
  { value: "7200000", label: "2 hours" },
  { value: "21600000", label: "6 hours" },
]

function RunBudgetField({
  agent,
  edit,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (p: AgentPatch) => void
}) {
  const current = agent.max_run_ms === null ? DEFAULT : String(agent.max_run_ms)
  // A budget set over the API to a value the picker doesn't list still shows as itself.
  const options = RUN_BUDGETS.some((o) => o.value === current)
    ? RUN_BUDGETS
    : [
        ...RUN_BUDGETS,
        { value: current, label: `${Math.round((agent.max_run_ms ?? 0) / 60_000)} min` },
      ]
  return (
    <Field label="Run time">
      <Segmented
        testId="agent-max-run"
        value={current}
        disabled={!edit}
        onChange={(v) => onSave({ max_run_ms: v === DEFAULT ? null : Number(v) })}
        options={options}
      />
      <Sub>
        {agent.machine === "derive"
          ? "The most one task may run. Default is 15 minutes; a task still going at its deadline is stopped without a report."
          : "The most one task may run before its claim lapses and it is handed out again. Default is 10 minutes."}
      </Sub>
    </Field>
  )
}

// The server picks the account a job runs on: the one assigned here; else, on an owner
// machine, the agent creator's own account (on a Derive machine, the asker's); then the
// workspace's shared account; then older stored plans. With none of those the job fails.
function AccountField({
  agent,
  edit,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (p: AgentPatch) => void
}) {
  const accounts = useQuery({ ...accountsQuery(), enabled: edit || !!agent.account_id })
  // An agent may run on its manager's own account or a shared one, never a teammate's.
  const usable = (accounts.data ?? []).filter(
    (a) => (a.mine || a.shared) && a.status !== "connecting" && a.status !== "needs_attention",
  )
  const current = accounts.data?.find((a) => a.id === agent.account_id)
  const label = (a: ModelAccount) => `${accountLabel(a)}${a.hint ? ` ${a.hint}` : ""}`
  const hidden = "An account you can’t see"
  return (
    <Field label="Model account">
      {accounts.isError ? (
        <LoadError
          layout="inline"
          title="Couldn’t load accounts."
          testId="agent-account-retry"
          onRetry={() => void accounts.refetch()}
        />
      ) : edit ? (
        <Select
          value={agent.account_id ?? DEFAULT}
          onValueChange={(v) => onSave({ account_id: v === DEFAULT ? null : v })}
        >
          <SelectTrigger
            data-testid="agent-account"
            aria-label="Model account"
            className="min-w-56"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>Default</SelectItem>
            {agent.account_id && !current && (
              <SelectItem value={agent.account_id}>{hidden}</SelectItem>
            )}
            {current && !usable.some((a) => a.id === current.id) && (
              <SelectItem value={current.id} disabled>
                {accountLabel(current)} · Finish connecting
              </SelectItem>
            )}
            {usable.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {label(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span>{current ? label(current) : agent.account_id ? hidden : "Default"}</span>
      )}
      {!agent.account_id && (
        <Sub>
          {agent.machine === "owner"
            ? "Default: the creator’s account, then the workspace’s shared account, then the login on the machine."
            : "Default: the asker’s account, then the workspace’s shared account."}
        </Sub>
      )}
    </Field>
  )
}

const CUSTOM = "custom"

function ModelField({
  agent,
  edit,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (p: AgentPatch) => void
}) {
  const choices = modelChoices(agent.provider)
  const known = choices.find((m) => m.id === agent.model)
  const [custom, setCustom] = useState<string | null>(null)
  const selected = custom !== null ? CUSTOM : !agent.model ? DEFAULT : known ? known.id : CUSTOM
  const shown = !agent.model ? "Default" : (known?.label ?? agent.model)
  const saveCustom = (e: FormEvent) => {
    e.preventDefault()
    const id = custom?.trim()
    if (!id) return
    onSave({ model: id })
    setCustom(null)
  }
  return (
    <Field label="Model">
      {edit ? (
        <>
          <Select
            value={selected}
            onValueChange={(v) => {
              if (v === CUSTOM) return setCustom(known || !agent.model ? "" : agent.model)
              setCustom(null)
              onSave({ model: v === DEFAULT ? null : v })
            }}
          >
            <SelectTrigger data-testid="agent-model" aria-label="Model" className="min-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>Default</SelectItem>
              {choices.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>
                {selected === CUSTOM && custom === null ? `Custom: ${agent.model}` : "Custom…"}
              </SelectItem>
            </SelectContent>
          </Select>
          {custom !== null && (
            <form onSubmit={saveCustom} className="mt-1 flex items-center gap-2">
              <Input
                autoFocus
                aria-label="Model id"
                data-testid="agent-model-custom"
                placeholder="Exact model id"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="w-64 font-mono"
              />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                data-testid="agent-model-custom-save"
                disabled={!custom.trim()}
              >
                Save
              </Button>
            </form>
          )}
        </>
      ) : (
        <span>{shown}</span>
      )}
    </Field>
  )
}

/** The machine a Derive agent runs on: its prepared image, size, whether each task gets a new
 *  one, and the check that must pass before the model starts. */
function SandboxFields({
  agent,
  edit,
  isWorkspaceOwner,
  onSave,
  saving,
}: {
  agent: AgentDetail
  edit: boolean
  isWorkspaceOwner: boolean
  onSave: (p: AgentPatch) => void
  saving: boolean
}) {
  const spec = agent.sandbox
  const [snapshot, setSnapshot] = useState(spec.snapshot ?? "")
  const [environment, setEnvironment] = useState(spec.environment ?? "")
  const [check, setCheck] = useState(spec.check ?? "")
  const dirty =
    snapshot.trim() !== (spec.snapshot ?? "") ||
    environment.trim() !== (spec.environment ?? "") ||
    check !== (spec.check ?? "")
  const save = (patch: Partial<AgentDetail["sandbox"]>) => {
    const next = { ...spec, ...patch }
    onSave({
      sandbox: Object.fromEntries(
        Object.entries(next).filter(([, v]) => v !== undefined && v !== "" && v !== false),
      ),
    })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save({
      snapshot: snapshot.trim() || undefined,
      environment: environment.trim() || undefined,
      check: check.trim() ? check : undefined,
    })
  }
  return (
    <>
      <Field label="Size">
        <Segmented
          testId="agent-sandbox-size"
          value={spec.size ?? "small"}
          disabled={!edit}
          onChange={(v) => save({ size: v as NonNullable<AgentDetail["sandbox"]["size"]> })}
          options={[
            { value: "small", label: "Small" },
            { value: "default", label: "Standard" },
            { value: "large", label: "Large" },
          ]}
        />
      </Field>
      <Field label="Each task">
        <Segmented
          testId="agent-sandbox-fresh"
          value={spec.fresh ? "fresh" : "resume"}
          disabled={!edit}
          onChange={(v) => save({ fresh: v === "fresh" })}
          options={[
            { value: "resume", label: "Keeps files" },
            { value: "fresh", label: "Starts fresh" },
          ]}
        />
        <Sub>
          {spec.fresh
            ? "Every task gets a new machine built from the snapshot."
            : "Tasks reuse one machine and its files."}
        </Sub>
      </Field>
      {edit ? (
        <form onSubmit={submit} data-testid="agent-sandbox">
          <Field label="Snapshot">
            <Input
              aria-label="Snapshot"
              data-testid="agent-sandbox-snapshot"
              placeholder="Workspace default"
              value={snapshot}
              disabled={!isWorkspaceOwner}
              onChange={(e) => setSnapshot(e.target.value)}
              className="w-64 font-mono"
            />
            {!isWorkspaceOwner && <Sub>A workspace owner chooses the snapshot.</Sub>}
          </Field>
          <Field label="Environment">
            <Input
              aria-label="Environment"
              data-testid="agent-sandbox-environment"
              placeholder="None"
              value={environment}
              disabled={!isWorkspaceOwner}
              onChange={(e) => setEnvironment(e.target.value)}
              className="w-64 font-mono"
            />
            <Sub>
              The provider environment, with its repositories and secrets. Empty gives the machine
              none of the account's secrets.
            </Sub>
          </Field>
          <Field
            label="Ready check"
            action={
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                data-testid="agent-sandbox-save"
                disabled={!dirty || saving}
              >
                Save
              </Button>
            }
          >
            <Textarea
              aria-label="Ready check"
              data-testid="agent-sandbox-check"
              placeholder="test -d ~/app"
              value={check}
              onChange={(e) => setCheck(e.target.value)}
              className="min-h-16 font-mono text-sm"
            />
            <Sub>Runs before the model. If it fails, the task stops and no tokens are spent.</Sub>
          </Field>
        </form>
      ) : (
        <>
          <Field label="Snapshot">{spec.snapshot ?? "Workspace default"}</Field>
          <Field label="Environment">{spec.environment ?? "None"}</Field>
          {spec.check && (
            <Field label="Ready check">
              <code className="font-mono text-sm">{spec.check}</code>
            </Field>
          )}
        </>
      )}
    </>
  )
}

const KIND_WORD: Record<AgentSource["kind"], string> = {
  github_app: "GitHub",
  slack: "Slack",
  mcp: "MCP server",
  oauth: "Account",
  secret: "Secret",
  runtime: "Sandbox",
}

/** One bound row: a name, what it is, whose it is, and Remove while editing. */
function BoundRow({
  testId,
  title,
  mono,
  detail,
  right,
  onRemove,
  removeTestId,
}: {
  testId: string
  title: string
  mono?: boolean
  detail?: string | null
  right?: string | null
  onRemove?: () => void
  removeTestId: string
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-3 border-b border-border py-1 last:border-b-0"
    >
      <span className="flex min-w-0 items-baseline gap-2.5">
        <span className={cn("truncate", mono && "font-mono")}>{title}</span>
        {detail && <span className="truncate text-sm text-muted-foreground">{detail}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
        {right}
        {onRemove && (
          <Verb testId={removeTestId} onClick={onRemove}>
            Remove
          </Verb>
        )}
      </span>
    </div>
  )
}

/** The agent's sources, named by the server for whoever can see the agent (the workspace's
 *  connections list hides a teammate's personal rows, so it is read only to offer more). */
function SourcesField({
  agent,
  edit,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (p: AgentPatch) => void
}) {
  const conns = useQuery({ ...agentConnectionsQuery(), enabled: edit })
  const known = new Map(agent.sources.map((s) => [s.id, s]))
  const attached = new Set(agent.connection_ids)
  const addable = (conns.data ?? []).filter(
    (c) => !attached.has(c.id) && c.status === "active" && c.kind !== "secret",
  )
  const set = (ids: string[]) => onSave({ connection_ids: ids })
  return (
    <Field label="Sources">
      {conns.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t load sources."
          testId="agent-sources-retry"
          onRetry={() => void conns.refetch()}
        />
      )}
      {agent.connection_ids.length === 0 && <span className="text-muted-foreground">None</span>}
      {agent.connection_ids.map((id) => {
        const s = known.get(id)
        return (
          <BoundRow
            key={id}
            testId={`agent-source-${id}`}
            title={s ? s.name : "Removed"}
            detail={
              s
                ? `${KIND_WORD[s.kind]}${s.status !== "active" ? " · Disconnected" : ""}`
                : "This source no longer exists."
            }
            right={s ? (s.scope === "workspace" ? "Workspace" : "Personal") : null}
            removeTestId={`agent-source-remove-${id}`}
            onRemove={edit ? () => set(agent.connection_ids.filter((x) => x !== id)) : undefined}
          />
        )
      })}
      {edit && addable.length > 0 && (
        <Select value="" onValueChange={(v) => set([...agent.connection_ids, v])}>
          <SelectTrigger data-testid="agent-source-add" aria-label="Add a source" className="mt-1">
            <SelectValue placeholder="Add" />
          </SelectTrigger>
          <SelectContent>
            {addable.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {sourceName(c)}
                {c.kind ? ` · ${KIND_WORD[c.kind]}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {edit && conns.data && addable.length === 0 && agent.connection_ids.length === 0 && (
        <Sub>
          Connect one under{" "}
          <Link
            to="/settings/$section"
            params={{ section: "sources" }}
            data-testid="agent-sources-settings-link"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Settings › Sources
          </Link>
          .
        </Sub>
      )}
    </Field>
  )
}

const NEW_SECRET = "__new__"

/** Variable name → a secret. Pick one already saved, or paste a value here: it is stored as a
 *  personal secret named after the variable (Settings › Sources › Secrets) and bound at once.
 *  Values are never sent back to the client. */
function EnvironmentField({
  agent,
  edit,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (p: AgentPatch) => void
}) {
  const bound = Object.entries(agent.environment)
  const known = new Map(agent.sources.map((s) => [s.id, s]))
  const conns = useQuery({ ...agentConnectionsQuery(), enabled: edit })
  const saved = (conns.data ?? []).filter((c) => c.kind === "secret" && c.status === "active")
  const [name, setName] = useState("")
  const [choice, setChoice] = useState("")
  const [value, setValue] = useState("")
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const key = name.trim()
  // With nothing saved yet there is nothing to pick from, so the form is the value line.
  const pasting = saved.length === 0 || choice === NEW_SECRET
  const set = (env: Record<string, string>) => onSave({ environment: env })
  const reset = () => {
    setName("")
    setChoice("")
    setValue("")
    setRequestId(crypto.randomUUID())
  }
  const create = useApiMutation<Connection>({
    mutationFn: () =>
      api.createCredential({ name: key, secret: value, scope: "personal", request_id: requestId }),
    invalidate: [["credentials"], ["connections"]],
    onSuccess: (c) => {
      set({ ...agent.environment, [key]: c.id })
      reset()
    },
  })
  const ready = !!key && (pasting ? !!value && !value.includes("\0") : !!choice)
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    if (pasting) create.mutate()
    else {
      set({ ...agent.environment, [key]: choice })
      reset()
    }
  }
  return (
    <Field label="Environment variables">
      {conns.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t load secrets."
          testId="agent-environment-retry"
          onRetry={() => void conns.refetch()}
        />
      )}
      {bound.length === 0 && <span className="text-muted-foreground">None</span>}
      {bound.map(([variable, id]) => {
        const s = known.get(id)
        return (
          <BoundRow
            key={variable}
            testId={`agent-env-${variable}`}
            title={variable}
            mono
            // A secret named after its variable (the pasted-here default) says nothing twice.
            detail={
              s
                ? [s.name === variable ? null : s.name, s.status !== "active" ? "Revoked" : null]
                    .filter(Boolean)
                    .join(" · ") || null
                : "Secret removed"
            }
            right={s ? (s.scope === "workspace" ? "Workspace" : "Personal") : null}
            removeTestId={`agent-env-remove-${variable}`}
            onRemove={
              edit
                ? () => {
                    const { [variable]: _gone, ...rest } = agent.environment
                    set(rest)
                  }
                : undefined
            }
          />
        )
      })}
      {edit && conns.data && (
        <form onSubmit={add} className="mt-1 flex flex-wrap items-center gap-2">
          <Input
            data-testid="agent-env-name"
            aria-label="Variable name"
            placeholder="DATABASE_URL"
            className="w-48 font-mono"
            value={name}
            // the server only accepts uppercase names, so typing `db_url` should just work
            onChange={(e) => setName(e.target.value.toUpperCase())}
          />
          {saved.length > 0 && (
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger
                data-testid="agent-env-secret"
                aria-label="Saved secret"
                className="w-56"
              >
                <SelectValue placeholder="Saved secret" />
              </SelectTrigger>
              <SelectContent>
                {saved.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {sourceName(c)}
                    {/* Two secrets saved under one name are the same word twice without this. */}
                    <span className="ml-2 text-muted-foreground">
                      {c.scope === "workspace" ? "Workspace" : "Personal"} · added{" "}
                      {dayLabel(c.created_at)}
                    </span>
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value={NEW_SECRET} data-testid="agent-env-secret-new">
                  Paste a value…
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          {pasting && (
            <Input
              data-testid="agent-env-value"
              aria-label="Value"
              type="password"
              placeholder="Value"
              className="w-64 font-mono"
              autoComplete="new-password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setRequestId(crypto.randomUUID())
              }}
            />
          )}
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            data-testid="agent-env-add"
            disabled={!ready}
            loading={create.isPending}
          >
            Add
          </Button>
        </form>
      )}
      {edit && pasting && (
        <Sub>Saved as a personal secret under Settings › Sources. Never shown again.</Sub>
      )}
    </Field>
  )
}

function KeyField({ agent, canReplace }: { agent: AgentDetail; canReplace: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const [key, setKey] = useState<string | null>(null)
  const rotate = useApiMutation({
    mutationFn: () => api.rotateAgent(agent.id),
    invalidate: [["agents"]],
    onSuccess: (r) => setKey(r.token),
  })
  return (
    <Field
      label="Runner key"
      action={
        canReplace &&
        !key && (
          <Verb testId="agent-key-replace" onClick={() => setConfirming(true)}>
            Replace
          </Verb>
        )
      }
    >
      {key ? (
        <SecretReveal
          title="The new key, in its runner command. Shown once."
          secret={runnerCommand(agent.id, key)}
          copySuccess="Runner command copied"
          copyTestId="agent-key-copy"
          doneTestId="agent-key-done"
          secretTestId="agent-key-secret"
          onDone={() => setKey(null)}
        />
      ) : (
        <>
          <span>{agent.seen_at ? `Last used ${when(agent.seen_at)}` : "Not used yet"}</span>
          {!canReplace && <Sub>Only a workspace owner can replace it.</Sub>}
        </>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Replace ${agent.name}'s runner key?`}
        description="The old key stops working immediately, so its runner stops too. You get a new runner command to start it again."
        confirmLabel="Replace"
        confirmTestId="agent-key-confirm"
        onConfirm={() => rotate.mutateAsync().then(() => undefined)}
      />
    </Field>
  )
}

function DeleteAgent({ agent }: { agent: AgentDetail }) {
  const [confirming, setConfirming] = useState(false)
  const navigate = useNavigate()
  const del = useApiMutation({
    mutationFn: () => api.deleteAgent(agent.id),
    invalidate: [["agents"], ["jobs"]],
    onSuccess: () => void navigate({ to: "/agents" }),
  })
  return (
    <div className="border-t border-border pt-5">
      <Button
        type="button"
        variant="destructive-ghost"
        size="sm"
        data-testid="agent-delete"
        onClick={() => setConfirming(true)}
      >
        Delete agent
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${agent.name}?`}
        description="Open jobs are cancelled and its schedules removed. Its pages and reports stay."
        confirmLabel="Delete"
        confirmTestId="agent-delete-confirm"
        onConfirm={() => del.mutateAsync().then(() => undefined)}
      />
    </div>
  )
}
