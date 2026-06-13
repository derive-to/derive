import { Share2, X } from "lucide-react"
import { useState } from "react"
import { type ArtifactMember, api, type Role } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { RoleSelect } from "@/components/shared/role-select"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

const BLURB: Record<Role, string> = {
  viewer: "Can view",
  commenter: "Can view and comment",
  editor: "Can publish new versions",
  owner: "Full control, incl. sharing",
}

/**
 * Per-artifact sharing, opened from the artifact header. Add people by email at a
 * role, change a member's role, or remove them. Only an owner of this artifact
 * can manage shares; for anyone else the trigger isn't rendered. Built on the
 * shared Dialog primitive (focus trap, Esc, roles for free) and RoleSelect.
 */
export function ShareButton({ shortId, myRole }: { shortId: string; myRole?: Role | null }) {
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [defaultRole, setDefaultRole] = useState<Role>("editor")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Only an owner can manage shares; hide the affordance otherwise.
  if (myRole !== "owner") return null

  const load = () =>
    api
      .listMembers(shortId)
      .then((r) => {
        setMembers(r.members)
        setDefaultRole(r.default_role)
      })
      .catch(() => {})

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) return
    setBusy(true)
    setErr(null)
    try {
      await api.setMember(shortId, addr, role)
      setEmail("")
      await load()
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Could not share")
    } finally {
      setBusy(false)
    }
  }
  const change = async (m: ArtifactMember, next: Role) => {
    if (next === m.role || !m.email) return
    await api.setMember(shortId, m.email, next).catch(() => {})
    await load()
  }
  const remove = async (m: ArtifactMember) => {
    await api.removeMember(shortId, m.user_id).catch(() => {})
    await load()
  }

  return (
    <Dialog
      onOpenChange={(o) => {
        if (o) {
          setErr(null)
          load()
        }
      }}
    >
      <DialogTrigger asChild>
        <Button data-testid="share-trigger" variant="default" size="sm" title="Share this artifact">
          <Share2 />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this artifact</DialogTitle>
          <DialogDescription>
            Add people by email. Everyone you don't list is a{" "}
            <b className="text-foreground">{defaultRole}</b> by default.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={add} className="flex gap-1.5">
          <Input
            data-testid="share-email"
            type="email"
            placeholder="teammate@email.com"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1"
          />
          <div data-testid="share-role" className="w-[104px]">
            <RoleSelect
              value={role}
              onChange={setRole}
              aria-label="Role for new member"
              className="w-full"
            />
          </div>
          <Button data-testid="share-add" variant="primary" type="submit" disabled={busy}>
            {busy ? "…" : "Add"}
          </Button>
        </form>
        <p className="mt-1.5 font-mono text-2xs text-muted-foreground">{BLURB[role]}.</p>
        {err && (
          <p data-testid="share-error" role="alert" className="mt-2 text-xs text-destructive">
            {err}
          </p>
        )}

        <div className="mt-3.5">
          {members.length === 0 ? (
            <div data-testid="share-empty">
              <EmptyState className="p-6 text-xs">No one shared yet.</EmptyState>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {members.map((m) => (
                <div
                  key={m.user_id}
                  data-testid={`share-member-row-${m.user_id}`}
                  className="flex items-center gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {m.name ?? m.email ?? m.user_id}
                    </div>
                    {m.name && m.email && (
                      <div className="truncate text-2xs text-muted-foreground">{m.email}</div>
                    )}
                  </div>
                  <div data-testid={`share-member-role-${m.user_id}`} className="w-[92px]">
                    <RoleSelect
                      value={m.role}
                      onChange={(next) => change(m, next)}
                      aria-label={`Role for ${m.name ?? m.email ?? "member"}`}
                      className="w-full"
                    />
                  </div>
                  <Button
                    data-testid={`share-member-remove-${m.user_id}`}
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    onClick={() => remove(m)}
                    aria-label={`Remove ${m.name ?? m.email ?? "member"}`}
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
