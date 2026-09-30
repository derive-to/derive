import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { Agent } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { agentsQuery } from "@/lib/queries"
import { machineOf, ownerMachineName, rosterOf, runnerCommand, when } from "@/pages/agents/format"
import { Group, Machine, Meta, RowLine, rowClass } from "@/pages/agents/rows"
import { AgentRowsSkeleton } from "@/pages/agents/skeleton"
import { useMemberNames } from "@/pages/agents/use-member-names"
import { SettingsSection } from "./settings-section"

// Settings › Machines: where the workspace's agents run. One row per person whose own
// machine runs agents (their runner is the owner machine), then Derive when any agent runs
// there. Derived from the agents themselves; a machine is not a thing you create here.
export function MachinesSection() {
  const agents = useQuery(agentsQuery())
  const names = useMemberNames()
  return (
    <SettingsSection title="Machines">
      {agents.isError ? (
        <LoadError
          title="Couldn’t load machines."
          testId="machines-retry"
          onRetry={() => void agents.refetch()}
        />
      ) : agents.isPending ? (
        <AgentRowsSkeleton rows={2} />
      ) : (
        <Machines agents={rosterOf(agents.data)} names={names} />
      )}
    </SettingsSection>
  )
}

function Machines({ agents, names }: { agents: Agent[]; names: Map<string, string> }) {
  const byOwner = new Map<string, Agent[]>()
  for (const a of agents)
    if (a.machine === "owner") {
      const key = a.created_by ?? ""
      byOwner.set(key, [...(byOwner.get(key) ?? []), a])
    }
  const onDerive = agents.filter((a) => a.machine === "derive")
  return (
    <div className="flex flex-col gap-4">
      {byOwner.size + onDerive.length > 0 && (
        <Group testId="machines">
          {[...byOwner].map(([owner, list]) => {
            // The machine's freshest check-in across the agents it runs.
            const seen = list.reduce<Agent | null>(
              (best, a) => (a.seen_at && (!best?.seen_at || a.seen_at > best.seen_at) ? a : best),
              null,
            )
            return (
              <div key={owner} data-testid={`machine-${owner || "unknown"}`} className={rowClass()}>
                <RowLine
                  icon="machine"
                  title={ownerMachineName(owner || null, names)}
                  detail={<AgentLinks agents={list} />}
                />
                <Meta>
                  {seen?.seen_at ? (
                    <Machine
                      mark={{
                        on: machineOf(seen, names).on,
                        label: `seen ${when(seen.seen_at)}`,
                      }}
                    />
                  ) : (
                    <Machine mark={{ on: false, label: "never seen" }} />
                  )}
                </Meta>
              </div>
            )
          })}
          {onDerive.length > 0 && (
            <div data-testid="machine-derive" className={rowClass()}>
              <RowLine icon="cloud" title="Derive" detail={<AgentLinks agents={onDerive} />} />
              <Meta>
                <span>keeps files between runs</span>
              </Meta>
            </div>
          )}
        </Group>
      )}
      <p className="text-sm text-muted-foreground">
        Start a runner on the machine that should do an agent’s work. The key in it is shown once,
        when the agent is made or its key is replaced.
      </p>
      <pre
        data-testid="machines-runner-command"
        className="rounded-lg bg-secondary px-3.5 py-3 font-mono text-sm break-all whitespace-pre-wrap text-foreground"
      >
        {runnerCommand("<agent id>", "<agent key>")}
      </pre>
    </div>
  )
}

function AgentLinks({ agents }: { agents: Agent[] }) {
  return (
    <>
      {agents.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ", "}
          <Link
            to="/agents/$id"
            params={{ id: a.id }}
            search={{}}
            data-testid={`machine-agent-${a.id}`}
            className="hover:text-foreground"
          >
            {a.name}
          </Link>
        </span>
      ))}
    </>
  )
}
