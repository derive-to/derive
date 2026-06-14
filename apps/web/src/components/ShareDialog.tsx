import { useQueryClient } from "@tanstack/react-query"
import { Lock, Share2, X } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { API_BASE, type ArtifactDomain, type ArtifactMember, api, type Role } from "@/api"
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

const ROLE_LABEL: Record<Role, string> = {
  viewer: "Viewer",
  commenter: "Commenter",
  editor: "Editor",
  owner: "Owner",
}

// General access (visibility) options, in order of decreasing reach.
const ACCESS: { value: string; label: string; blurb: string }[] = [
  { value: "public", label: "Public — listed", blurb: "In the public directory and indexable." },
  { value: "link", label: "Anyone with the link", blurb: "Anyone with the link can view." },
  { value: "org", label: "Workspace only", blurb: "Only members of this workspace." },
  {
    value: "password",
    label: "Password protected",
    blurb: "Anyone with the link and the password.",
  },
]

/**
 * Per-artifact sharing, opened from the artifact header. Follows the Google Docs
 * model: the Share button is ALWAYS visible. Owners and editors can add people by
 * email, change a member's role, or remove them; everyone else sees a read-only
 * "view only" panel, so the access state is always legible. Built on the shared
 * Dialog primitive (focus trap, Esc) and RoleSelect.
 */
