import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot } from "lucide-react"
import { useState } from "react"
import { type Agent, api, type Role } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SecretReveal } from "@/components/shared/secret-reveal"
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
import { agentsQuery, modelCredentialsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
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
      title="Agents"
      description={
        <>
          Register an agent so people can <code className="font-mono">@mention</code> it in a
          thread. It gets a scoped token and acts as a commenter — it can propose changes for
          review, but a human still approves. The agent reads its mentions from{" "}
          <code className="font-mono">GET /v1/agent/inbox</code> with its token.
        </>
      }
    >
      <NewAgent onCreated={reload} />

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <LoadError title="Couldn’t load agents" testId="agents-retry" onRetry={() => refetch()} />
      ) : !agents || agents.filter((a) => !a.managed).length === 0 ? (
        <EmptyState>No agents yet. Add one above.</EmptyState>
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
          plan, below), then the agent OWNER's plan (only for agents lent above), then the
          shared workspace pool. Both plan surfaces live here so it's one place to reason
          about; your own plan also lives under Account → Model plans. */}
      <div className="flex flex-col gap-5">
        <SettingsGroup
          title="Your plan"
          description="Runs you start bill your own connected plan first. Same plan as Account → Model plans; connect it here or there."
        >
          {/* One padding-neutral wrapper: SettingsGroup strips its first/last
              child's vertical padding (a row contract) and divides siblings,
              which would shave the connect well's p-4 and draw a stray hairline
              through the manager's fragment. */}
          <div>
            <ModelPlanManager scope="personal" />
          </div>
        </SettingsGroup>

        <SettingsGroup
          title="Workspace model plan pool"
          description="A shared plan billed when a run's initiator has no plan of their own and the agent isn't lent its owner's. Optional — leave it empty to require everyone to bring their own."
        >
          <div>
            <ModelPlanManager scope="pool" />
          </div>
        </SettingsGroup>
      </div>
    </SettingsSection>
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
          <SelectTrigger data-testid="agent-role" aria-label="Agent role" className="w-37.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="commenter">Commenter (propose)</SelectItem>
            <SelectItem value="editor">Editor (publish)</SelectItem>
          </SelectContent>
        </Select>
      </AddForm>
      {/* The token is shown exactly once, right after creation — a safety-orange
          warning moment, never the accent. Below the form, not inside it: the
          reveal outlives the submit that produced it. */}
      {created && (
        <div data-testid="agent-token">
          <SecretReveal
            title={`Token for ${created.name} — copy it now, it won't be shown again.`}
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
                : "Connect your plan under Account → Model plans to lend it here"}
            </label>
          )}
          {rotated && (
            <div data-testid={`agent-rotated-${agent.id}`}>
              <SecretReveal
                title={`New token for ${agent.name} — copy it now, it won't be shown again. The old one is dead.`}
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
