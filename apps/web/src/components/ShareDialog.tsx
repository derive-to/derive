import { useQueryClient } from "@tanstack/react-query"
import { Lock, Share2, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  API_BASE,
  type ArtifactDomain,
  type ArtifactMember,
  api,
  type GeneralRole,
  type PublicProfile,
  type Role,
} from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { RoleSelect } from "@/components/shared/role-select"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"

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
  generalRole,
}: {
  shortId: string
  myRole?: Role | null
  visibility: string
  generalRole?: GeneralRole
}) {
  const qc = useQueryClient()
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // GitHub-style handle typeahead for the add-person field. Suggestions come from
  // the discoverable-people search (handle/name, never email); a non-discoverable
  // user is still addable by typing their exact @handle/email and clicking Add.
  const [suggest, setSuggest] = useState<PublicProfile[]>([])
  const [active, setActive] = useState(-1)
  // The value we just picked, so the follow-up search for it doesn't reopen the menu.
  const picked = useRef("")
  // General access draft: visibility + the link's permission (view vs comment), plus a
  // password when enabling/changing password.
  const [vis, setVis] = useState(visibility)
  const [genRole, setGenRole] = useState<GeneralRole>(generalRole ?? "viewer")
  const [pw, setPw] = useState("")
  const [savingVis, setSavingVis] = useState(false)

  const [copied, setCopied] = useState(false)

  // Per-artifact vanity subdomains (`domainBase` null = off) + the workspace's
  // custom domains shown read-only (managed in Settings).
  const [domains, setDomains] = useState<ArtifactDomain[]>([])
  const [domainBase, setDomainBase] = useState<string | null>(null)
  const [workspaceDomains, setWorkspaceDomains] = useState<{ host: string; url: string }[]>([])
  const [label, setLabel] = useState("")
  const [claiming, setClaiming] = useState(false)

  // GDocs model: owners and editors manage access; everyone else gets view-only.
  const canManage = myRole === "owner" || myRole === "editor"

  // Embed snippet: an iframe of the embeddable view. Same-origin by default; the
  // split-deploy SPA points at the API origin via API_BASE. The embed only shows
  // for others when the artifact is link- or world-readable.
  const origin = API_BASE || (typeof window === "undefined" ? "" : window.location.origin)
  const embedSnippet = `<iframe src="${origin}/v1/embed/${shortId}" width="100%" height="480" style="border:0;border-radius:12px" loading="lazy" title="Derive artifact" allowfullscreen></iframe>`
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

  // Reach visibilities (anyone with the link / public / password) carry a general-access
  // permission; "workspace only" does not, so the view/comment control hides for it.
  const reach = vis === "link" || vis === "public" || vis === "password"
  const saveVisibility = async () => {
    setSavingVis(true)
    setErr(null)
    try {
      await api.setVisibility(shortId, vis, genRole, vis === "password" && pw ? pw : undefined)
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
  const visUnchanged = vis === visibility && genRole === (generalRole ?? "viewer") && !pw

  const load = () =>
    api
      .listMembers(shortId)
      .then((r) => {
        setMembers(r.members)
      })
      .catch(() => {})
  // After a share change, refresh the local list AND the shared cache: the artifact
  // query holds `my_role` (drives the toolbar), and the library reflects access.
  const synced = async () => {
    await load()
    qc.invalidateQueries({ queryKey: ["artifact", shortId] })
    qc.invalidateQueries({ queryKey: ["artifacts"] })
  }

  // Debounced people-search for the add field. Skip when empty or when the term is
  // exactly what we just picked (so a pick doesn't immediately reopen the menu).
  useEffect(() => {
    const term = email.trim()
    if (!term || term === picked.current) {
      setSuggest([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      api
        .searchPeople(term)
        .then((r) => {
          if (alive) {
            setSuggest(r.users)
            setActive(-1)
          }
        })
        .catch(() => alive && setSuggest([]))
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [email])

  const pick = (u: PublicProfile) => {
    picked.current = `@${u.username}`
    setEmail(`@${u.username}`)
    setSuggest([])
    setActive(-1)
  }
  // ↑/↓ to move, Enter to pick the highlighted suggestion, Esc to close the menu.
  // With no highlight, Enter falls through to the form submit (free-text add).
  const onAddKeyDown = (e: React.KeyboardEvent) => {
    if (suggest.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, suggest.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, -1))
    } else if (e.key === "Enter" && active >= 0 && suggest[active]) {
      e.preventDefault()
      pick(suggest[active])
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      setSuggest([])
    }
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
      picked.current = ""
      setSuggest([])
      await synced()
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Could not share")
    } finally {
      setBusy(false)
    }
  }
  const change = async (m: ArtifactMember, next: Role) => {
    if (next === m.role || !m.handle) return
    // Surface a failed role change instead of swallowing it (transient-failure
    // recovery), now keyed on the handle-based identity.
    try {
      await api.setMember(shortId, m.handle, next)
    } catch (x) {
      toast.error(x instanceof Error ? x.message : "Couldn't update access")
    }
    await synced()
  }
  const remove = async (m: ArtifactMember) => {
    try {
      await api.removeMember(shortId, m.user_id)
    } catch (x) {
      toast.error(x instanceof Error ? x.message : "Couldn't remove member")
    }
    await synced()
  }

  const loadDomains = () =>
    api
      .listDomains(shortId)
      .then((r) => {
        setDomains(r.domains)
        setDomainBase(r.base)
        setWorkspaceDomains(r.workspace_domains)
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
        <Button data-testid="share-trigger" variant="outline" size="sm" title="Share this artifact">
          <Share2 />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share this artifact</DialogTitle>
          <DialogDescription>
            {canManage
              ? "Choose who can open it, and how to share it."
              : "You can view this artifact but can't change who has access."}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="people" className="mt-1">
          <TabsList variant="line" className="w-full justify-start px-0">
            <TabsTrigger value="people" data-testid="share-tab-people" className="flex-none">
              People
            </TabsTrigger>
            <TabsTrigger value="links" data-testid="share-tab-links" className="flex-none">
              Links
            </TabsTrigger>
          </TabsList>

          {/* ---- People: who can access + general access ---- */}
          <TabsContent value="people">
            {canManage ? (
              <>
                <form onSubmit={add} className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <Input
                      data-testid="share-email"
                      type="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      autoComplete="off"
                      placeholder="@username or email"
                      aria-label="Username or email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={onAddKeyDown}
                      className="w-full"
                    />
                    {suggest.length > 0 && (
                      <div
                        data-testid="share-suggest"
                        className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-56 overflow-y-auto rounded-xl bg-popover p-1 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10"
                      >
                        {suggest.map((u, i) => (
                          <button
                            key={u.username}
                            type="button"
                            data-testid="share-suggest-item"
                            // Keep the input focused so the click registers without blurring first.
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pick(u)}
                            onMouseEnter={() => setActive(i)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                              i === active ? "bg-accent" : "hover:bg-accent",
                            )}
                          >
                            <Avatar className="size-6">
                              {u.image && <AvatarImage src={u.image} alt={u.name ?? u.username} />}
                              <AvatarFallback>{getInitials(u.name ?? u.username)}</AvatarFallback>
                            </Avatar>
                            <span className="min-w-0 flex-1">
                              {u.name && (
                                <span className="block truncate text-sm font-medium text-foreground">
                                  {u.name}
                                </span>
                              )}
                              <span className="block truncate font-mono text-2xs text-muted-foreground">
                                @{u.username}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div data-testid="share-role" className="w-[104px]">
                    <RoleSelect
                      value={role}
                      onChange={setRole}
                      aria-label="Role for new member"
                      className="w-full"
                    />
                  </div>
                  <Button
                    data-testid="share-add"
                    variant="default"
                    size="sm"
                    type="submit"
                    disabled={busy}
                  >
                    {busy ? "…" : "Add"}
                  </Button>
                </form>
                <p className="mt-1.5 text-xs text-muted-foreground">{BLURB[role]}.</p>
              </>
            ) : (
              <div
                data-testid="share-viewonly"
                className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground"
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
              <div className="mb-1.5 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                People with access
              </div>
              {members.length === 0 ? (
                <div data-testid="share-empty">
                  <EmptyState className="p-6 text-xs">
                    {canManage ? "No one shared yet." : "Just you and the workspace."}
                  </EmptyState>
                </div>
              ) : (
                <div className="-mx-2 flex flex-col">
                  {members.map((m) => (
                    <div
                      key={m.user_id}
                      data-testid={`share-member-row-${m.user_id}`}
                      className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-hover"
                    >
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
                          <div data-testid={`share-member-role-${m.user_id}`} className="w-[92px]">
                            <RoleSelect
                              value={m.role}
                              onChange={(next) => change(m, next)}
                              aria-label={`Role for ${m.name ?? (m.handle ? `@${m.handle}` : "member")}`}
                              className="w-full"
                            />
                          </div>
                          <Button
                            data-testid={`share-member-remove-${m.user_id}`}
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => remove(m)}
                            aria-label={`Remove ${m.name ?? (m.handle ? `@${m.handle}` : "member")}`}
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
              <div className="mb-1.5 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                General access
              </div>
              {canManage ? (
                <>
                  <div className="flex gap-1.5">
                    <Select value={vis} onValueChange={setVis}>
                      <SelectTrigger
                        aria-label="General access"
                        data-testid="share-visibility"
                        className="flex-1"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACCESS.map((a) => (
                          <SelectItem key={a.value} value={a.value}>
                            {a.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {reach && (
                      <Select value={genRole} onValueChange={(v) => setGenRole(v as GeneralRole)}>
                        <SelectTrigger
                          aria-label="Link permission"
                          data-testid="share-general-role"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="viewer">Can view</SelectItem>
                          <SelectItem value="commenter">Can comment</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    <Button
                      data-testid="share-visibility-save"
                      variant="secondary"
                      size="sm"
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
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {ACCESS.find((a) => a.value === vis)?.blurb}
                    {reach && genRole === "commenter" && " Signed-in visitors can comment."}
                  </p>
                </>
              ) : (
                <Badge variant={linkAccessible ? "brand" : "default"}>
                  {ACCESS.find((a) => a.value === visibility)?.label ?? visibility}
                </Badge>
              )}
            </div>
          </TabsContent>

          {/* ---- Links: embed + custom URL ---- */}
          <TabsContent value="links">
            {/* Embed — drop the artifact into any page. Shows for anyone who can open
                the link, so it needs link- or world-readable access. */}
            <div>
              <div className="mb-1.5 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                Embed
              </div>
              <div className="flex gap-1.5">
                <Input
                  readOnly
                  data-testid="share-embed-snippet"
                  aria-label="Embed code"
                  value={embedSnippet}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 bg-secondary font-mono text-xs dark:bg-secondary sm:text-xs"
                />
                <Button
                  data-testid="share-embed-copy"
                  variant="default"
                  size="sm"
                  onClick={copyEmbed}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {linkAccessible
                  ? "Paste into any page — Notion, a blog, docs. Live, with a link back to Derive."
                  : "Set access to “Anyone with the link” or “Public” for the embed to load for others."}
              </p>
            </div>

            {/* Custom URL — a vanity subdomain that serves the artifact at its own
            origin. Only shown when the server has a base domain configured. */}
            {domainBase && (
              <div className="mt-4 border-t border-border pt-3.5">
                <div className="mb-1.5 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
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
                          className="flex-1 font-mono text-2xs sm:text-2xs"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="share-domain-copy"
                          onClick={() => copyUrl(d.url)}
                        >
                          Copy
                        </Button>
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            data-testid="share-domain-remove"
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
                      variant="secondary"
                      size="sm"
                      type="submit"
                      disabled={claiming || !label.trim()}
                    >
                      {claiming ? "…" : "Claim"}
                    </Button>
                  </form>
                ) : (
                  <p className="text-xs text-muted-foreground">No custom URL.</p>
                )}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  A clean URL on {domainBase}, served at its own origin. Works for link- or
                  world-readable artifacts.
                </p>
              </div>
            )}

            {/* Also at — this artifact's URL on each of the workspace's custom
                domains (managed in workspace settings, shown read-only here). */}
            {workspaceDomains.length > 0 && (
              <div className="mt-4 border-t border-border pt-3.5">
                <div className="mb-1.5 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                  Also at
                </div>
                <div className="flex flex-col gap-1.5">
                  {workspaceDomains.map((d) => (
                    <div key={d.host} className="flex items-center gap-1.5">
                      <Input
                        readOnly
                        data-testid="share-workspace-domain"
                        aria-label={`URL on ${d.host}`}
                        value={d.url}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 font-mono text-2xs sm:text-2xs"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="share-workspace-domain-copy"
                        onClick={() => copyUrl(d.url)}
                      >
                        Copy
                      </Button>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  On your workspace's custom domain. Manage domains in workspace settings.
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
