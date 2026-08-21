import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bot } from "lucide-react"
import { useState } from "react"
import { type Agent, api, type OrgSettings, type Role } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SecretReveal } from "@/components/shared/secret-reveal"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  agentsQuery,
  modelCredentialsQuery,
  workspaceQuery,
  workspaceSettingsQuery,
} from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { AddForm } from "./add-form"
import { ModelPlanManager } from "./model-plan-manager"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

export function AgentsSection({ meId }: { meId: string }) {
  const qc = useQueryClient()
  const { data: agents, isPending, isError, refetch } = useQuery(agentsQuery())
  const reload = () => qc.invalidateQueries({ queryKey: agentsQuery().queryKey })
  // The per-agent lend toggle is inert until YOU have a plan connected, so gate it on that.
  const { data: myPlans } = useQuery(modelCredentialsQuery())
  const hasPersonalPlan = (myPlans?.length ?? 0) > 0

  return (
    <SettingsSection
      title="Workspace agents"
      description="Register an agent so teammates can @mention it and send it work. Choose what it can do."
    >
      <AgentWritesRow />

      <NewAgent onCreated={reload} />

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <LoadError title="Couldn’t load agents" testId="agents-retry" onRetry={() => refetch()} />
      ) : !agents || agents.filter((a) => !a.managed).length === 0 ? (
        <SettingsEmpty>
          No agents yet. A registered agent can be @mentioned in any thread.
        </SettingsEmpty>
      ) : (
        <SettingsGroup>
          {agents
            .filter((a) => !a.managed)
            .map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                meId={meId}
                hasPersonalPlan={hasPersonalPlan}
                onDone={reload}
              />
            ))}
        </SettingsGroup>
      )}

      {/* How agent runs get billed, in order: the person who triggered the run (their own
          plan), then the agent OWNER's plan (only for agents lent above), then the shared
          workspace pool. The personal plan lives under You → Model plans and is linked
          here; only the workspace pool is managed in place. */}
      <div className="flex flex-col gap-8">
        <SettingsGroup>
          <SettingRow
            label="Your plan"
            description="Runs you start bill your own connected plan first."
          >
            <Button data-testid="agents-manage-plans" variant="outline" size="sm" asChild>
              <Link to="/settings/$section" params={{ section: "model-plans" }}>
                Manage in Model plans
              </Link>
            </Button>
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup
          title="Workspace plan pool"
          description="Optional. A shared plan for runs whose starter has no plan of their own."
        >
          <div>
            <ModelPlanManager scope="pool" />
          </div>
        </SettingsGroup>
      </div>
    </SettingsSection>
  )
}

/** The one workspace-wide agent brake, on by default. On: an agent's change publishes like a
 *  person's — a kept, restorable version, with the publish fan-out. Off: hosted runs and asks
 *  stop being claimed, and chat's publish tool refuses (the draft surfaces in the reply). */
function AgentWritesRow() {
  const qc = useQueryClient()
  const { data: settings } = useQuery(workspaceSettingsQuery())
  // The PATCH is admin-only; mirror that gate so a non-admin sees the state
  // without a switch that 403s on flip.
  const { data: ws } = useQuery(workspaceQuery())
  const isAdmin = ws?.role === "owner"
  const update = useApiMutation({
    mutationFn: (patch: Partial<OrgSettings>) => api.updateWorkspaceSettings(patch),
    optimistic: (patch, client) => {
      const qk = workspaceSettingsQuery().queryKey
      const rollback = snapshot(client, qk)
      client.setQueryData(qk, (prev) => (prev ? { ...prev, ...patch } : prev))
      return rollback
    },
    onSuccess: (s) => qc.setQueryData(workspaceSettingsQuery().queryKey, s),
  })
  if (!settings) return null
  return (
    <SettingsGroup>
      <SettingRow
        htmlFor="toggle-agent-writes"
        label="Agents can write"
        description="On, an agent's change publishes like a person's — versioned, restorable, and announced. Off, agents stop writing: runs pause, and chat puts its drafted change in the reply instead."
      >
        <Switch
          id="toggle-agent-writes"
          data-testid="toggle-agent-writes"
          checked={settings.agentWrites}
          disabled={!isAdmin}
          onCheckedChange={(next) => update.mutate({ agentWrites: next })}
        />
      </SettingRow>
    </SettingsGroup>
  )
}

