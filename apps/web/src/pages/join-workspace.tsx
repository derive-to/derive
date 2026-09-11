import { useQuery } from "@tanstack/react-query"
import { getRouteApi, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { ApiError, api } from "@/api"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { reloadAfterWorkspaceChange } from "@/lib/persist"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { InvitationPanel, Shell } from "./accept-invite"
import { roleLabel } from "./settings/roles"

const route = getRouteApi("/join/$token")

// The join page behind a workspace's shareable link. Reuses the invitation panel: the
// only differences are that no email is bound (so no mismatch warning), that a signed-out
// visitor comes back with ?go=1 and the join finishes itself, and that a Creator link can
// be turned away by the seat gate.
export function JoinWorkspace() {
  useDocumentTitle("Join workspace")
  const { token } = route.useParams()
  const { go } = route.useSearch()
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const [seatLimited, setSeatLimited] = useState(false)

  const {
    data: preview,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: ["join-link", token],
    queryFn: () => api.previewJoinLink(token),
    retry: false,
    // Keyed by the join token (a capability secret): never write it to IndexedDB.
    meta: { persist: false },
  })

  const joinMut = useApiMutation({
    mutationFn: () => api.joinWorkspace(token),
    errorToast: false,
    // The 402 here is the WORKSPACE OWNER's seat problem, not the joiner's: the global
    // upgrade dialog would offer to bill the joiner's own workspace. Handle it inline.
    paywall: false,
    onSuccess: async (r) => {
      // Land IN the workspace just joined: switch the active-workspace cookie, then the same
      // reload the workspace switcher uses (it drops the persisted query cache at boot so no
      // staleTime-Infinity query serves the previous workspace). The reload targets home.
      await api.switchWorkspace(r.org_id)
      reloadAfterWorkspaceChange("/")
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) return
      // A session that lapsed between load and click: finish sign-in, come back with ?go=1.
      // 403 too: the app-wide write lockdown refuses an anonymous POST before requireUser
      // runs, and this route emits no other 403.
      if (err.status === 401 || err.status === 403)
        nav({ to: "/login", search: { return_to: `/join/${token}?go=1` } })
      // The seat gate: a Creator link on a workspace out of Creator seats.
      if (err.status === 402) setSeatLimited(true)
    },
  })

  const join = () => {
    // Not signed in: sign in (or create an account) and come back with ?go=1 so the join the
    // person just asked for finishes without a second click.
    if (!me) {
      nav({ to: "/login", search: { return_to: `/join/${token}?go=1` } })
      return
    }
    joinMut.mutate()
  }

  // Back from the auth hand-off: they already clicked once. A plain visit (no go) never joins.
  const fired = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on (go, me, preview); joinMut is stable from useApiMutation
  useEffect(() => {
    if (!go || fired.current || !me || !preview) return
    fired.current = true
    joinMut.mutate()
  }, [go, me, preview])

  if (isPending || loading)
    return (
      <Shell>
        <Spinner />
      </Shell>
    )

  if (isError || !preview) {
    const expired = error instanceof ApiError && error.status === 410
    return (
      <Shell>
        <StatusPanel
          tone="danger"
          title={expired ? "This link has expired" : "This link is invalid or has been revoked"}
          description={
            expired
              ? "Ask the person who sent it for a new one."
              : "Ask a workspace Admin for a new one."
          }
        />
        <Button variant="outline" data-testid="invite-go-home" onClick={() => nav({ to: "/" })}>
          Go to Derive
        </Button>
      </Shell>
    )
  }

  const inviter = preview.inviter ?? "the workspace Admin"
  return (
    <InvitationPanel
      heading={preview.inviter ? `${preview.inviter} invited you` : "You're invited"}
      body={
        <>
          <p className="text-sm text-pretty text-muted-foreground">
            Join <span className="font-medium text-foreground">{preview.workspace}</span> on Derive
            as <Badge variant="secondary">{roleLabel(preview.role)}</Badge>
          </p>
          {seatLimited && (
            <div data-testid="join-seat-limited" className="w-full">
              <StatusPanel
                tone="warning"
                layout="inline"
                title={`${preview.workspace} has no Creator seats left.`}
                description={`Ask ${inviter} for a Viewer link or an upgrade.`}
              />
            </div>
          )}
        </>
      }
      invitedEmail=""
      cta={{ idle: `Join ${preview.workspace}`, busy: "Joining…", signIn: "Sign in to join" }}
      signedIn={!!me}
      accepting={joinMut.isPending}
      err={seatLimited ? "" : (joinMut.error?.message ?? "")}
      mismatchEmail={null}
      onAccept={join}
    />
  )
}
