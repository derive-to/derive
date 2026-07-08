import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import {
  API_BASE,
  type ArtifactDomain,
  type ArtifactMember,
  api,
  type LinkRole,
  type Listed,
  type Role,
  type WorkspaceAccess,
} from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { AccessSegmentToggle } from "@/components/shared/access-segment-toggle"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { ROLE_LABELS, RoleSelect } from "@/components/shared/role-select"
import { Eyebrow, SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/ctx"
import { getInitials } from "@/lib/initials"
import { artifactQuery, workspaceQuery } from "@/lib/queries"

// Access is ONE primary question — who can open this — projected from the v2
// triple (workspace_access, link_role, listed; see access-model.md). Each segment
// is the WIDEST reach currently granted: a world link is "anyone"; workspace-seat
// access is "workspace"; neither is "invite". The world link's role and each
// segment's listing (does it show in a feed) are secondary switches beneath it.
type Segment = "invite" | "workspace" | "anyone"
const SEGMENTS: { value: Segment; label: string; icon: IconName }[] = [
  { value: "invite", label: "Invited", icon: "lock" },
  { value: "workspace", label: "Workspace", icon: "workspace" },
  { value: "anyone", label: "Anyone", icon: "globe" },
]

// The state glyph the Share trigger carries so exposure is legible without opening
// the dialog: a globe when the URL alone reads, the share glyph for the workspace,
// a lock for invite-only.
const accessIcon = (linkRole: LinkRole, workspaceAccess: WorkspaceAccess): IconName =>
  linkRole !== "none" ? "globe" : workspaceAccess === "member" ? "share" : "lock"

const LINK_ROLE_LABEL: Record<Exclude<LinkRole, "none">, string> = {
  viewer: "Can view",
  commenter: "Can comment",
  editor: "Can edit",
}
// The read-only one-liner for someone who can't manage access.
const accessSummary = (linkRole: LinkRole, workspaceAccess: WorkspaceAccess): string => {
  if (linkRole !== "none") {
    const what = linkRole === "viewer" ? "view" : linkRole === "editor" ? "edit" : "comment"
    return `Anyone with the link can ${what}.`
  }
  if (workspaceAccess === "member") return "Everyone in the workspace can open this."
  return "Only invited people can open this."
}

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
  workspaceAccess,
  linkRole,
  listed,
  passwordProtected = false,
}: {
  shortId: string
  myRole?: Role | null
  /** The v2 access triple (see access-model.md). */
  workspaceAccess?: WorkspaceAccess
  linkRole?: LinkRole
  listed?: Listed
  /** The world link carries a password (the lock). */
  passwordProtected?: boolean
}) {
  const qc = useQueryClient()
  const { me } = useAuth()
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Access draft: the three fields, plus the lock (password) state for the world link.
  const [wsAccess, setWsAccess] = useState<WorkspaceAccess>(workspaceAccess ?? "member")
  const [lRole, setLRole] = useState<LinkRole>(linkRole ?? "none")
  const [lst, setLst] = useState<Listed>(listed ?? "none")
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
  const linkAccessible = (linkRole ?? "none") !== "none"
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

  const nav = useNavigate()
  // Solo drives only the create-a-workspace hint, never the segment itself — the
  // Workspace segment stays meaningful for a workspace of one (it's what lists a
  // doc in your own library, and promoting an agent's private draft to Workspace
  // is the loop's blessing gesture). Managers only, and not-solo while the roster
  // loads, so nothing flashes.
  const { data: workspace } = useQuery({ ...workspaceQuery(), enabled: canManage })
  const solo = workspace ? workspace.members.length <= 1 : false

  // ── The one access question, projected from the (workspace_access, link_role,
  // listed) draft ──────────────────────────────────────────────────────────────
  // The segment is the WIDEST reach: a live world link is "anyone"; workspace-seat
  // access is "workspace"; neither is "invite".
  const segment: Segment =
    lRole !== "none" ? "anyone" : wsAccess === "member" ? "workspace" : "invite"
  // The listing switch per segment — public directory for "anyone", the workspace
  // library for "workspace". Invited lists nowhere.
  const isListed =
    segment === "anyone" ? lst === "public" : segment === "workspace" && lst === "workspace"
  // The world-link role shown on the "anyone" row (defaults to view before a link).
  const roleValue: Exclude<LinkRole, "none"> = lRole === "none" ? "viewer" : lRole
  // Everything applies the moment it's picked — a Save button between a select and
  // its effect is friction with no safety benefit. The lock is the one exception:
  // checking the box reveals the input, and nothing applies until Set password.
  const applyAccess = async (next: {
    workspaceAccess: WorkspaceAccess
    linkRole: LinkRole
    listed: Listed
    password?: string
  }) => {
    setSavingVis(true)
    setErr(null)
    // Optimistically mirror the intent so the controls don't flash the old state.
    setWsAccess(next.workspaceAccess)
    setLRole(next.linkRole)
    setLst(next.listed)
    if (next.linkRole === "none") {
      setHasLock(false)
      setLockDraft(false)
    }
    try {
      const r = await api.setAccess(shortId, next)
      setWsAccess(r.workspace_access)
      setLRole(r.link_role)
      setLst(r.listed)
      setHasLock(!!r.locked)
      setLockDraft(false)
      setPw("")
      setPwOpen(false)
      // Refresh the artifact (drives the toolbar glyph) and the library.
      qc.invalidateQueries({ queryKey: artifactQuery(shortId).queryKey })
      qc.invalidateQueries({ queryKey: ["artifacts"] })
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Couldn't update access")
      // The controls reflect the server again, not the failed intent.
      setWsAccess(workspaceAccess ?? "member")
      setLRole(linkRole ?? "none")
      setLst(listed ?? "none")
    } finally {
      setSavingVis(false)
    }
  }
  // Picking a segment sets its fields at the safe default: a fresh segment starts
  // UNLISTED (the switch is how you opt into a feed), the world link at view.
  const pickSegment = (seg: Segment) => {
    if (seg === "invite")
      return void applyAccess({ workspaceAccess: "none", linkRole: "none", listed: "none" })
    if (seg === "workspace")
      return void applyAccess({
        workspaceAccess: "member",
        linkRole: "none",
        listed: lst === "workspace" ? "workspace" : "none",
      })
    // anyone: keep the current link role (or default to view), keep a public listing.
    return void applyAccess({
      workspaceAccess: "member",
      linkRole: lRole === "none" ? "viewer" : lRole,
      listed: lst === "public" ? "public" : "none",
    })
  }
  // The world-link role select (Anyone only).
  const pickRole = (r: Exclude<LinkRole, "none">) =>
    void applyAccess({
      workspaceAccess: "member",
      linkRole: r,
      listed: isListed ? "public" : "none",
    })
  // The listing switch, per segment.
  const toggleListed = (on: boolean) => {
    if (segment === "workspace")
      void applyAccess({
        workspaceAccess: "member",
        linkRole: "none",
        listed: on ? "workspace" : "none",
      })
    else if (segment === "anyone")
      void applyAccess({
        workspaceAccess: "member",
        linkRole: roleValue,
        listed: on ? "public" : "none",
      })
  }
  // The lock checkbox: checking reveals the password input (applies on Set);
  // unchecking clears the lock immediately (an explicit empty password).
  const toggleLock = (on: boolean) => {
    if (on) setLockDraft(true)
    else if (hasLock)
      void applyAccess({ workspaceAccess: wsAccess, linkRole: lRole, listed: lst, password: "" })
    else setLockDraft(false)
  }
  const setPassword = (password: string) =>
    void applyAccess({ workspaceAccess: wsAccess, linkRole: lRole, listed: lst, password })
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
          setWsAccess(workspaceAccess ?? "member")
          setLRole(linkRole ?? "none")
          setLst(listed ?? "none")
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
          <Icon name={accessIcon(linkRole ?? "none", workspaceAccess ?? "member")} />
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
          <div>
            <SectionEyebrow action={savingVis && <Spinner className="size-3" />}>
              Who can open this
            </SectionEyebrow>
            {canManage ? (
              <div className="mt-2 flex flex-col">
                {/* One primary choice — the widest reach. Each segment sets the
                    (workspace_access, link_role, listed) triple — see pickSegment. */}
                <AccessSegmentToggle
                  segments={SEGMENTS}
                  value={segment}
                  onChange={pickSegment}
                  disabled={savingVis}
                  testId="share-access"
                />

                {segment === "invite" && (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Only the people you add below can open this.
                  </p>
                )}

                {/* Workspace: seats decide the role — no dropdown. Admins manage,
                    editors edit, commenters comment. Just the library switch. */}
                {segment === "workspace" && (
                  <>
                    <p className="mt-3 text-sm text-muted-foreground">
                      Everyone in the workspace opens this at their role — admins manage, editors
                      edit, commenters comment.
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-soft pt-3">
                      <div className="min-w-0">
                        <div className="text-sm text-foreground">Show in the workspace library</div>
                        <div className="text-xs text-muted-foreground">
                          Otherwise it's link-only — out of the team's feed.
                        </div>
                      </div>
                      <Switch
                        checked={isListed}
                        disabled={savingVis}
                        aria-label="Show in the workspace library"
                        data-testid="share-listed"
                        onCheckedChange={toggleListed}
                      />
                    </div>
                  </>
                )}

                {/* Anyone: a world link — its role, its public listing, and the lock. */}
                {segment === "anyone" && (
                  <>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground">Anyone with the link</span>
                      <SelectMenu
                        value={roleValue}
                        onValueChange={(v) => pickRole(v as Exclude<LinkRole, "none">)}
                      >
                        <SelectMenuTrigger
                          aria-label="What the link grants"
                          data-testid="share-link-role"
                          disabled={savingVis}
                          className="bg-card"
                        >
                          {LINK_ROLE_LABEL[roleValue]}
                        </SelectMenuTrigger>
                        <SelectMenuContent>
                          <SelectMenuItem value="viewer">Can view</SelectMenuItem>
                          <SelectMenuItem value="commenter">Can comment</SelectMenuItem>
                          <SelectMenuItem value="editor">Can edit</SelectMenuItem>
                        </SelectMenuContent>
                      </SelectMenu>
                    </div>

                    {roleValue === "editor" && (
                      <p className="mt-2 rounded-lg bg-warning/10 px-2.5 py-2 text-2xs text-warning">
                        Anyone with the link can edit, publish, and share this.
                      </p>
                    )}

                    {/* Listing is a SEPARATE question — its own row, below a rule. */}
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-soft pt-3">
                      <div className="min-w-0">
                        <div className="text-sm text-foreground">List in the public directory</div>
                        <div className="text-xs text-muted-foreground">
                          Otherwise the link works, but it stays undiscoverable.
                        </div>
                      </div>
                      <Switch
                        checked={isListed}
                        disabled={savingVis}
                        aria-label="List in the public directory"
                        data-testid="share-listed"
                        onCheckedChange={toggleListed}
                      />
                    </div>

                    {/* The lock — a modifier on the world link. Members and people
                        added below never need the password. */}
                    <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
                      <Checkbox
                        checked={hasLock || lockDraft}
                        disabled={savingVis}
                        aria-label="Require a password"
                        data-testid="share-lock-toggle"
                        onCheckedChange={(v) => toggleLock(v === true)}
                      />
                      Require a password
                    </label>
                    {(lockDraft || (hasLock && pwOpen)) && (
                      <div className="mt-2 flex gap-1.5">
                        <Input
                          type="password"
                          data-testid="share-visibility-password"
                          placeholder={hasLock ? "New password" : "Set a password"}
                          aria-label="Password"
                          value={pw}
                          onChange={(e) => setPw(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && pw) setPassword(pw)
                          }}
                          className="flex-1"
                        />
                        <Button
                          data-testid="share-visibility-save"
                          variant="secondary"
                          size="sm"
                          disabled={!pw}
                          loading={savingVis}
                          onClick={() => setPassword(pw)}
                        >
                          {savingVis ? "Setting…" : "Set password"}
                        </Button>
                      </div>
                    )}
                    {!lockDraft && hasLock && !pwOpen && (
                      <Button
                        variant="link"
                        size="xs"
                        data-testid="share-password-change"
                        className="mt-1 self-start px-0"
                        onClick={() => setPwOpen(true)}
                      >
                        Change password
                      </Button>
                    )}
                  </>
                )}

                {/* First-need on-ramp: the word "workspace" earns its first
                    appearance by answering "how do I show this to my team?". */}
                {solo && (
                  <p className="mt-3 text-sm text-muted-foreground">
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
                <Icon name={accessIcon(linkRole ?? "none", workspaceAccess ?? "member")} />
                {accessSummary(linkRole ?? "none", workspaceAccess ?? "member")}
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
                  <PersonSearchInput
                    value={email}
                    onChange={setEmail}
                    placeholder="Add people by @username or email…"
                    testId="share-email"
                  />
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
                  : "Give it a link (set access to “Anyone”) for the embed to load for others."}
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
