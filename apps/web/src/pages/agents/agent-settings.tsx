import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, type ReactNode, useState } from "react"
import {
  type AgentDetail,
  type AgentPatch,
  type AgentTrigger,
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
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { accountsQuery, agentConnectionsQuery, artifactQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { accountLabel } from "../settings/accounts-section"
import { sourceName } from "./agent-jobs"
import {
  cronLabel,
  firstLine,
  machineOf,
  modelChoices,
  ownerMachineName,
  runnerCommand,
  when,
} from "./format"
import { Group } from "./rows"

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
      </Group>

      <Group label="Running" testId="agent-running">
        <SchedulesField agent={agent} edit={edit} />
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
            <Sub>A Derive sandbox that keeps its files between tasks.</Sub>
          )}
        </Field>
        <AccountField agent={agent} edit={edit} onSave={set} />
        <ModelField agent={agent} edit={edit} onSave={set} />
      </Group>

      <Group label="Sources" testId="agent-sources">
        <SourcesField agent={agent} edit={edit} onSave={set} />
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
        <Field label="Access">
          <Segmented
            testId="agent-ask-policy"
            value={agent.ask_policy}
            disabled={!edit}
            onChange={(v) => set({ ask_policy: v as AgentDetail["ask_policy"] })}
            options={[
              { value: "workspace", label: "Workspace" },
              { value: "invited", label: "Creator and owners" },
            ]}
          />
          <Sub>Who can ask it for work.</Sub>
        </Field>
        {agent.machine === "owner" && (
          <KeyField agent={agent} canReplace={edit && isWorkspaceOwner} />
        )}
      </Group>

      {edit && <DeleteAgent agent={agent} />}
    </div>
  )
}

/** One settings line: a grey label, the value, and an optional verb at the right. */
function Field({
  label,
  action,
  children,
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid gap-x-3.5 gap-y-1.5 border-b border-border py-3.5 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
      <span className="pt-0.5 text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-col gap-1 text-base">{children}</div>
      <div className="flex items-start">{action}</div>
    </div>
  )
}

const Sub = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
)

function Verb({
  testId,
  onClick,
  disabled,
  children,
}: {
  testId: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground"
    >
      {children}
    </Button>
  )
}

