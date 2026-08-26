import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import {
  API_BASE,
  type ArtifactDomain,
  type ArtifactInvite,
  type ArtifactMember,
  api,
  type CollectionGrant,
  type LinkRole,
  type Listed,
  type Role,
  type WorkspaceAccess,
} from "@/api"
import { Icon } from "@/components/icons"
import { Eyebrow, SectionEyebrow } from "@/components/shared/section-eyebrow"
import {
  accessIcon,
  accessSummary,
  linkReachNote,
  ShareAccessSection,
  ShareCopyLinkButton,
  SharePeopleSection,
  type ShareSegment,
} from "@/components/shared/share-dialog-sections"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/ctx"
import { copyText, useCopy } from "@/lib/clipboard"
import { artifactQuery, workspaceQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useApiMutation } from "@/lib/use-api-mutation"
import { ShareCollectionDialog } from "@/pages/library/share-collection-dialog"

// Access is ONE primary question — who can open this — projected from the v2
// triple (workspace_access, link_role, listed; see access-model.md). Each segment
// is the WIDEST reach currently granted: a world link is "anyone"; workspace-seat
// access is "workspace"; neither is "invite". The world link's role and each
// segment's listing (does it show in a feed) are secondary switches beneath it.
// The state glyph the Share trigger carries so exposure is legible without opening
// the dialog: a globe when the URL alone reads, the share glyph for the workspace,
// a lock for invite-only. A workspace-open collection makes the artifact workspace-
// reachable even when its own fields say Invited (see access-model.md) — the lock is
// a promise ("nobody but the roster"), so it must account for that grant too.
// The access triple + an optional world-link password, applied atomically by setAccess.
type AccessDraft = {
  workspaceAccess: WorkspaceAccess
  linkRole: LinkRole
  listed: Listed
  password?: string
  /** Owner opt-in: the anonymous public page shows version history. */
  publicHistory?: boolean
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
  publicHistory = false,
  collectionAccess,
  videoMoment,
}: {
  shortId: string
  myRole?: Role | null
  /** The v2 access triple (see access-model.md). */
  workspaceAccess?: WorkspaceAccess
  linkRole?: LinkRole
  listed?: Listed
  /** The world link carries a password (the lock). */
  passwordProtected?: boolean
  /** The anonymous public page shows version history (owner opt-in). */
  publicHistory?: boolean
  /** Collections whose sharing reaches this artifact (detail response) — rendered as
   *  disclosure rows so the dialog never claims "Invited" while a collection grants
   *  the workspace access. */
  collectionAccess?: CollectionGrant[]
  videoMoment?: { scene: string; timeMs: number }
}) {
  const qc = useQueryClient()
  const { me } = useAuth()
  const [members, setMembers] = useState<ArtifactMember[]>([])
  // Pending emailed invites (share-capable callers only; the server omits them
  // otherwise). Each row revokes; accepting one turns it into a member row.
  const [invites, setInvites] = useState<ArtifactInvite[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  // A ref, not just the add mutation's async `isPending`: state updates are batched, so a
  // burst of synchronous native submit events (Enter held down, or auto-repeating — see
  // PersonSearchInput's documented submit-fallthrough) can all read the SAME stale pending
  // closure before the first mutate re-renders. The ref flips synchronously, so only the
  // first of a burst gets through.
  const adding = useRef(false)
  // Access draft: the three fields, plus the lock (password) state for the world link.
  const [wsAccess, setWsAccess] = useState<WorkspaceAccess>(workspaceAccess ?? "member")
  const [lRole, setLRole] = useState<LinkRole>(linkRole ?? "none")
  const [lst, setLst] = useState<Listed>(listed ?? "none")
  const [pw, setPw] = useState("")
  // The lock as the server knows it, kept locally current as we set/clear it.
  const [hasLock, setHasLock] = useState(passwordProtected)
  // Public history as the server knows it (see the world-link row below).
  const [pubHist, setPubHist] = useState(publicHistory)
  // The checkbox is checked before a password exists (the input is showing) —
  // nothing applies until Set password.
  const [lockDraft, setLockDraft] = useState(false)

  const { copied, copy: copyToClipboard } = useCopy()
  const { copied: copiedLink, copy: copyLinkToClipboard } = useCopy()
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

  // GDocs model: owners and editors manage access; everyone else gets view-only.
  const canManage = myRole === "owner" || myRole === "editor"

  // The server sends only collections whose sharing ADDS reach, pre-scoped to what
  // this caller may see (the collection_access contract) — render verbatim.
  const grants = collectionAccess ?? []
  const collectionOpen = grants.some((g) => g.workspace_access === "member")
  // The collection controller mounted over this dialog when its disclosure row is managed.
  const [manageCol, setManageCol] = useState<CollectionGrant | null>(null)

  // The canonical share URL — the server-built artifact URL when the detail is
  // cached (it is, on the artifact page), else reconstructed from the short id.
  const { data: art } = useQuery({ ...artifactQuery(shortId), enabled: false })
  const shareUrl =
    art?.url ??
    `${typeof window === "undefined" ? "" : window.location.origin}/artifacts/${shortId}`
  const momentUrl = videoMoment
    ? `${shareUrl}${shareUrl.includes("?") ? "&" : "?"}scene=${encodeURIComponent(videoMoment.scene)}&t=${Math.round(videoMoment.timeMs)}`
    : null

  // Embed snippet: an iframe of the embeddable view. Same-origin by default; the
  // split-deploy SPA points at the API origin via API_BASE. The embed only shows
  // for others when the artifact is link- or world-readable.
  const origin = API_BASE || (typeof window === "undefined" ? "" : window.location.origin)
  const embedSnippet = `<iframe src="${origin}/v1/embed/${shortId}" width="100%" height="480" style="border:0;border-radius:12px" loading="lazy" title="Derive artifact" allowfullscreen></iframe>`
  const linkAccessible = (linkRole ?? "none") !== "none"
  const copyEmbed = () => void copyToClipboard(embedSnippet, { success: "Embed code copied" })

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
  const segment: ShareSegment =
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
  // Optimistic so the controls don't flash the old state; the primitive rolls back the
  // draft AND toasts on failure through the shared access surface.
  const accessMut = useApiMutation({
    mutationFn: (next: AccessDraft) => api.setAccess(shortId, next),
    optimistic: (next) => {
      const prev = { wsAccess, lRole, lst, hasLock, lockDraft, pubHist }
      setWsAccess(next.workspaceAccess)
      setLRole(next.linkRole)
      setLst(next.listed)
      if (next.publicHistory !== undefined) setPubHist(next.publicHistory)
      if (next.linkRole === "none") {
        setHasLock(false)
        setLockDraft(false)
      }
      return () => {
        setWsAccess(prev.wsAccess)
        setLRole(prev.lRole)
        setLst(prev.lst)
        setHasLock(prev.hasLock)
        setLockDraft(prev.lockDraft)
        setPubHist(prev.pubHist)
      }
    },
    onSuccess: (r) => {
      setWsAccess(r.workspace_access)
      setLRole(r.link_role)
      setLst(r.listed)
      setHasLock(!!r.locked)
      setPubHist(!!r.public_history)
      setLockDraft(false)
      setPw("")
      setPwOpen(false)
    },
    // Refresh the artifact (drives the toolbar glyph) and the library.
    invalidate: [artifactQuery(shortId).queryKey, ["artifacts"]],
  })
  const applyAccess = (next: AccessDraft) => accessMut.mutate(next)
  // Picking a segment sets its fields at the safe default: a fresh segment starts
  // UNLISTED (the switch is how you opt into a feed), the world link at view.
  const pickSegment = (seg: ShareSegment) => {
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
  // The current triple, untouched, with the world-link password set to the given
  // value — shared by the two calls below that change only the password.
  const currentTripleWithPassword = (password: string): AccessDraft => ({
    workspaceAccess: wsAccess,
    linkRole: lRole,
    listed: lst,
    password,
  })
  // Public history: applies immediately like every other switch here.
  const togglePublicHistory = (on: boolean) =>
    void applyAccess({ workspaceAccess: wsAccess, linkRole: lRole, listed: lst, publicHistory: on })
  // The lock checkbox: checking reveals the password input (applies on Set);
  // unchecking clears the lock immediately (an explicit empty password).
  const toggleLock = (on: boolean) => {
    if (on) setLockDraft(true)
    else if (hasLock) void applyAccess(currentTripleWithPassword(""))
    else setLockDraft(false)
  }
  const setPassword = (password: string) => void applyAccess(currentTripleWithPassword(password))
  const copyLink = async () => {
    // The toast carries the reach too: the note under the button is easy to miss at
    // the moment that matters, which is the click right before pasting into an email.
    const reach = linkReachNote(lRole, wsAccess, collectionOpen)
    const success = reach ? `Link copied — ${reach.toLowerCase()}` : "Link copied"
    if (await copyLinkToClipboard(shareUrl, { success })) {
      // The getting-started checklist's "share a link" step completes here — the
      // one gesture that means "I sent this to someone" (see chrome/getting-started).
      try {
        localStorage.setItem(STORAGE_KEYS.sharedLink, "1")
      } catch {
        /* private mode — the checklist row just stays open */
      }
    }
  }
  const copyMoment = () =>
    momentUrl
      ? void copyLinkToClipboard(momentUrl, { success: "Current moment link copied" })
      : undefined

  const load = () =>
    api
      .listMembers(shortId)
      .then((r) => {
        setMembers(r.members)
        setInvites(r.invites)
      })
      // A failed load must not read as "no one has access" — say so instead of blanking.
      .catch(() => toast.error("Couldn't load who has access"))
  // After a share change, refresh the local list AND the shared cache: the artifact
  // query holds `my_role` (drives the toolbar), and the library reflects access.
  const synced = async () => {
    await load()
    qc.invalidateQueries({ queryKey: artifactQuery(shortId).queryKey })
    qc.invalidateQueries({ queryKey: ["artifacts"] })
  }

  const addMut = useApiMutation({
    mutationFn: (addr: string) => api.setMember(shortId, addr, role),
    onSuccess: (res) => {
      setEmail("")
      // No account behind that email — the server minted a pending invite and
      // emailed it. Nothing appears for the recipient until they accept, so
      // don't announce them as added.
      if (res.kind === "invite") toast(`Invite sent to ${res.invite.email}.`)
      synced()
    },
  })
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    if (adding.current) return
    const addr = email.trim()
    if (!addr) return
    adding.current = true
    addMut.mutate(addr, {
      onSettled: () => {
        adding.current = false
      },
    })
  }
  // Role change / removal — a failed one surfaces via the global safety net; the member
  // list + shared caches reconcile on success.
  const changeMut = useApiMutation({
    mutationFn: ({ handle, next }: { handle: string; next: Role }) =>
      api.setMember(shortId, handle, next),
    success: "Role updated",
    onSuccess: () => synced(),
  })
  const change = (m: ArtifactMember, next: Role) => {
    if (next !== m.role && m.handle) changeMut.mutate({ handle: m.handle, next })
  }
  const revokeInviteMut = useApiMutation({
    mutationFn: (inviteId: string) => api.revokeArtifactInvite(shortId, inviteId),
    success: "Invite revoked",
    onSuccess: () => synced(),
  })
  const removeMut = useApiMutation({
    mutationFn: (m: ArtifactMember) => api.removeMember(shortId, m.user_id),
    onSuccess: () => synced(),
  })
  const remove = (m: ArtifactMember) => removeMut.mutate(m)

  const loadDomains = () =>
    api
      .listDomains(shortId)
      .then((r) => {
        setDomains(r.domains)
        setDomainBase(r.base)
        setWorkspaceDomains(r.workspace_domains)
      })
      .catch(() => {})
  const claim = useApiMutation({
    mutationFn: () => api.setDomain(shortId, label.trim().toLowerCase()),
    success: "Custom URL claimed",
    onSuccess: () => {
      setLabel("")
      loadDomains()
    },
  })
  const claimDomain = (e: React.FormEvent) => {
    e.preventDefault()
    if (label.trim().toLowerCase()) claim.mutate()
  }
  // Best-effort drop: a failure just leaves the row (stay quiet), then reconcile.
  const dropMut = useApiMutation({
    mutationFn: (host: string) => api.removeDomain(shortId, host),
    errorToast: false,
    onSuccess: () => loadDomains(),
  })
  const dropDomain = (host: string) => dropMut.mutate(host)
  const copyUrl = (url: string) => void copyText(url, { success: "URL copied" })

  return (
    <Dialog
      onOpenChange={(o) => {
        if (o) {
          setWsAccess(workspaceAccess ?? "member")
          setLRole(linkRole ?? "none")
          setLst(listed ?? "none")
          setPw("")
          setPwOpen(false)
          // Re-seed the lock from the server's state and drop any half-typed
          // draft — an abandoned checkbox must not survive a close/reopen.
          setHasLock(passwordProtected)
          setPubHist(publicHistory)
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
          <Icon
            name={accessIcon(linkRole ?? "none", workspaceAccess ?? "member", collectionOpen)}
          />
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
          <ShareAccessSection
            canManage={canManage}
            pending={accessMut.isPending}
            segment={segment}
            testPrefix="share"
            inviteCopy={
              grants.length > 0
                ? "Only the people you add below and anyone with access through a collection."
                : "Only the people you add below can open this."
            }
            workspaceCopy="Everyone in the workspace uses their existing role. Admins manage, editors edit, and commenters comment."
            readOnlyIcon={accessIcon(
              linkRole ?? "none",
              workspaceAccess ?? "member",
              collectionOpen,
            )}
            readOnlyCopy={accessSummary(
              linkRole ?? "none",
              workspaceAccess ?? "member",
              collectionOpen,
            )}
            onSegmentChange={pickSegment}
            world={{
              role: roleValue,
              hasLock,
              lockDraft,
              passwordOpen: pwOpen,
              password: pw,
              onRoleChange: pickRole,
              onLockChange: toggleLock,
              onPasswordOpen: () => setPwOpen(true),
              onPasswordChange: setPw,
              onPasswordSet: setPassword,
            }}
            workspaceChildren={
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-soft pt-3">
                <div className="min-w-0">
                  <div className="text-sm text-foreground">Show in the workspace library</div>
                  <div className="text-xs text-muted-foreground">
                    Otherwise, only people with the link can find it.
                  </div>
                </div>
                <Switch
                  checked={isListed}
                  disabled={accessMut.isPending}
                  aria-label="Show in the workspace library"
                  data-testid="share-listed"
                  onCheckedChange={toggleListed}
                />
              </div>
            }
            worldChildren={
              <>
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-soft pt-3">
                  <div className="min-w-0">
                    <div className="text-sm text-foreground">List in the public directory</div>
                    <div className="text-xs text-muted-foreground">
                      Otherwise the link works, but it stays undiscoverable.
                    </div>
                  </div>
                  <Switch
                    checked={isListed}
                    disabled={accessMut.isPending}
                    aria-label="List in the public directory"
                    data-testid="share-listed"
                    onCheckedChange={toggleListed}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-foreground">Show version history</div>
                    <div className="text-xs text-muted-foreground">
                      Anyone with the link can browse every version.
                    </div>
                  </div>
                  <Switch
                    checked={pubHist}
                    disabled={accessMut.isPending}
                    aria-label="Show version history on the public page"
                    data-testid="share-public-history"
                    onCheckedChange={togglePublicHistory}
                  />
                </div>
              </>
            }
          >
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
          </ShareAccessSection>

          {/* Disclosure, not control: each row is a collection whose sharing reaches
              this artifact — the one access source the fields above can't express
              (a collection grant folds into the explicit slot; see access-model.md).
              Rendered for every viewer, managers or not — reach is never a secret
              from someone who can already open the doc. The revocable unit is the
              collection relationship, so the affordance is Manage (its share dialog),
              not per-person rows. */}
          {grants.length > 0 && (
            <div>
              <SectionEyebrow count={grants.length > 1 ? grants.length : undefined}>
                Reachable through collections
              </SectionEyebrow>
              <div className="-mx-2 mt-1 flex flex-col">
                {grants.map((g) => (
                  <div
                    key={g.id}
                    data-testid={`share-collection-row-${g.id}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-secondary"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary">
                      <Icon name="collections" size={16} className="text-muted-foreground" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{g.title}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {g.workspace_access === "member"
                          ? "Everyone in the workspace opens this at their role"
                          : // member_count includes the creator's own row, so "members",
                            // not "invited" — the creator wasn't invited, but reaches it.
                            `${g.member_count} collection ${g.member_count === 1 ? "member opens" : "members open"} this at their role`}
                      </div>
                    </div>
                    {/* Collection sharing is owner-managed; everyone else gets attribution —
                        who to ask. Muted at rest
                        (this section is disclosure, not control — the row's content
                        carries the weight); hover re-inks. */}
                    {g.my_role === "owner" ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-muted-foreground hover:text-foreground"
                        data-testid={`share-collection-manage-${g.id}`}
                        onClick={() => setManageCol(g)}
                      >
                        Manage
                        <Icon name="chevron-right" />
                      </Button>
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {g.owner_name ? `Managed by ${g.owner_name}` : "Shared collection"}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <SharePeopleSection
            members={members}
            invites={invites}
            currentUserId={me?.id}
            canManage={canManage}
            email={email}
            role={role}
            pending={addMut.isPending}
            testPrefix="share"
            memberIsFixed={(member) =>
              member.role === "owner" &&
              members.filter((item) => item.role === "owner").length === 1
            }
            onEmailChange={setEmail}
            onRoleChange={setRole}
            onAdd={add}
            onMemberRoleChange={change}
            onRemoveMember={remove}
            onRevokeInvite={(inviteId) => revokeInviteMut.mutate(inviteId)}
          />
        </div>

        {/* Footer: the universal action on the left, distribution mechanics folded
            behind a quiet disclosure on the right. */}
        <div className="flex items-center justify-between border-t border-border pt-4">
          <ShareCopyLinkButton
            copied={copiedLink}
            testPrefix="share"
            reach={linkReachNote(lRole, wsAccess, collectionOpen)}
            onCopy={copyLink}
          >
            {momentUrl && (
              <Button
                data-testid="share-moment-copy"
                variant="outline"
                size="sm"
                onClick={copyMoment}
              >
                Copy current moment
              </Button>
            )}
          </ShareCopyLinkButton>
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
                  ? "Paste this into any page. It stays live and links back to Derive."
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
                      loading={claim.isPending}
                      disabled={!label.trim()}
                    >
                      {claim.isPending ? "Claiming…" : "Claim"}
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

      {/* Manage a granting collection without leaving the share dialog — the stacked
          collection dialog portals above this one. The refetch rides onChanged (fired
          when each write LANDS), never onClose: an Escape mid-flight must not race the
          PATCH and repaint the disclosure rows from the pre-change state. */}
      {manageCol && (
        <ShareCollectionDialog
          collection={manageCol}
          onChanged={() => qc.invalidateQueries({ queryKey: artifactQuery(shortId).queryKey })}
          onClose={() => setManageCol(null)}
        />
      )}
    </Dialog>
  )
}
