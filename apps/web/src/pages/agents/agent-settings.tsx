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
import { accountsQuery, agentConnectionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { accountLabel } from "../settings/accounts-section"
import { cronLabel, firstLine, machineOf, ownerMachineName, runnerCommand, when } from "./format"

// An agent's Settings tab (mock f9r5u1iq). Everything a coding session set when it made the
// agent is changed here; nothing is created here. A person who cannot manage the agent sees
// the same rows as plain text.

type Props = {
  agent: AgentDetail
  names: Map<string, string>
  workspaceName: string
  isWorkspaceOwner: boolean
}

export function AgentSettings({ agent, names, workspaceName, isWorkspaceOwner }: Props) {
  const edit = agent.can_manage
  const update = useApiMutation({
    mutationFn: (patch: AgentPatch) => api.updateAgent(agent.id, patch),
    invalidate: [["agents"]],
  })
  const set = (patch: AgentPatch) => update.mutate(patch)

  return (
    <div className="flex max-w-2xl flex-col gap-9">
      <div
        data-testid="agent-state"
        className="flex items-center gap-3.5 rounded-xl border border-border px-4.5 py-4 text-base"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-2 rounded-full",
            agent.paused ? "border border-muted-foreground" : "bg-success",
          )}
        />
        <span className="flex-1">{agent.paused ? "Paused" : "Active"}</span>
        {edit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="agent-pause"
            disabled={update.isPending}
            onClick={() => set({ paused: !agent.paused })}
            className="text-muted-foreground"
          >
            {agent.paused ? "Resume" : "Pause"}
          </Button>
        )}
      </div>

      <div className="flex flex-col">
        <NameFields agent={agent} edit={edit} onSave={set} saving={update.isPending} />
        <InstructionsField agent={agent} edit={edit} onSave={set} />
        <SchedulesField agent={agent} edit={edit} />
        <Field label="On">
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
                ? `${machineOf(agent, names).on ? "Checked in" : "Last seen"} ${when(agent.seen_at)}.`
                : "Its runner has never checked in."}
            </Sub>
          )}
          {agent.machine === "derive" && (
            <Sub>A Derive sandbox that keeps its files between jobs.</Sub>
          )}
        </Field>
        <AccountField agent={agent} edit={edit} onSave={set} />
        <SourcesField agent={agent} edit={edit} onSave={set} />
        <EnvironmentField agent={agent} edit={edit} onSave={set} />
        <Field label="Can write">
          <Segmented
            testId="agent-write-policy"
            value={agent.write_policy}
            disabled={!edit}
            onChange={(v) => set({ write_policy: v as AgentDetail["write_policy"] })}
            options={[
              { value: "publish", label: "Publish directly" },
              { value: "review", label: "Ask for review first" },
            ]}
          />
          <Sub>Every version is kept and undoable either way.</Sub>
        </Field>
        <Field label="Who can ask">
          <Segmented
            testId="agent-ask-policy"
            value={agent.ask_policy}
            disabled={!edit}
            onChange={(v) => set({ ask_policy: v as AgentDetail["ask_policy"] })}
            options={[
              { value: "workspace", label: `Everyone in ${workspaceName || "the workspace"}` },
              { value: "invited", label: "Only me and workspace owners" },
            ]}
          />
        </Field>
        {agent.machine === "owner" && (
          <KeyField agent={agent} canReplace={edit && isWorkspaceOwner} />
        )}
      </div>

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
    <div className="grid gap-x-3.5 gap-y-1.5 border-b border-border py-3.5 last:border-b-0 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]">
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
  children,
}: {
  testId: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-testid={testId}
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
        {agent.description && <Field label="What it does">{agent.description}</Field>}
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
        label="What it does"
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
          aria-label="What it does"
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
  return (
    <Field
      label="Instructions"
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
          className="font-mono text-foreground underline-offset-4 hover:underline"
        >
          {short}
        </Link>
      ) : (
        <span className="text-muted-foreground">No page</span>
      )}
      <Sub>
        The page it reads before every job. Edit it like any page; the next job uses the new
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
      label="Runs"
      action={
        edit &&
        !editing && (
          <Verb testId="agent-schedule-add" onClick={() => setEditing("new")}>
            Add schedule
          </Verb>
        )
      }
    >
      {schedules.length === 0 && !editing && <span>When asked</span>}
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
                {!t.enabled && <span className="ml-2 text-sm">paused</span>}
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
const DEFAULT_LABEL = "Default (creator’s account, then shared)"

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
  const usable = (accounts.data ?? []).filter((a) => a.mine || a.shared)
  const current = accounts.data?.find((a) => a.id === agent.account_id)
  const label = (a: ModelAccount) => `${accountLabel(a)}${a.hint ? ` ${a.hint}` : ""}`
  const hidden = "An account you can’t see"
  return (
    <Field label="Account">
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
          <SelectTrigger data-testid="agent-account" aria-label="Account" className="min-w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{DEFAULT_LABEL}</SelectItem>
            {agent.account_id && !current && (
              <SelectItem value={agent.account_id}>{hidden}</SelectItem>
            )}
            {usable.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {label(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span>{current ? label(current) : agent.account_id ? hidden : DEFAULT_LABEL}</span>
      )}
      {!agent.account_id && (
        <Sub>
          {agent.machine === "owner"
            ? "Its creator’s own account from Settings › Model accounts, then the workspace’s shared one, then whatever the runner’s machine is signed into."
            : "The asker’s own account, then the workspace’s shared one."}
        </Sub>
      )}
    </Field>
  )
}