function Segmented({
  testId,
  value,
  options,
  onChange,
  disabled,
}: {
  testId: string
  value: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && v !== value && onChange(v)}
      data-testid={testId}
      className="w-fit gap-0.5 rounded-lg bg-secondary p-0.5"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          disabled={disabled || o.disabled}
          data-testid={`${testId}-${o.value}`}
          className="h-7 rounded-md px-3 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

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

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

function SchedulesField({ agent, edit }: { agent: AgentDetail; edit: boolean }) {
  const [editing, setEditing] = useState<AgentTrigger | "new" | null>(null)
  const invalidate = [["agents"]]
  const toggle = useApiMutation({
    mutationFn: (t: AgentTrigger) => api.updateTrigger(t.id, { enabled: !t.enabled }),
    invalidate,
  })
  const remove = useApiMutation({
    mutationFn: (t: AgentTrigger) => api.deleteTrigger(t.id),
    invalidate,
  })
  const schedules = agent.triggers.filter((t) => t.kind === "schedule")
  return (
    <Field
      label="Schedule"
      action={
        edit &&
        !editing && (
          <Verb testId="agent-schedule-add" onClick={() => setEditing("new")}>
            Add
          </Verb>
        )
      }
    >
      {schedules.length === 0 && !editing && <span className="text-muted-foreground">None</span>}
      {schedules.map((t) =>
        editing !== "new" && editing?.id === t.id ? (
          <ScheduleForm key={t.id} agentId={agent.id} trigger={t} onDone={() => setEditing(null)} />
        ) : (
          <div
            key={t.id}
            data-testid={`agent-schedule-${t.id}`}
            className="flex items-start justify-between gap-3 border-b border-border py-1.5 last:border-b-0"
          >
            <div className="flex min-w-0 flex-col">
              <span className={cn(!t.enabled && "text-muted-foreground")}>
                {t.cron ? cronLabel(t.cron) : "Schedule"}
                {t.tz && <span className="ml-2 text-sm text-muted-foreground">{t.tz}</span>}
                {!t.enabled && <span className="ml-2 text-sm">Paused</span>}
              </span>
              <span className="truncate text-sm text-muted-foreground">
                {firstLine(t.instruction)}
              </span>
            </div>
            {edit && (
              <span className="flex shrink-0 items-center">
                <Verb testId={`agent-schedule-toggle-${t.id}`} onClick={() => toggle.mutate(t)}>
                  {t.enabled ? "Pause" : "Resume"}
                </Verb>
                <Verb testId={`agent-schedule-edit-${t.id}`} onClick={() => setEditing(t)}>
                  Edit
                </Verb>
                <Button
                  type="button"
                  variant="destructive-ghost"
                  size="xs"
                  data-testid={`agent-schedule-remove-${t.id}`}
                  onClick={() => remove.mutate(t)}
                >
                  Remove
                </Button>
              </span>
            )}
          </div>
        ),
      )}
      {editing === "new" && <ScheduleForm agentId={agent.id} onDone={() => setEditing(null)} />}
    </Field>
  )
}

function ScheduleForm({
  agentId,
  trigger,
  onDone,
}: {
  agentId: string
  trigger?: AgentTrigger
  onDone: () => void
}) {
  const [cron, setCron] = useState(trigger?.cron ?? "0 9 * * 1-5")
  const [tz, setTz] = useState(trigger?.tz ?? BROWSER_TZ)
  const [instruction, setInstruction] = useState(trigger?.instruction ?? "")
  const save = useApiMutation({
    mutationFn: () => {
      const body = { cron: cron.trim(), tz: tz.trim(), instruction: instruction.trim() }
      return trigger ? api.updateTrigger(trigger.id, body) : api.addTrigger(agentId, body)
    },
    invalidate: [["agents"]],
    onSuccess: onDone,
  })
  const ready = cron.trim() && tz.trim() && instruction.trim()
  return (
    <form
      data-testid="agent-schedule-form"
      className="flex flex-col gap-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) save.mutate()
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Input
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          aria-label="Cron"
          data-testid="agent-schedule-cron"
          className="w-40 font-mono"
        />
        <Input
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          aria-label="Time zone"
          data-testid="agent-schedule-tz"
          className="w-48"
        />
        {cron.trim() && cronLabel(cron) !== cron.trim() && (
          <span className="self-center text-sm text-muted-foreground">{cronLabel(cron)}</span>
        )}
      </div>
      <Textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="What it does each time"
        aria-label="Instruction"
        data-testid="agent-schedule-instruction"
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="xs"
          data-testid="agent-schedule-save"
          disabled={!ready}
          loading={save.isPending}
        >
          Save
        </Button>
        <Verb testId="agent-schedule-cancel" onClick={onDone}>
          Cancel
        </Verb>
      </div>
    </form>
  )
}

const DEFAULT = "default"

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

const KIND_WORD: Record<NonNullable<Connection["kind"]>, string> = {
  github_app: "GitHub",
  slack: "Slack",
  mcp: "MCP server",
  oauth: "Account",
  secret: "Secret",
  runtime: "Sandbox",
}

function SourcesField({
  agent,
  edit,
  onSave,
}: {
  agent: AgentDetail
  edit: boolean
  onSave: (p: AgentPatch) => void
}) {
  const conns = useQuery({
    ...agentConnectionsQuery(),
    enabled: agent.connection_ids.length > 0 || edit,
  })
  const byId = new Map((conns.data ?? []).map((c) => [c.id, c]))
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
        const c = byId.get(id)
        return (
          <div
            key={id}
            data-testid={`agent-source-${id}`}
            className="flex items-center justify-between gap-3 border-b border-border py-1 last:border-b-0"
          >
            <span className="flex min-w-0 items-baseline gap-2.5">
              <span className={cn("truncate", !c && "font-mono text-muted-foreground")}>
                {c ? sourceName(c) : id}
              </span>
              {c && (
                <span className="text-sm text-muted-foreground">
                  {c.kind ? KIND_WORD[c.kind] : null}
                  {c.status !== "active" && " · Disconnected"}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
              {c?.scope === "workspace" ? "Workspace" : c ? "Personal" : null}
              {edit && (
                <Verb
                  testId={`agent-source-remove-${id}`}
                  onClick={() => set(agent.connection_ids.filter((x) => x !== id))}
                >
                  Remove
                </Verb>
              )}
            </span>
          </div>
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

/** Variable name → saved secret. Values live in Settings › Sources › Secrets and are never
 *  sent back to the client. */
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
  const conns = useQuery({ ...agentConnectionsQuery(), enabled: bound.length > 0 || edit })
  const secrets = (conns.data ?? []).filter((c) => c.kind === "secret")
  const byId = new Map(secrets.map((c) => [c.id, c]))
  const addable = secrets.filter((c) => c.status === "active")
  const [name, setName] = useState("")
  const [secretId, setSecretId] = useState("")
  const set = (env: Record<string, string>) => onSave({ environment: env })
  const add = (e: FormEvent) => {
    e.preventDefault()
    const key = name.trim()
    if (!key || !secretId) return
    set({ ...agent.environment, [key]: secretId })
    setName("")
    setSecretId("")
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
      {bound.map(([key, id]) => {
        const c = byId.get(id)
        return (
          <div
            key={key}
            data-testid={`agent-env-${key}`}
            className="flex items-center justify-between gap-3 border-b border-border py-1 last:border-b-0"
          >
            <span className="flex min-w-0 items-baseline gap-2.5">
              <span className="truncate font-mono">{key}</span>
              <span className="truncate text-sm text-muted-foreground">
                {c ? sourceName(c) : "Secret removed"}
              </span>
            </span>
            {edit && (
              <Verb
                testId={`agent-env-remove-${key}`}
                onClick={() => {
                  const { [key]: _gone, ...rest } = agent.environment
                  set(rest)
                }}
              >
                Remove
              </Verb>
            )}
          </div>
        )
      })}
      {edit && addable.length > 0 && (
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
          <Select value={secretId} onValueChange={setSecretId}>
            <SelectTrigger data-testid="agent-env-secret" aria-label="Secret" className="w-56">
              <SelectValue placeholder="Secret" />
            </SelectTrigger>
            <SelectContent>
              {addable.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {sourceName(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            data-testid="agent-env-add"
            disabled={!name.trim() || !secretId}
          >
            Add
          </Button>
        </form>
      )}
      {edit && conns.data && addable.length === 0 && (
        <Sub>
          Save a secret under{" "}
          <Link
            to="/settings/$section"
            params={{ section: "sources" }}
            hash="secrets"
            data-testid="agent-env-secrets-link"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Settings › Sources
          </Link>{" "}
          first.
        </Sub>
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
