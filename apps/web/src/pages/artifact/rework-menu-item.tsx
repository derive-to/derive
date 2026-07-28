import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ApiError, api } from "@/api"
import { Icon } from "@/components/icons"
import { ConnectAgentDialogContent } from "@/components/shared/connect-agent"
import { Dialog } from "@/components/ui/dialog"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { artifactAgentsQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { ALREADY_QUEUED, queuedFor, usableAgents } from "./ask-agent"
import { resolveRework } from "./rework-state"
import type { AgentTarget } from "./types"

// "Rework with Brandprint" — the ⋯ menu's apply-on-demand entry: a canned version of
// the ask-agent handoff, scoped to the whole artifact. One self-contained component
// owns the four-state logic (set-up / connect / fire / picker) so the top bar stays
// lean. The canned instruction lives server-side; this only chooses the agent and
// fires.
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
  // workspaceSettingsQuery reads the VIEWER'S ACTIVE workspace, not necessarily the
  // artifact's — a share recipient or a multi-workspace member looking at another
  // workspace's artifact can see a stale/wrong approximation here. That's fine: the
  // server resolves the real workspace and 409s (needsAgent/needsBrandprint) when this
  // client-side guess disagrees, and the fire mutation's onError below routes those
  // 409s back to the correct state instead of surfacing the raw mismatch.
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
    success: (_r, agent) => queuedFor("Rework", agent.name),
    // The state computed below is a client-side approximation (see the comment on
    // workspaceSettingsQuery above), so a stale cache can draw a 409. Instead of
    // toasting that, route to the state the client should have shown; a re-fire while
    // the last request still waits is information, not an error.
    errorToast: false,
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : undefined
      if (code === "needsAgent") onConnect()
      else if (code === "needsBrandprint") nav({ to: "/brandprint" })
      else if (code === "alreadyQueued") toast(ALREADY_QUEUED)
      else if (code === "brandprintDisabled")
        toast.error("Brandprint is turned off in your settings. Turn it on to rework.")
      else toast.error("Rework request failed — try again.")
    },
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

  // A workspace Brandprint of just { profileId } (no conventions collection, only the
  // generated brand profile) still counts — both fields are nullish/optional in the
  // schema, so collectionId alone would wrongly read as "not set up".
  const hasBrandprint =
    !!settings?.brandprint?.collectionId ||
    !!settings?.brandprint?.profileId ||
    !!me.brandprint?.collectionId
  const rework = resolveRework(hasBrandprint, usableAgents(agents))

  let item: React.ReactNode
  if (rework.state === "setup")
    item = (
      <DropdownMenuItem data-testid="rework-setup" onSelect={() => nav({ to: "/brandprint" })}>
        <Icon name="sparkles" size={16} /> Set up your Brandprint
      </DropdownMenuItem>
    )
  else if (rework.state === "connect")
    item = (
      <DropdownMenuItem data-testid="rework-connect" onSelect={onConnect}>
        <Icon name="sparkles" size={16} /> Rework with Brandprint
      </DropdownMenuItem>
    )
  else if (rework.state === "fire")
    item = (
      <DropdownMenuItem
        data-testid="rework-fire"
        disabled={fire.isPending}
        onSelect={() => fire.mutate({ id: rework.agent.id, name: rework.agent.name })}
      >
        <Icon name="sparkles" size={16} /> Rework with Brandprint
      </DropdownMenuItem>
    )
  else
    item = (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="rework-pick" disabled={fire.isPending}>
          <Icon name="sparkles" size={16} /> Rework with Brandprint
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {rework.agents.map((a) => (
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
// one of its entry points.
export function ReworkConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ConnectAgentDialogContent testidPrefix="rework-connect" />
    </Dialog>
  )
}
