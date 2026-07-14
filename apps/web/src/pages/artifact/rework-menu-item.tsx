import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { ConnectAgent } from "@/components/shared/connect-agent"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/ctx"
import { artifactAgentsQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { reworkState } from "./rework-state"
import type { AgentTarget } from "./types"

// "Rework with Brandprint" — the ⋯ menu's apply-on-demand entry (Brandprint Phase 3):
// a canned version of the ask-agent handoff, scoped to the whole artifact. One
// self-contained component owns the four-state logic (set-up / connect / fire /
// picker) so the top bar stays lean. The canned instruction lives server-side; this
// only chooses the agent and fires.
export function ReworkMenuItem({
  shortId,
  onConnect,
}: {
  shortId: string
  /** Open the shared Connect-an-agent dialog (portaled by the top bar — a dialog
   *  inside DropdownMenuContent would unmount when the menu closes on select). */
  onConnect: () => void
}) {
  const { me } = useAuth()
  const nav = useNavigate()
  const {
    data: settings,
    isPending: settingsPending,
    isError: settingsError,
  } = useQuery({ ...workspaceSettingsQuery(), enabled: !!me })
  const {
    data: agents = [],
    isPending: agentsPending,
    isError: agentsError,
  } = useQuery({ ...artifactAgentsQuery(shortId), enabled: !!me })
  const fire = useApiMutation<{ requestId: string }, AgentTarget>({
    mutationFn: (agent) => api.reworkArtifact(shortId, agent.id),
    success: (_r, agent) => `Rework request sent to ${agent.name}.`,
  })
  // Anonymous viewers can't fire an agent or own a Brandprint — no item at all. This
  // check must stay FIRST: the queries are gated on `me`, and a disabled query reports
  // pending forever, so the pending guard below would otherwise hide the item for good.
  if (!me) return null
  // While either read is in flight the state is unknowable — computing it off
  // undefined data would flash "Set up your Brandprint" at a member whose workspace
  // Brandprint just hasn't loaded (and a fast click would misroute to /brandprint).
  // Render nothing until the data settles; the item then appears in its true state.
  if (settingsPending || agentsPending) return null
  // A failed ambient read: rather than guess at a state from partial data, hide the
  // affordance (the ApplyNudge convention on the Brandprint page itself).
  if (settingsError || agentsError) return null

  const hasBrandprint = !!settings?.brandprint?.collectionId || !!me.brandprint?.collectionId
  // artifactAgentsQuery already drops nameless agents; this re-asserts it with a type
  // predicate because a plain filter doesn't narrow `name` to non-null for TS.
  const usable = agents.filter((a): a is typeof a & { name: string } => !!a.name)
  const state = reworkState(hasBrandprint, usable.length)

  let item: React.ReactNode
  if (state === "setup")
    item = (
      <DropdownMenuItem data-testid="rework-setup" onSelect={() => nav({ to: "/brandprint" })}>
        <Icon name="sparkles" size={16} /> Set up your Brandprint
      </DropdownMenuItem>
    )
  else if (state === "connect")
    item = (
      <DropdownMenuItem data-testid="rework-connect" onSelect={onConnect}>
        <Icon name="sparkles" size={16} /> Rework with Brandprint
      </DropdownMenuItem>
    )
  else if (state === "fire") {
    const sole = usable[0]
    // reworkState guarantees exactly one usable agent in this branch; the guard is
    // just to satisfy noUncheckedIndexedAccess, not a real runtime path.
    if (!sole) return null
    item = (
      <DropdownMenuItem
        data-testid="rework-fire"
        disabled={fire.isPending}
        onSelect={() => fire.mutate({ id: sole.id, name: sole.name })}
      >
        <Icon name="sparkles" size={16} /> Rework with Brandprint
      </DropdownMenuItem>
    )
  } else
    item = (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="rework-pick" disabled={fire.isPending}>
          <Icon name="sparkles" size={16} /> Rework with Brandprint
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {usable.map((a) => (
            <DropdownMenuItem
              key={a.id}
              data-testid={`rework-pick-${a.id}`}
              disabled={fire.isPending}
              onSelect={() => fire.mutate({ id: a.id, name: a.name })}
            >
              {a.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )

  // The leading separator rides WITH the item, so when every guard above bails the
  // menu doesn't keep an orphaned rule next to the Activity group's own separator.
  return (
    <>
      <DropdownMenuSeparator />
      {item}
    </>
  )
}

// The shared Connect-an-agent surface, dialog-wrapped — Rework's no-agent state is
// its fifth entry point (see docs/plans/brandprint.md, "one shared surface").
export function ReworkConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect an agent</DialogTitle>
          <DialogDescription>
            One paste connects any MCP agent to Derive — it can then publish, review, and revise for
            you.
          </DialogDescription>
        </DialogHeader>
        <ConnectAgent testidPrefix="rework-connect" />
      </DialogContent>
    </Dialog>
  )
}
