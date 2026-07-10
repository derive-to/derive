import { useQuery } from "@tanstack/react-query"
import { getRouteApi, useNavigate } from "@tanstack/react-router"
import { type ArtifactInvitePreview, api, type InvitePreview } from "@/api"
import { Logo } from "@/components/shared/logo"
import { ROLE_LABELS } from "@/components/shared/role-select"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { roleLabel } from "./settings/roles"

const route = getRouteApi("/invite/$token")
const artifactRoute = getRouteApi("/invite/a/$token")

// The calm chrome-less shell shared with /login and /reset-password.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-card dark:bg-background">
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
          <div className="flex items-center gap-2">
            <Logo size={26} />
            <span className="font-serif text-lg font-medium tracking-tight">Derive</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}

export function AcceptInvite() {
  useDocumentTitle("Invitation")
  const { token } = route.useParams()
  const { me, loading } = useAuth()
  const nav = useNavigate()

  const {
    data: preview,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.previewInvite(token),
    retry: false,
  })

  // The invite named an email; the signed-in account has a different one. The
  // token still authorizes (self-hosts run without verified email), but the
  // mismatch is surfaced and acceptance must be explicit — the server 409s
  // without the confirm flag.
  const mismatch = !!(
    me &&
    preview?.email &&
    preview.email.toLowerCase() !== me.email.toLowerCase()
  )

  const acceptMut = useApiMutation({
    mutationFn: () => api.acceptInvite(token, mismatch),
    errorToast: false,
    // The roster/active-workspace may change — refresh, then land in the app.
    invalidate: [workspaceQuery().queryKey],
    onSuccess: () => nav({ to: "/" }),
  })
  const accept = () => {
    // Not signed in → send them to sign in, returning here to finish.
    if (!me) {
      nav({ to: "/login", search: { return_to: `/invite/${token}` } })
      return
    }
    acceptMut.mutate()
  }

  if (isPending || loading)
    return (
      <Shell>
        <Spinner />
      </Shell>
    )

  if (isError || !preview)
    return (
      <Shell>
        <StatusPanel
          tone="danger"
          title="This invitation is invalid or has expired"
          description="Ask a workspace admin to send you a new one."
        />
        <Button variant="outline" data-testid="invite-go-home" onClick={() => nav({ to: "/" })}>
          Go to Derive
        </Button>
      </Shell>
    )

  return (
    <Invitation
      preview={preview}
      signedIn={!!me}
      accepting={acceptMut.isPending}
      err={acceptMut.error?.message ?? ""}
      mismatchEmail={mismatch ? (me?.email ?? null) : null}
      onAccept={accept}
    />
  )
}

// The artifact twin of AcceptInvite: same shell, same mismatch contract, but the
// token grants ONE artifact (a per-artifact share) and accepting lands ON it —
// the emailed "so-and-so invited you to comment" growth loop.
export function AcceptArtifactInvite() {
  useDocumentTitle("Invitation")
  const { token } = artifactRoute.useParams()
  const { me, loading } = useAuth()
  const nav = useNavigate()

  const {
    data: preview,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["artifact-invite", token],
    queryFn: () => api.previewArtifactInvite(token),
    retry: false,
  })

  const mismatch = !!(
    me &&
    preview?.email &&
    preview.email.toLowerCase() !== me.email.toLowerCase()
  )

  const acceptMut = useApiMutation({
    mutationFn: () => api.acceptArtifactInvite(token, mismatch),
    errorToast: false,
    onSuccess: (r) => nav({ to: "/artifacts/$ref", params: { ref: r.short_id } }),
  })
  const accept = () => {
    if (!me) {
      nav({ to: "/login", search: { return_to: `/invite/a/${token}` } })
      return
    }
    acceptMut.mutate()
  }

  if (isPending || loading)
    return (
      <Shell>
        <Spinner />
      </Shell>
    )

  if (isError || !preview)
    return (
      <Shell>
        <StatusPanel
          tone="danger"
          title="This invitation is invalid or has expired"
          description="Ask the person who shared the document to send a new one."
        />
        <Button variant="outline" data-testid="invite-go-home" onClick={() => nav({ to: "/" })}>
          Go to Derive
        </Button>
      </Shell>
    )

  return (
    <ArtifactInvitation
      preview={preview}
      signedIn={!!me}
      accepting={acceptMut.isPending}
      err={acceptMut.error?.message ?? ""}
      mismatchEmail={mismatch ? (me?.email ?? null) : null}
      onAccept={accept}
    />
  )
}

