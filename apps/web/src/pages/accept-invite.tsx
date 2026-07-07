import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api, type InvitePreview } from "@/api"
import { Logo } from "@/components/shared/logo"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { workspaceQuery } from "@/lib/queries"
import { roleLabel } from "./settings/roles"

const route = getRouteApi("/invite/$token")

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
  const { token } = route.useParams()
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [accepting, setAccepting] = useState(false)
  const [err, setErr] = useState("")

  const {
    data: preview,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.previewInvite(token),
    retry: false,
  })

  const accept = async () => {
    // Not signed in → send them to sign in, returning here to finish.
    if (!me) {
      nav({ to: "/login", search: { return_to: `/invite/${token}` } })
      return
    }
    setAccepting(true)
    setErr("")
    try {
      await api.acceptInvite(token)
      // The roster/active-workspace may change — refresh, then land in the app.
      qc.invalidateQueries({ queryKey: workspaceQuery().queryKey })
      nav({ to: "/" })
    } catch (e) {
      setErr((e as Error).message)
      setAccepting(false)
    }
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
      accepting={accepting}
      err={err}
      onAccept={accept}
    />
  )
}

function Invitation({
  preview,
  signedIn,
  accepting,
  err,
  onAccept,
}: {
  preview: InvitePreview
  signedIn: boolean
  accepting: boolean
  err: string
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
        {signedIn ? (accepting ? "Joining…" : "Accept invitation") : "Sign in to accept"}
      </Button>
    </Shell>
  )
}