const connectionName = (c: Connection) =>
  c.kind === "mcp" && c.base_url ? c.base_url.replace(/^https?:\/\//, "") : c.toolkit

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
  const addable = (conns.data ?? []).filter((c) => !attached.has(c.id) && c.status === "active")
  const set = (ids: string[]) => onSave({ connection_ids: ids })
  return (
    <Field label="Reaches">
      {conns.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t load sources."
          testId="agent-sources-retry"
          onRetry={() => void conns.refetch()}
        />
      )}
      {agent.connection_ids.length === 0 && (
        <span className="text-muted-foreground">Nothing yet</span>
      )}
      {agent.connection_ids.map((id) => {
        const c = byId.get(id)
        return (
          <div
            key={id}
            data-testid={`agent-source-${id}`}
            className="flex items-center justify-between gap-3 border-b border-border py-1 last:border-b-0"
          >
            <span className={cn("truncate", !c && "font-mono text-muted-foreground")}>
              {c ? connectionName(c) : id}
            </span>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              {c?.scope === "workspace" ? "Workspace source" : c ? "Your source" : null}
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
            <SelectValue placeholder="Add a source" />
          </SelectTrigger>
          <SelectContent>
            {addable.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {connectionName(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
    <Field label="Environment">
      {conns.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t load secrets."
          testId="agent-environment-retry"
          onRetry={() => void conns.refetch()}
        />
      )}
      {bound.length === 0 && <span className="text-muted-foreground">Nothing yet</span>}
      {bound.map(([key, id]) => {
        const c = byId.get(id)
        return (
          <div
            key={key}
            data-testid={`agent-env-${key}`}
            className="flex items-center justify-between gap-3 border-b border-border py-1 last:border-b-0"
          >
            <span className="truncate font-mono">{key}</span>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              {c ? connectionName(c) : "Secret not found"}
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
            </span>
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
            onChange={(e) => setName(e.target.value)}
          />
          <Select value={secretId} onValueChange={setSecretId}>
            <SelectTrigger data-testid="agent-env-secret" aria-label="Secret" className="w-56">
              <SelectValue placeholder="Choose a secret" />
            </SelectTrigger>
            <SelectContent>
              {addable.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {connectionName(c)}
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
          Save a secret in{" "}
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
      label="Key"
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
          title="Its new key and runner command. Shown once."
          secret={runnerCommand(agent.id, key)}
          copySuccess="Runner command copied"
          copyTestId="agent-key-copy"
          doneTestId="agent-key-done"
          secretTestId="agent-key-secret"
          onDone={() => setKey(null)}
        />
      ) : (
        <>
          <span>
            {agent.seen_at ? `Used by its runner, ${when(agent.seen_at)}` : "Not used yet"}
          </span>
          <Sub>
            {canReplace
              ? "Replacing it stops the old key at once; restart the runner with the new one."
              : "Only a workspace owner can replace it."}
          </Sub>
        </>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Replace ${agent.name}'s key?`}
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
    <div className="flex items-center gap-4 border-t border-border pt-5 text-sm text-muted-foreground">
      <Button
        type="button"
        variant="destructive-ghost"
        size="sm"
        data-testid="agent-delete"
        onClick={() => setConfirming(true)}
      >
        Delete this agent
      </Button>
      <span>Its pages and reports stay. Its key stops working.</span>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${agent.name}?`}
        description="Its open jobs are cancelled and its schedules removed. Its pages and reports stay."
        confirmLabel="Delete"
        confirmTestId="agent-delete-confirm"
        onConfirm={() => del.mutateAsync().then(() => undefined)}
      />
    </div>
  )
}