function ArtifactInvitation({
  preview,
  signedIn,
  accepting,
  err,
  mismatchEmail,
  onAccept,
}: {
  preview: ArtifactInvitePreview
  signedIn: boolean
  accepting: boolean
  err: string
  mismatchEmail: string | null
  onAccept: () => void
}) {
  return (
    <Shell>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl font-medium tracking-tight text-balance text-foreground">
          {preview.inviter ? `${preview.inviter} invited you` : "You're invited"}
        </h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Open{" "}
          <span className="font-medium text-foreground">
            {preview.title ?? "an untitled document"}
          </span>{" "}
          on Derive as <Badge variant="secondary">{ROLE_LABELS[preview.role]}</Badge>
        </p>
        <p className="text-sm text-pretty text-muted-foreground">
          You'll only ever see what's shared with you.
        </p>
      </div>
      {mismatchEmail && (
        <div data-testid="invite-mismatch" className="w-full">
          <StatusPanel
            tone="warning"
            layout="inline"
            title={`This invite was sent to ${preview.email}`}
            description={`You're signed in as ${mismatchEmail}. You can accept anyway, or sign in with the invited address first.`}
          />
        </div>
      )}
      {err && (
        <div data-testid="invite-error" className="w-full">
          <StatusPanel tone="danger" layout="inline" title={err} />
        </div>
      )}
      <Button
        data-testid="invite-accept"
        size="lg"
        className="w-full"
        loading={accepting}
        onClick={onAccept}
      >
        {signedIn
          ? accepting
            ? "Opening…"
            : mismatchEmail
              ? "Accept anyway"
              : "Open the document"
          : "Sign in to open"}
      </Button>
    </Shell>
  )
}

function Invitation({
  preview,
  signedIn,
  accepting,
  err,
  mismatchEmail,
  onAccept,
}: {
  preview: InvitePreview
  signedIn: boolean
  accepting: boolean
  err: string
  /** Set when the signed-in email differs from the invited one — renders the warning. */
  mismatchEmail: string | null
  onAccept: () => void
}) {
  return (
    <Shell>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl font-medium tracking-tight text-balance text-foreground">
          {preview.inviter ? `${preview.inviter} invited you` : "You're invited"}
        </h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Join <span className="font-medium text-foreground">{preview.workspace}</span> on Derive as{" "}
          <Badge variant="secondary">{roleLabel(preview.role)}</Badge>
        </p>
      </div>
      {mismatchEmail && (
        <div data-testid="invite-mismatch" className="w-full">
          <StatusPanel
            tone="warning"
            layout="inline"
            title={`This invite was sent to ${preview.email}`}
            description={`You're signed in as ${mismatchEmail}. You can accept anyway, or sign in with the invited address first.`}
          />
        </div>
      )}
      {err && (
        <div data-testid="invite-error" className="w-full">
          <StatusPanel tone="danger" layout="inline" title={err} />
        </div>
      )}
      <Button
        data-testid="invite-accept"
        size="lg"
        className="w-full"
        loading={accepting}
        onClick={onAccept}
      >
        {signedIn
          ? accepting
            ? "Joining…"
            : mismatchEmail
              ? "Accept anyway"
              : "Accept invitation"
          : "Sign in to accept"}
      </Button>
    </Shell>
  )
}