export function ShareButton({
  shortId,
  myRole,
  visibility,
}: {
  shortId: string
  myRole?: Role | null
  visibility: string
}) {
  const qc = useQueryClient()
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [defaultRole, setDefaultRole] = useState<Role>("editor")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // General access (visibility) draft + a password when enabling/changing password.
  const [vis, setVis] = useState(visibility)
  const [pw, setPw] = useState("")
  const [savingVis, setSavingVis] = useState(false)

  const [copied, setCopied] = useState(false)

  // Domain mode (vanity subdomains). `domainBase` is null when the server has no
  // base configured, which hides the whole section.
  const [domains, setDomains] = useState<ArtifactDomain[]>([])
  const [domainBase, setDomainBase] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  const [claiming, setClaiming] = useState(false)

  // GDocs model: owners and editors manage access; everyone else gets view-only.
  const canManage = myRole === "owner" || myRole === "editor"

  // Embed snippet: an iframe of the embeddable view. Same-origin by default; the
  // split-deploy SPA points at the API origin via API_BASE. The embed only shows
  // for others when the artifact is link- or world-readable.
  const origin = API_BASE || (typeof window === "undefined" ? "" : window.location.origin)
  const embedSnippet = `<iframe src="${origin}/v1/embed/${shortId}" width="100%" height="480" style="border:0;border-radius:12px" loading="lazy" title="Dock artifact" allowfullscreen></iframe>`
  const linkAccessible = visibility === "public" || visibility === "link"
  const copyEmbed = async () => {
    try {
      await navigator.clipboard.writeText(embedSnippet)
      setCopied(true)
      toast.success("Embed code copied")
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Couldn't copy to clipboard")
    }
  }

  const saveVisibility = async () => {
    setSavingVis(true)
    setErr(null)
    try {
      await api.setVisibility(shortId, vis, vis === "password" && pw ? pw : undefined)
      setPw("")
      // Refresh the artifact (drives the toolbar/visibility) and the library.
      qc.invalidateQueries({ queryKey: ["artifact", shortId] })
      qc.invalidateQueries({ queryKey: ["artifacts"] })
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Couldn't update access")
    } finally {
      setSavingVis(false)
    }
  }
  // Enabling password needs a password; an unchanged selection has nothing to save.
  const needsPw = vis === "password" && visibility !== "password" && !pw
  const visUnchanged = vis === visibility && !pw

  const load = () =>
    api
      .listMembers(shortId)
      .then((r) => {
        setMembers(r.members)
        setDefaultRole(r.default_role)
      })
      .catch(() => {})
  // After a share change, refresh the local list AND the shared cache: the artifact
  // query holds `my_role` (drives the toolbar), and the library reflects access.
  const synced = async () => {
    await load()
    qc.invalidateQueries({ queryKey: ["artifact", shortId] })
    qc.invalidateQueries({ queryKey: ["artifacts"] })
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) return
    setBusy(true)
    setErr(null)
    try {
      await api.setMember(shortId, addr, role)
      setEmail("")
      await synced()
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Could not share")
    } finally {
      setBusy(false)
    }
  }
  const change = async (m: ArtifactMember, next: Role) => {
    if (next === m.role || !m.email) return
    await api.setMember(shortId, m.email, next).catch(() => {})
    await synced()
  }
  const remove = async (m: ArtifactMember) => {
    await api.removeMember(shortId, m.user_id).catch(() => {})
    await synced()
  }

  const loadDomains = () =>
    api
      .listDomains(shortId)
      .then((r) => {
        setDomains(r.domains)
        setDomainBase(r.base)
      })
      .catch(() => {})
  const claimDomain = async (e: React.FormEvent) => {
    e.preventDefault()
    const l = label.trim().toLowerCase()
    if (!l) return
    setClaiming(true)
    try {
      await api.setDomain(shortId, l)
      setLabel("")
      await loadDomains()
      toast.success("Custom URL claimed")
    } catch (x) {
      toast.error(x instanceof Error ? x.message : "Couldn't claim that URL")
    } finally {
      setClaiming(false)
    }
  }
  const dropDomain = async (host: string) => {
    await api.removeDomain(shortId, host).catch(() => {})
    await loadDomains()
  }
  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success("URL copied")
    } catch {
      toast.error("Couldn't copy to clipboard")
    }
  }

  return (
    <Dialog
      onOpenChange={(o) => {
        if (o) {
          setErr(null)
          setVis(visibility)
          setPw("")
          load()
          loadDomains()
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
            {canManage ? (
              <>
                Add people by email. Everyone you don't list is a{" "}
                <b className="text-foreground">{defaultRole}</b> by default.
              </>
            ) : (
              "You can view this artifact but can't change who has access."
            )}
          </DialogDescription>
        </DialogHeader>

        {canManage ? (
          <>
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
          </>
        ) : (
          <div
            data-testid="share-viewonly"
            className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          >
            <Lock className="size-3.5 shrink-0" />
            View only · ask an owner or editor to change access.
          </div>
        )}
        {err && (
          <p data-testid="share-error" role="alert" className="mt-2 text-xs text-destructive">
            {err}
          </p>
        )}

        <div className="mt-3.5">
          <div className="mb-1.5 font-mono text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            People with access
          </div>
          {members.length === 0 ? (
            <div data-testid="share-empty">
              <EmptyState className="p-6 text-xs">
                {canManage ? "No one shared yet." : "Just you and the workspace."}
              </EmptyState>
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
                  {canManage ? (
                    <>
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
                    </>
                  ) : (
                    <span
                      data-testid={`share-member-role-${m.user_id}`}
                      className="text-xs text-muted-foreground"
                    >
                      {ROLE_LABEL[m.role]}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* General access (visibility) — the "anyone with the link" control. */}
        <div className="mt-4 border-t border-border pt-3.5">
          <div className="mb-1.5 font-mono text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            General access
          </div>
          {canManage ? (
            <>
              <div className="flex gap-1.5">
                <select
                  aria-label="General access"
                  data-testid="share-visibility"
                  value={vis}
                  onChange={(e) => setVis(e.target.value)}
                  className="flex-1 rounded-md border border-input bg-card px-2 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {ACCESS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <Button
                  data-testid="share-visibility-save"
                  variant="primary"
                  disabled={savingVis || needsPw || visUnchanged}
                  onClick={saveVisibility}
                >
                  {savingVis ? "…" : "Update"}
                </Button>
              </div>
              {vis === "password" && (
                <Input
                  type="password"
                  data-testid="share-visibility-password"
                  placeholder={
                    visibility === "password"
                      ? "New password (leave blank to keep)"
                      : "Set a password"
                  }
                  aria-label="Password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  className="mt-1.5"
                />
              )}
              <p className="mt-1.5 font-mono text-2xs text-muted-foreground">
                {ACCESS.find((a) => a.value === vis)?.blurb}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {ACCESS.find((a) => a.value === visibility)?.label ?? visibility}
            </p>
          )}
        </div>

        {/* Embed — drop the artifact into any page. Shows for anyone who can open
            the link, so it needs link- or world-readable access. */}
        <div className="mt-4 border-t border-border pt-3.5">
          <div className="mb-1.5 font-mono text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Embed
          </div>
          <div className="flex gap-1.5">
            <Input
              readOnly
              data-testid="share-embed-snippet"
              aria-label="Embed code"
              value={embedSnippet}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 font-mono text-2xs"
            />
            <Button data-testid="share-embed-copy" variant="primary" onClick={copyEmbed}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-1.5 font-mono text-2xs text-muted-foreground">
            {linkAccessible
              ? "Paste into any page — Notion, a blog, docs. Live, with a link back to Dock."
              : "Set access to “Anyone with the link” or “Public” for the embed to load for others."}
          </p>
        </div>

        {/* Custom URL — a vanity subdomain that serves the artifact at its own
            origin. Only shown when the server has a base domain configured. */}
        {domainBase && (
          <div className="mt-4 border-t border-border pt-3.5">
            <div className="mb-1.5 font-mono text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Custom URL
            </div>
            {domains.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {domains.map((d) => (
                  <div key={d.host} className="flex items-center gap-1.5">
                    <Input
                      readOnly
                      data-testid="share-domain-url"
                      aria-label="Custom URL"
                      value={d.url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 font-mono text-2xs"
                    />
                    <Button
                      variant="outline"
                      data-testid="share-domain-copy"
                      onClick={() => copyUrl(d.url)}
                    >
                      Copy
                    </Button>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid="share-domain-remove"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        onClick={() => dropDomain(d.host)}
                        aria-label="Remove custom URL"
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : canManage ? (
              <form onSubmit={claimDomain} className="flex items-center gap-1.5">
                <Input
                  data-testid="share-domain-label"
                  aria-label="Subdomain label"
                  placeholder="my-page"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="flex-1"
                />
                <span className="whitespace-nowrap font-mono text-2xs text-muted-foreground">
                  .{domainBase}
                </span>
                <Button
                  data-testid="share-domain-claim"
                  variant="primary"
                  type="submit"
                  disabled={claiming || !label.trim()}
                >
                  {claiming ? "…" : "Claim"}
                </Button>
              </form>
            ) : (
              <p className="text-xs text-muted-foreground">No custom URL.</p>
            )}
            <p className="mt-1.5 font-mono text-2xs text-muted-foreground">
              A clean URL on {domainBase}, served at its own origin. Works for link- or
              world-readable artifacts.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
