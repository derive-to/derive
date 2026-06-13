import { useCallback, useEffect, useState } from "react"
import { type ArtifactMember, api, type Collection, type Role } from "@/api"
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
  show,
  onClose,
}: {
  collection: Collection
  show: (m: string) => void
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
      show((x as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (m: ArtifactMember) => {
    await api.removeCollectionMember(collection.id, m.user_id).catch(() => {})
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
            People here get this role on <b className="text-foreground">every artifact</b> in the
            collection.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={add} className="mb-3 flex gap-1.5">
          <Input
            type="email"
            placeholder="teammate@email.com"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1"
          />
          <RoleSelect value={role} onChange={setRole} className="w-[104px]" />
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "…" : "Add"}
          </Button>
        </form>

        {members.length === 0 ? (
          <EmptyState className="p-6 text-xs">No one shared yet.</EmptyState>
        ) : (
          <div className="flex flex-col gap-1.5">
            {members.map((m) => (
              <div key={m.user_id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {m.name ?? m.email ?? m.user_id}
                  </div>
                  {m.name && m.email && (
                    <div className="truncate text-2xs text-muted-foreground">{m.email}</div>
                  )}
                </div>
                <span className="font-mono text-xs text-muted-foreground">{m.role}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  onClick={() => remove(m)}
                  title="Remove"
                  aria-label={`Remove ${m.name ?? m.email ?? "member"}`}
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
