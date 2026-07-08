import { useEffect, useState } from "react"
import { type ArtifactMember, api, type Collection, type Role, type WorkspaceAccess } from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { ROLE_LABELS, RoleSelect } from "@/components/shared/role-select"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

// Same share experience as an artifact (docs/plans/access-model.md), minus the
// Anyone segment — a collection isn't individually link-servable content, it's a
// grouping of other artifacts, each with its own access. So just the one
// question: invite-only, or does the workspace reach it at each member's seat?
type Segment = "invite" | "workspace"
const SEGMENTS: { value: Segment; label: string; icon: IconName }[] = [
  { value: "invite", label: "Invited", icon: "lock" },
  { value: "workspace", label: "Workspace", icon: "workspace" },
]

// Share a collection: who can open it at all (Invited vs Workspace, applies
// immediately, no Save — mirrors the artifact ShareDialog), plus the people
// roster whose role applies to every artifact inside it.
export function ShareCollectionDialog({
  collection,
  onClose,
}: {
  collection: Collection
  onClose: () => void
}) {
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const [wsAccess, setWsAccess] = useState<WorkspaceAccess>(collection.workspace_access ?? "member")
  const [savingAccess, setSavingAccess] = useState(false)

  // Unlike an artifact (editors can share — GDocs model), a collection's access
  // and membership routes are owner-only on the backend (same bar as delete —
  // pre-dates this dialog, see collections.ts's canManageCollection(..., "manage")
  // calls). Match that here: an editor would otherwise see live-looking controls
  // that 403 on every action.
  const canManage = collection.my_role === "owner"

  const load = () => {
    api
      .listCollectionMembers(collection.id)
      .then((r) => setMembers(r.members))
      .catch(() => {})
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch members when the shared collection changes; load reads collection.id.
  useEffect(() => {
    load()
  }, [collection.id])

  // Applies immediately — a Save button between a toggle and its effect is
  // friction with no safety benefit (same call the artifact dialog makes).
  const applyAccess = async (next: WorkspaceAccess) => {
    const prev = wsAccess
    setWsAccess(next)
    setSavingAccess(true)
    try {
      const r = await api.setCollectionAccess(collection.id, next)
      setWsAccess(r.workspace_access)
    } catch (x) {
      setWsAccess(prev)
      toast.error(x instanceof Error ? x.message : "Couldn't update access")
    } finally {
      setSavingAccess(false)
    }
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) return
    setBusy(true)
    try {
      await api.setCollectionMember(collection.id, addr, role)
      setEmail("")
      load()
    } catch (x) {
      toast.error(x instanceof Error ? x.message : "Couldn't share")
    } finally {
      setBusy(false)
    }
  }
  const remove = async (m: ArtifactMember) => {
    try {
      await api.removeCollectionMember(collection.id, m.user_id)
    } catch (x) {
      toast.error(x instanceof Error ? x.message : "Couldn't remove member")
    }
    load()
  }
  // Re-role an existing member in place — setCollectionMember upserts server-side,
  // so this is the same call the Add form makes, just keyed by their handle.
  const change = async (m: ArtifactMember, next: Role) => {
    if (next === m.role || !m.handle) return
    try {
      await api.setCollectionMember(collection.id, m.handle, next)
    } catch (x) {
      toast.error(x instanceof Error ? x.message : "Couldn't update their role")
    }
    load()
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="line-clamp-1 pr-6">Share “{collection.title}”</DialogTitle>
          <DialogDescription>
            People here get this role on{" "}
            <b className="font-medium text-foreground">every artifact</b> in the collection.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          <div>
            <SectionEyebrow action={savingAccess && <Spinner className="size-3" />}>
              Who can open this
            </SectionEyebrow>
            {canManage ? (
              <div className="mt-2 flex flex-col">
                <ToggleGroup
                  type="single"
                  value={wsAccess === "member" ? "workspace" : "invite"}
                  onValueChange={(v) => v && applyAccess(v === "workspace" ? "member" : "none")}
                  data-testid="collection-share-access"
                  className="w-full gap-[3px] rounded-lg bg-secondary p-[3px]"
                >
                  {SEGMENTS.map((s) => (
                    <ToggleGroupItem
                      key={s.value}
                      value={s.value}
                      disabled={savingAccess}
                      data-testid={`collection-share-access-${s.value}`}
                      className="h-8 flex-1 gap-1.5 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
                    >
                      <Icon name={s.icon} />
                      {s.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {wsAccess === "none" ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Only the people you add below can open this.
                  </p>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Everyone in the workspace opens this at their role — admins manage, editors
                    edit, commenters comment.
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {wsAccess === "member"
                  ? "Everyone in the workspace can open this."
                  : "Only people added below can open this."}
              </p>
            )}
          </div>

          <div>
            <SectionEyebrow>People with access</SectionEyebrow>
            {canManage && (
              <form onSubmit={add} className="mt-2 flex gap-1.5">
                <PersonSearchInput
                  value={email}
                  onChange={setEmail}
                  placeholder="@username or email"
                  testId="collection-share-email"
                  className="min-w-0"
                />
                <RoleSelect
                  value={role}
                  onChange={setRole}
                  data-testid="collection-share-role"
                  className="w-28 shrink-0"
                />
                {/* Add is this dialog's one filled primary. */}
                <Button
                  variant="default"
                  type="submit"
                  data-testid="collection-share-add"
                  loading={busy}
                >
                  {busy ? "Adding…" : "Add"}
                </Button>
              </form>
            )}

            {members.length === 0 ? (
              <EmptyState className="mt-2 p-6">No one shared yet.</EmptyState>
            ) : (
              <div className="mt-2 flex flex-col gap-1.5">
                {members.map((m) => (
                  <div key={m.user_id} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {m.name ?? (m.handle ? `@${m.handle}` : m.user_id)}
                      </div>
                      {m.name && m.handle && (
                        <div className="truncate font-mono text-2xs text-muted-foreground">
                          @{m.handle}
                        </div>
                      )}
                    </div>
                    {canManage ? (
                      <>
                        <RoleSelect
                          value={m.role}
                          onChange={(next) => change(m, next)}
                          data-testid={`collection-share-member-role-${m.user_id}`}
                          aria-label={`Role for ${m.name ?? (m.handle ? `@${m.handle}` : "member")}`}
                          className="w-28 shrink-0"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid={`collection-share-remove-${m.user_id}`}
                          onClick={() => remove(m)}
                          aria-label={`Remove ${m.name ?? (m.handle ? `@${m.handle}` : "member")}`}
                        >
                          <Icon name="close" />
                        </Button>
                      </>
                    ) : (
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {ROLE_LABELS[m.role]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
