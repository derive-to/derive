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
  const single = usable.length === 1 ? usable[0] : null
  if (usable.length === 0 || (usable.length === 1 && !single)) return null

  // The desktop pill names a lone agent ("Ask Reviser"); the mobile bar and the
  // multi-agent picker use the generic verb.
  const label = single && size === "default" ? `Ask ${single.name.split(/\s+/)[0]}` : "Ask an agent"

  // One Button recipe, whether it fires directly (single agent) or triggers the picker
  // (several) — so the pill's look can't drift between the two paths. onMouseDown
  // preventDefault keeps it from stealing the document selection it acts on.
  const trigger = (extra?: React.ComponentProps<typeof Button>) => (
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
      {...extra}
    >
      <Icon name="sparkles" size={16} className="text-primary" />
      {label}
    </Button>
  )

  // Single agent → straight into the request composer, no menu.
  if (single)
    return trigger({
      title: `Ask ${single.name} to revise the selection`,
      onClick: () => onPick({ id: single.id, name: single.name }),
    })

  // Several agents → a picker so the human chooses whom to hand the change to.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>
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
