import type { DirUser } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import type { AgentTarget } from "./types"

// The "ask an agent to revise this selection" affordance, shared by the desktop
// selection pill and the mobile selection bar. This is Derive's agent-native moat: a
// human hands a scoped change to a registered agent, whose MCP inbox the request lands
// in; the agent revises + proposes, and the human reviews. With ONE agent it fires
// immediately; with several it opens a small picker. `agents` empty ⇒ render nothing.
export function AskAgentButton({
  agents,
  onPick,
  size = "default",
  className,
}: {
  agents: DirUser[]
  onPick: (agent: AgentTarget) => void
  /** "default" desktop pill · "bar" the fuller mobile bar button. */
  size?: "default" | "bar"
  className?: string
}) {
  const usable = agents.filter((a): a is DirUser & { name: string } => !!a.name)
  if (usable.length === 0) return null

  const label =
    size === "bar"
      ? "Ask an agent"
      : usable.length === 1
        ? `Ask ${firstName(usable[0])}`
        : "Ask an agent"

  // The single-agent fast path — no menu, straight into the request composer.
  if (usable.length === 1) {
    const only = usable[0]
    if (!only) return null
    return (
      <Button
        variant="outline"
        size="sm"
        title={`Ask ${only.name} to revise the selection`}
        data-testid="ask-agent"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick({ id: only.id, name: only.name })}
        className={cn(
          "rounded-full border-primary/30 text-foreground hover:border-primary/50",
          size === "bar" && "shrink-0",
          className,
        )}
      >
        <Icon name="sparkles" size={16} className="text-primary" />
        {label}
      </Button>
    )
  }

  // Several agents — a picker so the human chooses whom to hand the change to.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="ask-agent"
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            "rounded-full border-primary/30 text-foreground hover:border-primary/50",
            size === "bar" && "shrink-0",
            className,
          )}
        >
          <Icon name="sparkles" size={16} className="text-primary" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Ask an agent to revise</DropdownMenuLabel>
        {usable.map((a) => (
          <DropdownMenuItem
            key={a.id}
            data-testid={`ask-agent-${a.id}`}
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

const firstName = (a: DirUser | undefined): string =>
  (a?.name ?? "agent").split(/\s+/)[0] ?? "agent"
