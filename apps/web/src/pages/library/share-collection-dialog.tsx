import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { type ArtifactMember, api, type Collection, type Role } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { RoleSelect } from "@/components/shared/role-select"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

// Share a collection: add people by email at a role. A member's role applies to
// every artifact in the collection (the headline of collection-level sharing).
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

  const load = useCallback(() => {
    api
      .listCollectionMembers(collection.id)
      .then((r) => setMembers(r.members))
      .catch(() => {})
  }, [collection.id])
  useEffect(() => {
    load()
  }, [load])

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
      toast.error((x as Error).message)
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

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{collection.title}”</DialogTitle>
          <DialogDescription>
            People here get this role on{" "}
            <b className="font-medium text-foreground">every artifact</b> in the collection.
          </DialogDescription>
        </DialogHeader>

        {/* DialogContent's grid gap spaces the sections — no child margins. */}
        <form onSubmit={add} className="flex gap-1.5">
          <Input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            data-testid="collection-share-email"
            placeholder="@username or email"
            aria-label="Username or email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-w-0 flex-1"
          />
          <RoleSelect
            value={role}
            onChange={setRole}
            data-testid="collection-share-role"
            className="w-[104px] shrink-0"
          />
          {/* Add is this dialog's one filled primary. */}
          <Button
            variant="default"
            type="submit"
            data-testid="collection-share-add"
            disabled={busy}
          >
            {busy ? "…" : "Add"}
          </Button>
        </form>

        {members.length === 0 ? (
          <EmptyState className="p-6">No one shared yet.</EmptyState>
        ) : (
          <div className="flex flex-col gap-1.5">
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
                <span className="font-mono text-xs text-muted-foreground">{m.role}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid={`collection-share-remove-${m.user_id}`}
                  onClick={() => remove(m)}
                  title="Remove"
                  aria-label={`Remove ${m.name ?? (m.handle ? `@${m.handle}` : "member")}`}
                >
                  <Icon name="close" size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
