import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import {
  API_BASE,
  type ArtifactDomain,
  type ArtifactMember,
  api,
  type LinkAudience,
  type LinkRole,
  type PublicProfile,
  type Role,
} from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { ROLE_LABELS, RoleSelect } from "@/components/shared/role-select"
import { Eyebrow, SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuTrigger,
} from "@/components/ui/select-menu"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { getInitials } from "@/lib/initials"
import { artifactQuery, workspaceQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

// The LINK is the primary control (round 4, docs/plans/link-grant.md): who the
// URL works for (the audience) × what it grants (the role). "Only invited" is the
// audience select's spelling of link_role none — the link is inert and the roster
// below is the only way in. A password is a LOCK on a public listing's link (the
// checkbox under the listing ladder), not an audience.
const LINK_AUDIENCES: { value: string; label: string; icon: IconName }[] = [
  { value: "invited", label: "Only invited", icon: "lock" },
  { value: "org", label: "Workspace", icon: "workspace" },
  { value: "public", label: "Anyone", icon: "globe" },
]
const LINK_ROLE_LABELS: Record<Exclude<LinkRole, "none">, string> = {
  viewer: "Can view",
  commenter: "Can comment",
  editor: "Can edit",
}
const linkBlurb = (audience: string, role: LinkRole): string => {
  if (audience === "invited" || role === "none")
    return "The link is inert: only people added below can open it."
  const who = audience === "org" ? "Anyone in this workspace with the link" : "Anyone with the link"
  if (role === "viewer") return `${who} can view.`
  const what = role === "editor" ? "edit" : "comment"
  return audience === "org"
    ? `${who} can view and ${what}.`
    : `${who} can view; signed-in visitors can ${what}.`
}

// Where it's listed — the secondary control. Discoverability only: the link above
// decides who can OPEN it.
const LISTING: { value: string; label: string; blurb: string; icon: IconName }[] = [
  {
    value: "private",
    label: "Not listed",
    blurb: "In no feeds or libraries. The link above decides who can open it.",
    icon: "lock",
  },
  {
    value: "org",
    label: "Workspace library",
    blurb: "Every workspace member can find it in the shared library.",
    icon: "workspace",
  },
  {
    value: "public",
    label: "Public",
    blurb: "Listed publicly. The link works for anyone.",
    icon: "globe",
  },
]

// The state glyph the Share trigger carries so exposure is legible without
// opening the dialog: a globe when the URL alone reads for the world, a lock
// when the link is inert (invite-only), the plain share glyph for
// workspace-scoped reach.
const visibilityIcon = (visibility: string, role?: LinkRole, audience?: LinkAudience): IconName =>
  visibility === "public" || (audience === "public" && role && role !== "none")
    ? "globe"
    : !role || role === "none"
      ? "lock"
      : "share"

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
  linkRole,
  linkAudience,
  passwordProtected = false,
}: {
  shortId: string
  myRole?: Role | null
  visibility: string
  /** The link grant pair (round 4): what the URL confers × who it works for. */
  linkRole?: LinkRole
  linkAudience?: LinkAudience
  /** The public link carries a password (the lock). */
  passwordProtected?: boolean
}) {
  const qc = useQueryClient()
  const { me } = useAuth()
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
  // Access draft: the listing (visibility) + the link grant pair, plus the lock
  // (password) state for a public listing's link.
  const [vis, setVis] = useState(visibility)
  const [lRole, setLRole] = useState<LinkRole>(linkRole ?? "none")
  const [lAudience, setLAudience] = useState<LinkAudience>(linkAudience ?? "org")
  const [pw, setPw] = useState("")
  const [savingVis, setSavingVis] = useState(false)
  // The lock as the server knows it, kept locally current as we set/clear it.
  const [hasLock, setHasLock] = useState(passwordProtected)
  // The checkbox is checked before a password exists (the input is showing) —
  // nothing applies until Set password.
  const [lockDraft, setLockDraft] = useState(false)

  const [copied, setCopied] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  // Embed + domains live behind one quiet disclosure — access is the dialog's
  // job; distribution mechanics shouldn't compete with it.
  const [more, setMore] = useState(false)
  // Changing the password on an already-locked artifact is rare: hidden
  // behind a ghost reveal instead of a permanently visible input.
  const [pwOpen, setPwOpen] = useState(false)

  // Per-artifact vanity subdomains (`domainBase` null = off) + the workspace's
  // custom domains shown read-only (managed in Settings).
  const [domains, setDomains] = useState<ArtifactDomain[]>([])
  const [domainBase, setDomainBase] = useState<string | null>(null)
  const [workspaceDomains, setWorkspaceDomains] = useState<{ host: string; url: string }[]>([])
  const [label, setLabel] = useState("")
  const [claiming, setClaiming] = useState(false)

  // GDocs model: owners and editors manage access; everyone else gets view-only.
  const canManage = myRole === "owner" || myRole === "editor"

  // The canonical share URL — the server-built artifact URL when the detail is
  // cached (it is, on the artifact page), else reconstructed from the short id.
  const { data: art } = useQuery({ ...artifactQuery(shortId), enabled: false })
  const shareUrl =
    art?.url ??
    `${typeof window === "undefined" ? "" : window.location.origin}/artifacts/${shortId}`

  // Embed snippet: an iframe of the embeddable view. Same-origin by default; the
  // split-deploy SPA points at the API origin via API_BASE. The embed only shows
  // for others when the artifact is link- or world-readable.
  const origin = API_BASE || (typeof window === "undefined" ? "" : window.location.origin)
  const embedSnippet = `<iframe src="${origin}/v1/embed/${shortId}" width="100%" height="480" style="border:0;border-radius:12px" loading="lazy" title="Derive artifact" allowfullscreen></iframe>`
  // An embed loads for strangers only when the URL alone reads for the world:
  // a public listing, or a public-audience link on any listing.
  const linkAccessible =
    visibility === "public" ||
    ((linkAudience ?? "org") === "public" && (linkRole ?? "none") !== "none")
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

  // The listing-ladder entry for the draft pick (editable) and the server's own
  // value (view-only render) — looked up once and reused.
  const currentListing = LISTING.find((a) => a.value === vis)
  const visibilityListing = LISTING.find((a) => a.value === visibility)
  const nav = useNavigate()
  // Solo drives only the create-a-workspace hint, never the controls — the
  // Workspace audience stays meaningful for a workspace of one. Managers only,
  // and not-solo while the roster loads, so nothing flashes.
  const { data: workspace } = useQuery({ ...workspaceQuery(), enabled: canManage })
  const solo = workspace ? workspace.members.length <= 1 : false
  // The audience select's value: "invited" is its spelling of an inert link.
  const audienceValue = lRole === "none" ? "invited" : lAudience
  // A public LISTING forces a world link (the coherence rule): the audience
  // select pins to Anyone and the role select floors at viewer.
  const publicListed = vis === "public"
  // Everything applies the moment it's picked — a Save button between a select
  // and its effect is friction with no safety benefit (the change is one more
  // select away from undone). The lock is the one exception: checking the box
  // reveals the input, and nothing applies until Set password.
  const applyVisibility = async (
    nextVis: string,
    nextRole: LinkRole,
    nextAudience: LinkAudience,
    password?: string,
  ) => {
    setSavingVis(true)
    setErr(null)
    try {
      const r = await api.setVisibility(shortId, nextVis, nextRole, nextAudience, password)
      // Mirror the server's resolution (going public coerces the pair to a
      // coherent state — see the route), not just the local intent.
      setLRole(r.link_role)
      setLAudience(r.link_audience)
      setHasLock(!!r.locked)
      setLockDraft(false)
      setPw("")
      setPwOpen(false)
      // Refresh the artifact (drives the toolbar glyph) and the library.
      qc.invalidateQueries({ queryKey: artifactQuery(shortId).queryKey })
      qc.invalidateQueries({ queryKey: ["artifacts"] })
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Couldn't update access")
      // The selects reflect the server again, not the failed intent.
      setVis(visibility)
      setLRole(linkRole ?? "none")
      setLAudience(linkAudience ?? "org")
    } finally {
      setSavingVis(false)
    }
  }
  const pickVisibility = (v: string) => {
    setVis(v)
    setLockDraft(false)
    // Leaving public clears the lock server-side; mirror that locally so
    // returning to public starts unlocked. Going public: the server coerces the
    // link to public · ≥viewer; send the current pair and mirror its answer.
    if (v !== "public") setHasLock(false)
    void applyVisibility(v, lRole, lAudience)
  }
  // The audience pick: "invited" means an inert link (role none, audience kept);
  // picking a real audience with an inert role turns the link on at the product
  // default capability (comment — Derive is a review loop).
  const pickAudience = (a: string) => {
    const nextAudience: LinkAudience = a === "public" ? "public" : "org"
    const nextRole: LinkRole = a === "invited" ? "none" : lRole === "none" ? "commenter" : lRole
    setLAudience(nextAudience)
    setLRole(nextRole)
    void applyVisibility(vis, nextRole, nextAudience)
  }
  const pickLinkRole = (r: LinkRole) => {
    setLRole(r)
    void applyVisibility(vis, r, lAudience)
  }
  // The lock checkbox: checking reveals the password input (applies on Set);
  // unchecking clears the lock immediately (an explicit empty password).
  const toggleLock = (on: boolean) => {
    if (on) setLockDraft(true)
    else if (hasLock) void applyVisibility("public", lRole, lAudience, "")
    else setLockDraft(false)
  }
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopiedLink(true)
      window.setTimeout(() => setCopiedLink(false), 1500)
    } catch {
      toast.error("Couldn't copy to clipboard")
    }
  }

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
    qc.invalidateQueries({ queryKey: artifactQuery(shortId).queryKey })
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
          setLRole(linkRole ?? "none")
          setLAudience(linkAudience ?? "org")
          setPw("")
          setPwOpen(false)
          // Re-seed the lock from the server's state and drop any half-typed
          // draft — an abandoned checkbox must not survive a close/reopen.
          setHasLock(passwordProtected)
          setLockDraft(false)
          setMore(false)
          load()
          loadDomains()
        }
      }}
    >
      <DialogTrigger asChild>
        {/* The artifact page's ONE filled-ink primary — the toolbar's single focal
            point (design-system.md: one filled primary per page; ink is where the
            eye lands). Everything else in the bar is ghost. The glyph carries the
            exposure state: globe = the URL alone reads, lock = invite-only. */}
        <Button data-testid="share-trigger" variant="default" size="sm">
          <Icon name={visibilityIcon(visibility, linkRole, linkAudience)} />
          Share
        </Button>
      </DialogTrigger>
      {/* One surface: general access → who has access → add more, with a
          copy-link footer. The order reads top-down as one flow — the
          coarse-grained setting first, then the roster it governs, then the
          way to extend it. Embed + domains fold behind a disclosure — the
          dialog's job is access, and everything applies as it's chosen (no Save). */}
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="line-clamp-1 pr-6">
            {art?.title ? `Share “${art.title}”` : "Share"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          {/* The LINK — the primary control. Who the URL works for × what it
              grants; the listing ladder below only governs discoverability. */}
          <div>
            <SectionEyebrow action={savingVis && <Spinner className="size-3" />}>
              Link access
            </SectionEyebrow>
            {canManage ? (
              <div className="mt-2 flex flex-col gap-2 rounded-lg bg-secondary p-3">
                <div className="flex gap-1.5">
                  <SelectMenu
                    value={publicListed ? "public" : audienceValue}
                    onValueChange={pickAudience}
                  >
                    <SelectMenuTrigger
                      aria-label="Who the link works for"
                      data-testid="share-link-audience"
                      disabled={savingVis || publicListed}
                      className="flex-1 bg-card"
                    >
                      <Icon
                        name={
                          LINK_AUDIENCES.find(
                            (a) => a.value === (publicListed ? "public" : audienceValue),
                          )?.icon ?? "share"
                        }
                        className="text-muted-foreground"
                      />
                      {LINK_AUDIENCES.find(
                        (a) => a.value === (publicListed ? "public" : audienceValue),
                      )?.label ?? audienceValue}
                    </SelectMenuTrigger>
                    <SelectMenuContent>
                      {LINK_AUDIENCES.map((a) => (
                        <SelectMenuItem key={a.value} value={a.value}>
                          <Icon name={a.icon} className="text-muted-foreground" />
                          {a.label}
                        </SelectMenuItem>
                      ))}
                    </SelectMenuContent>
                  </SelectMenu>
                  {audienceValue !== "invited" && (
                    <SelectMenu value={lRole} onValueChange={(v) => pickLinkRole(v as LinkRole)}>
                      <SelectMenuTrigger
                        aria-label="What the link grants"
                        data-testid="share-link-role"
                        disabled={savingVis}
                        className="bg-card"
                      >
                        {lRole === "none" ? "Can view" : LINK_ROLE_LABELS[lRole]}
                      </SelectMenuTrigger>
                      <SelectMenuContent>
                        <SelectMenuItem value="viewer">Can view</SelectMenuItem>
                        <SelectMenuItem value="commenter">Can comment</SelectMenuItem>
                        <SelectMenuItem value="editor">Can edit</SelectMenuItem>
                      </SelectMenuContent>
                    </SelectMenu>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {linkBlurb(publicListed ? "public" : audienceValue, lRole)}
                  {audienceValue === "public" &&
                    !publicListed &&
                    " It stays out of every feed and library."}
                </p>
                {/* First-need on-ramp: the word "workspace" earns its first
                    appearance by answering "how do I show this to my team?". */}
                {solo && (
                  <p className="text-sm text-muted-foreground">
                    Working with a team?{" "}
                    <Button
                      variant="link"
                      size="xs"
                      data-testid="share-create-workspace"
                      className="px-0"
                      onClick={() =>
                        nav({
                          to: "/settings/$section",
                          params: { section: "general" },
                          search: { "new-workspace": "1" },
                        })
                      }
                    >
                      Create a workspace
                    </Button>{" "}
                    to share with them.
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Icon name={visibilityIcon(visibility, linkRole, linkAudience)} />
                {linkBlurb(
                  visibility === "public"
                    ? "public"
                    : (linkRole ?? "none") === "none"
                      ? "invited"
                      : (linkAudience ?? "org"),
                  linkRole ?? "none",
                )}
              </p>
            )}
          </div>

          {/* Where it's listed — discoverability only. */}
          <div>
            <SectionEyebrow>Where it's listed</SectionEyebrow>
            {canManage ? (
              <div className="mt-2 flex flex-col gap-2 rounded-lg bg-secondary p-3">
                <SelectMenu value={vis} onValueChange={pickVisibility}>
                  <SelectMenuTrigger
                    aria-label="Where it's listed"
                    data-testid="share-visibility"
                    disabled={savingVis}
                    className="flex-1 bg-card"
                  >
                    <Icon
                      name={currentListing?.icon ?? "share"}
                      className="text-muted-foreground"
                    />
                    {currentListing?.label ?? vis}
                  </SelectMenuTrigger>
                  <SelectMenuContent>
                    {LISTING.map((a) => (
                      <SelectMenuItem key={a.value} value={a.value}>
                        <Icon name={a.icon} className="text-muted-foreground" />
                        {a.label}
                      </SelectMenuItem>
                    ))}
                  </SelectMenuContent>
                </SelectMenu>
                {/* The lock — a modifier on a public listing's link, not an audience.
                    Members and people added below never need the password. */}
                {vis === "public" && (
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={hasLock || lockDraft}
                      disabled={savingVis}
                      aria-label="Require a password"
                      data-testid="share-lock-toggle"
                      onCheckedChange={(v) => toggleLock(v === true)}
                    />
                    Require a password
                  </label>
                )}
                {vis === "public" && (lockDraft || (hasLock && pwOpen)) && (
                  <div className="flex gap-1.5">
                    <Input
                      type="password"
                      data-testid="share-visibility-password"
                      placeholder={hasLock ? "New password" : "Set a password"}
                      aria-label="Password"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && pw)
                          void applyVisibility("public", lRole, lAudience, pw)
                      }}
                      className="flex-1"
                    />
                    <Button
                      data-testid="share-visibility-save"
                      variant="secondary"
                      size="sm"
                      disabled={!pw}
                      loading={savingVis}
                      onClick={() => void applyVisibility("public", lRole, lAudience, pw)}
                    >
                      {savingVis ? "Setting…" : "Set password"}
                    </Button>
                  </div>
                )}
                <p className="text-sm text-muted-foreground">
                  {lockDraft && !hasLock
                    ? "The lock applies once a password is set."
                    : (currentListing?.blurb ?? "")}
                  {!lockDraft && vis === "public" && hasLock && !pwOpen && (
                    <Button
                      variant="link"
                      size="xs"
                      data-testid="share-password-change"
                      className="ml-1 px-0"
                      onClick={() => setPwOpen(true)}
                    >
                      Change password
                    </Button>
                  )}
                </p>
              </div>
            ) : (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Icon name={visibilityListing?.icon ?? "share"} />
                {visibilityListing?.label ?? visibility}
              </p>
            )}
          </div>

          <div>
            <SectionEyebrow count={members.length || undefined}>People with access</SectionEyebrow>
            {members.length === 0 ? (
              <p data-testid="share-empty" className="px-2 py-2.5 text-sm text-muted-foreground">
                {canManage ? "No one shared yet." : "No one else has been added."}
              </p>
            ) : (
              <div className="-mx-2 mt-1 flex flex-col">
                {members.map((m) => (
                  <div
                    key={m.user_id}
                    data-testid={`share-member-row-${m.user_id}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-secondary"
                  >
                    <Avatar className="size-8 shrink-0">
                      <AvatarFallback className="text-xs">
                        {getInitials(m.name ?? m.handle ?? "?")}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {m.name ?? (m.handle ? `@${m.handle}` : m.user_id)}
                        {m.user_id === me?.id && (
                          <span className="text-muted-foreground"> (you)</span>
                        )}
                      </div>
                      {m.name && m.handle && (
                        <div className="truncate font-mono text-2xs text-muted-foreground">
                          @{m.handle}
                        </div>
                      )}
                    </div>
                    {/* The sole owner's row is fixed — the server refuses to downgrade
                      or remove the last owner, so don't offer it. */}
                    {canManage &&
                    !(
                      m.role === "owner" && members.filter((x) => x.role === "owner").length === 1
                    ) ? (
                      <>
                        <div
                          data-testid={`share-member-role-${m.user_id}`}
                          className="w-25 shrink-0"
                        >
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
                          <Icon name="close" />
                        </Button>
                      </>
                    ) : (
                      <span
                        data-testid={`share-member-role-${m.user_id}`}
                        className="shrink-0 text-sm text-muted-foreground"
                      >
                        {ROLE_LABELS[m.role]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Adding people is the natural next step after seeing who already has
                access — the roster reads top-to-bottom as one flow: who's in, then
                bring in more. */}
            <div className="mt-3 flex flex-col gap-2">
              {canManage ? (
                <form onSubmit={add} className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    {/* WAI-APG combobox wiring: the input announces the popup and the
                    arrow-key highlight (aria-activedescendant). */}
                    <Input
                      data-testid="share-email"
                      type="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      autoComplete="off"
                      placeholder="Add people by @username or email…"
                      aria-label="Username or email"
                      role="combobox"
                      aria-expanded={suggest.length > 0}
                      aria-autocomplete="list"
                      aria-controls="share-suggest-list"
                      aria-activedescendant={
                        active >= 0 && suggest[active] ? `share-suggest-opt-${active}` : undefined
                      }
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={onAddKeyDown}
                      className="w-full"
                    />
                    {suggest.length > 0 && (
                      <div
                        data-testid="share-suggest"
                        id="share-suggest-list"
                        role="listbox"
                        aria-label="People suggestions"
                        className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-56 overflow-y-auto rounded-xl bg-popover p-1 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10"
                      >
                        {suggest.map((u, i) => (
                          <button
                            key={u.username}
                            type="button"
                            data-testid="share-suggest-item"
                            id={`share-suggest-opt-${i}`}
                            role="option"
                            aria-selected={i === active}
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
                  <div data-testid="share-role" className="w-28 shrink-0">
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
                    loading={busy}
                  >
                    {busy ? "Adding…" : "Add"}
                  </Button>
                </form>
              ) : (
                <div
                  data-testid="share-viewonly"
                  className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground"
                >
                  <Icon name="lock" />
                  View only · ask an owner or editor to change access.
                </div>
              )}
              {err && (
                <p data-testid="share-error" role="alert" className="text-sm text-destructive">
                  {err}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer: the universal action on the left, distribution mechanics folded
            behind a quiet disclosure on the right. */}
        <div className="flex items-center justify-between border-t border-border pt-4">
          <Button data-testid="share-url-copy" variant="outline" size="sm" onClick={copyLink}>
            <Icon name={copiedLink ? "check" : "link"} />
            {copiedLink ? "Copied" : "Copy link"}
          </Button>
          <Button
            data-testid="share-more-toggle"
            variant="ghost"
            size="sm"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
            className="text-muted-foreground"
          >
            Embed &amp; domains
            <Icon name={more ? "caret-up" : "caret"} />
          </Button>
        </div>

        {more && (
          <div className="flex flex-col gap-4">
            <div>
              <Eyebrow as="div" className="mb-1.5">
                Embed
              </Eyebrow>
              <div className="flex gap-1.5">
                <Input
                  readOnly
                  data-testid="share-embed-snippet"
                  aria-label="Embed code"
                  value={embedSnippet}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 bg-secondary font-mono"
                />
                <Button
                  data-testid="share-embed-copy"
                  variant="secondary"
                  size="sm"
                  onClick={copyEmbed}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {linkAccessible
                  ? "Paste into any page — live, with a link back to Derive."
                  : "Set the link to work for Anyone for the embed to load for others."}
              </p>
            </div>

            {domainBase && (
              <div>
                <Eyebrow as="div" className="mb-1.5">
                  Custom URL
                </Eyebrow>
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
                          className="flex-1 font-mono"
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
                            <Icon name="close" />
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
                      loading={claiming}
                      disabled={!label.trim()}
                    >
                      {claiming ? "Claiming…" : "Claim"}
                    </Button>
                  </form>
                ) : (
                  <p className="text-sm text-muted-foreground">No custom URL.</p>
                )}
              </div>
            )}

            {workspaceDomains.length > 0 && (
              <div>
                <Eyebrow as="div" className="mb-1.5">
                  Also at
                </Eyebrow>
                <div className="flex flex-col gap-1.5">
                  {workspaceDomains.map((d) => (
                    <div key={d.host} className="flex items-center gap-1.5">
                      <Input
                        readOnly
                        data-testid="share-workspace-domain"
                        aria-label={`URL on ${d.host}`}
                        value={d.url}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 font-mono"
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
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
