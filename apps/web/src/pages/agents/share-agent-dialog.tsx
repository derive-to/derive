import { useQuery } from "@tanstack/react-query"
import { type FormEvent, useRef, useState } from "react"
import { type AgentDetail, type ArtifactMember, api, type Role } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { ShareAccessSection, SharePeopleSection } from "@/components/shared/share-dialog-sections"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useAuth } from "@/ctx"
import { useApiMutation } from "@/lib/use-api-mutation"

// Share an agent the way a collection is shared: Invited or Workspace on top, the people it is
// shared with below. An editor may ask it for work; an owner may also manage it. Only members
// of its workspace can be added, so there are no email invites.

const AGENT_ROLES: Role[] = ["editor", "owner"]
type AgentRole = "editor" | "owner"

export function ShareAgentDialog({ agent }: { agent: AgentDetail }) {
  const { me } = useAuth()
  const [open, setOpen] = useState(false)
  const [person, setPerson] = useState("")
  const [role, setRole] = useState<Role>("editor")
  // Held across a burst of submits that all read a stale isPending (see the collection dialog).
  const adding = useRef(false)
  // Lending its creator's account narrows who may change it to the creator.
  const canManage =
    agent.can_manage && (agent.spend_policy !== "creator" || agent.created_by === me?.id)
  const members = useQuery({
    queryKey: ["agents", agent.id, "members"] as const,
    queryFn: () => api.listAgentMembers(agent.id).then((r) => r.members),
    enabled: open,
  })
  const roster = [["agents", agent.id, "members"] as const]
  const access = useApiMutation({
    mutationFn: (ask_policy: AgentDetail["ask_policy"]) =>
      api.updateAgent(agent.id, { ask_policy }),
    invalidate: [["agents"]],
  })
  const add = useApiMutation({
    mutationFn: (user: string) => api.setAgentMember(agent.id, user, role as AgentRole),
    invalidate: roster,
    onSuccess: () => setPerson(""),
  })
  const change = useApiMutation({
    mutationFn: ({ m, next }: { m: ArtifactMember; next: Role }) =>
      api.setAgentMember(agent.id, m.handle ?? m.user_id, next as AgentRole),
    invalidate: roster,
  })
  const remove = useApiMutation({
    mutationFn: (m: ArtifactMember) => api.removeAgentMember(agent.id, m.user_id),
    invalidate: roster,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const user = person.trim()
    if (!user || adding.current) return
    adding.current = true
    add.mutate(user, {
      onSettled: () => {
        adding.current = false
      },
    })
  }
  const segment = agent.ask_policy === "workspace" ? "workspace" : "invite"

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="agent-share">
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="line-clamp-1 pr-6">Share “{agent.name}”</DialogTitle>
          <DialogDescription>
            Editors can ask it for work. Owners can also change its settings and who it’s shared
            with.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6">
          <ShareAccessSection
            canManage={canManage}
            pending={access.isPending}
            segment={segment}
            segments={["invite", "workspace"]}
            title="Who can ask it"
            testPrefix="agent-share"
            inviteCopy="Only you, the workspace owners and the people below can ask it."
            workspaceCopy="Everyone in the workspace can ask it for work."
            readOnlyIcon={segment === "workspace" ? "workspace" : "lock"}
            readOnlyCopy={
              segment === "workspace"
                ? "Everyone in the workspace can ask it."
                : "Only the people it’s shared with can ask it."
            }
            onSegmentChange={(next) =>
              access.mutate(next === "workspace" ? "workspace" : "invited")
            }
          />
          {members.isError && (
            <LoadError
              layout="inline"
              title="Couldn’t load who it’s shared with."
              testId="agent-share-retry"
              onRetry={() => void members.refetch()}
            />
          )}
          <SharePeopleSection
            members={members.data ?? []}
            invites={[]}
            roles={AGENT_ROLES}
            placeholder="Add a workspace member by @username or email…"
            currentUserId={me?.id}
            canManage={canManage}
            email={person}
            role={role}
            pending={add.isPending}
            testPrefix="agent-share"
            memberIsFixed={(m) => m.user_id === agent.created_by}
            onEmailChange={setPerson}
            onRoleChange={setRole}
            onAdd={submit}
            onMemberRoleChange={(m, next) => next !== m.role && change.mutate({ m, next })}
            onRemoveMember={(m) => remove.mutate(m)}
            onRevokeInvite={() => {}}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
