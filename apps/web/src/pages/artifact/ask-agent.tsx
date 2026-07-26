import type { DirUser } from "@/api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getInitials } from "@/lib/initials"
import type { AgentTarget } from "./types"

/** What "we handed this to your agent" means: the inbox is a PULL queue, so the work
 *  starts when the agent next connects, not now. One wording, so no surface implies
 *  something is already running. */
export const queuedFor = (what: string, agentName: string) =>
  `${what} queued for ${agentName}. It runs the next time your agent checks in.`
export const ALREADY_QUEUED = "Already queued. It runs the next time your agent checks in."

/** Directory rows an ask-an-agent affordance can actually address: named agents
 *  only. The directory query already drops nameless rows; the type predicate is what
 *  narrows `name` to non-null for TS. Shared with the Rework ⋯ item. */
export const usableAgents = (agents: DirUser[]) =>
  agents.filter((a): a is DirUser & { name: string } => !!a.name)

/**
 * The one "hand this to an agent" control: no addressable agent renders nothing, a lone
 * agent fires straight from the trigger, several open a picker. Callers own their trigger
 * (a selection-bar pill, a card's primary button) and get the sole agent back so the
 * label can name them; everything below the trigger is shared, so the two affordances
 * can't drift apart.
 */
export function AgentMenu({
  agents,
  menuLabel,
  testidPrefix,
  align = "start",
  onPick,
  trigger,
}: {
  agents: DirUser[]
  /** Heading over the picker (several agents). */
  menuLabel: string
  /** Per-agent test ids: `${testidPrefix}-${agent.id}`. */
  testidPrefix: string
  align?: "start" | "end"
  onPick: (agent: AgentTarget) => void
  /** `sole` is set only when it fires directly — name them in the label if you like. */
  trigger: (p: { sole: AgentTarget | null; onClick?: () => void }) => React.ReactNode
}) {
  const usable = usableAgents(agents)
  const [sole, ...rest] = usable
  if (!sole) return null
  if (rest.length === 0)
    return trigger({ sole, onClick: () => onPick({ id: sole.id, name: sole.name }) })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger({ sole: null })}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-56">
        <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
        {usable.map((a) => (
          <DropdownMenuItem
            key={a.id}
            data-testid={`${testidPrefix}-${a.id}`}
            onSelect={() => onPick({ id: a.id, name: a.name })}
          >
            <span className="grid size-5 place-items-center rounded-full bg-primary/10 font-mono text-2xs font-medium text-primary">
              {getInitials(a.name)}
            </span>
            <span className="truncate">{a.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