function NewAgent({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("")
  const [role, setRole] = useState<Role>("commenter")
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null)

  const create = useApiMutation({
    mutationFn: () => api.createAgent(name.trim(), role),
    success: (a) => `Agent ${a.name} created`,
    onSuccess: (a) => {
      setCreated({ name: a.name, token: a.token })
      setName("")
      onCreated()
    },
  })
  return (
    <div className="flex flex-col gap-3">
      <AddForm
        onSubmit={() => create.mutate()}
        submitLabel="Add agent"
        submitTestId="agent-add"
        pending={create.isPending}
        disabled={!name.trim()}
      >
        <Input
          data-testid="agent-name"
          aria-label="Agent name"
          placeholder="Agent name (e.g. Claude)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-45 flex-1"
        />
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger data-testid="agent-role" aria-label="Agent role" className="w-46">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="commenter">Can comment and propose</SelectItem>
            <SelectItem value="editor">Can publish</SelectItem>
          </SelectContent>
        </Select>
      </AddForm>
      {/* The token is shown exactly once, right after creation — a safety-orange
          warning moment, never the accent. Below the form, not inside it: the
          reveal outlives the submit that produced it. */}
      {created && (
        <div data-testid="agent-token">
          <SecretReveal
            title={`Token for ${created.name}. Copy it now; it won't be shown again.`}
            secret={created.token}
            onDone={() => setCreated(null)}
            copyTestId="agent-token-copy"
            doneTestId="agent-token-done"
          />
        </div>
      )}
    </div>
  )
}

function AgentRow({
  agent,
  meId,
  hasPersonalPlan,
  onDone,
}: {
  agent: Agent
  meId: string
  hasPersonalPlan: boolean
  onDone: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [rotated, setRotated] = useState<string | null>(null)
  const remove = useApiMutation({
    mutationFn: () => api.deleteAgent(agent.id),
    success: `Agent ${agent.name} removed`,
    onSuccess: () => onDone(),
  })
  // A credential event, never an identity event: the old bearer dies the moment
  // this succeeds, and the new token is shown exactly once, right here.
  const rotate = useApiMutation({
    mutationFn: () => api.rotateAgent(agent.id),
    success: `Token rotated for ${agent.name}`,
    onSuccess: (a) => setRotated(a.token),
  })
  // Only the agent's OWNER may lend their own plan to it (default off). Others don't see it.
  const isOwner = agent.created_by === meId
  const lend = useApiMutation<{ ok: true }, boolean>({
    mutationFn: (enabled) => api.setAgentOwnerLend(agent.id, enabled),
    success: (_r, enabled) =>
      enabled ? `@${agent.name} may run on your plan` : `@${agent.name} won't use your plan`,
    onSuccess: () => onDone(),
  })
  return (
    <ListRow
      data-testid={`agent-row-${agent.id}`}
      leading={
        <Avatar className="size-7 shrink-0">
          <AvatarFallback>
            <Bot className="size-4" aria-hidden />
          </AvatarFallback>
        </Avatar>
      }
      title={
        <span className="flex items-center gap-1.5">
          @{agent.name}
          <Badge variant="secondary">{agent.role}</Badge>
        </span>
      }
      meta="Mention it in any thread to send it work."
      actions={
        <>
          <Button
            data-testid={`agent-rotate-${agent.id}`}
            variant="ghost"
            size="sm"
            onClick={() => rotate.mutate()}
            loading={rotate.isPending}
            disabled={rotate.isPending}
          >
            Rotate token
          </Button>
          <Button
            data-testid={`agent-remove-${agent.id}`}
            variant="destructive-ghost"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Remove @${agent.name}?`}
            description="Its token stops working immediately."
            confirmLabel="Remove"
            onConfirm={() => remove.mutate()}
          />
        </>
      }
      below={
        <>
          {isOwner && (
            <label
              htmlFor={`agent-lend-${agent.id}`}
              className="flex items-center gap-2 pl-10 text-2xs text-muted-foreground"
            >
              <Switch
                id={`agent-lend-${agent.id}`}
                data-testid={`agent-lend-${agent.id}`}
                checked={agent.owner_lend}
                onCheckedChange={(v) => lend.mutate(v)}
                disabled={lend.isPending || !hasPersonalPlan}
              />
              {hasPersonalPlan
                ? "Fall back to my plan when a run has none of its own"
                : "Connect your plan under You → Model plans to lend it here"}
            </label>
          )}
          {rotated && (
            <div data-testid={`agent-rotated-${agent.id}`}>
              <SecretReveal
                title={`New token for ${agent.name}. Copy it now; it won't be shown again. The old token no longer works.`}
                secret={rotated}
                onDone={() => setRotated(null)}
                copyTestId={`agent-rotated-copy-${agent.id}`}
                doneTestId={`agent-rotated-done-${agent.id}`}
              />
            </div>
          )}
        </>
      }
    />
  )
}
