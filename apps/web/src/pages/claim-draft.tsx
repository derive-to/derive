import { useQuery } from "@tanstack/react-query"
import { getRouteApi, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { ApiError, api } from "@/api"
import { Logo } from "@/components/shared/logo"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { workspaceQuery } from "@/lib/queries"
import { until } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"

const route = getRouteApi("/claim/$token")

// The calm chrome-less shell shared with /login and /invite/$token.
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

// Redeem an anonymous-draft claim link: an agent published an expiring draft with
// no account behind it and handed the human this URL. Show what the draft is, then
// (behind sign-in) move it into the claimant's active workspace and land on it.
export function ClaimDraft() {
  useDocumentTitle("Claim draft")
  const { token } = route.useParams()
  const { go } = route.useSearch()
  const { me, loading } = useAuth()
  const nav = useNavigate()

  const {
    data: preview,
    isPending,
    error,
  } = useQuery({
    queryKey: ["draft-claim", token],
    queryFn: () => api.previewDraftClaim(token),
    retry: false,
    // Keyed by the claim token (a capability secret) — never write it to IndexedDB.
    meta: { persist: false },
  })

  // Only fetched to name the destination on the button; needs a session.
  const { data: workspace } = useQuery({ ...workspaceQuery(), enabled: !!me })

  const claimMut = useApiMutation({
    mutationFn: () => api.claimDraft(token),
    errorToast: false,
    // The claimed artifact lands in the library — reconcile the lists + rail counts.
    invalidate: [["artifacts"], ["summary"]],
    onSuccess: (r) => nav({ to: "/artifacts/$ref", params: { ref: r.short_id } }),
    // A session that lapsed between load and click: finish sign-in, then return
    // here with ?go=1 so the claim completes without a second click.
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401)
        nav({ to: "/login", search: { return_to: `/claim/${token}?go=1` } })
    },
  })
  const claim = () => {
    // Not signed in: almost always a brand-new user holding their agent's claim
    // link, so open auth in signup mode (the page has a sign-in toggle for the
    // rest). ?go=1 rides return_to so the claim they just asked for finishes
    // itself after auth.
    if (!me) {
      nav({ to: "/login", search: { signup: true, return_to: `/claim/${token}?go=1` } })
      return
    }
    claimMut.mutate()
  }

  // Back from the auth hand-off: the user already clicked claim once — finish it.
  const fired = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on (go, me, preview); claimMut is stable from useApiMutation
  useEffect(() => {
    if (!go || fired.current || !me || !preview) return
    fired.current = true
    claimMut.mutate()
  }, [go, me, preview])

  if (isPending || loading)
    return (
      <Shell>
        <Spinner />
      </Shell>
    )

  // 404 (bad/expired token) and 410 (expired / already claimed) carry user-facing
  // messages from the API — surface them verbatim rather than a generic apology.
  if (error || !preview)
    return (
      <Shell>
        <StatusPanel
          tone="danger"
          title="This draft can't be claimed"
          description={
            error instanceof ApiError ? error.message : "The claim link is invalid or has expired."
          }
        />
        <Button variant="outline" data-testid="claim-go-home" onClick={() => nav({ to: "/" })}>
          Go to Derive
        </Button>
      </Shell>
    )

  const err = claimMut.error?.message ?? ""
  return (
    <Shell>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl font-medium tracking-tight text-balance text-foreground">
          Claim this draft
        </h1>
        <p className="text-sm text-pretty text-muted-foreground">
          An agent published{" "}
          <span className="font-medium text-foreground">{preview.title || "Untitled draft"}</span>{" "}
          as an expiring draft. Claim it to keep its versions, comments, and sharing controls.
        </p>
        <p className="text-sm text-muted-foreground">
          {preview.draft_url && (
            <>
              <a
                href={preview.draft_url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-muted-foreground"
              >
                Open the live draft
              </a>
              {" · "}
            </>
          )}
          <span title={new Date(preview.expires_at).toLocaleString()}>
            expires in {until(preview.expires_at)}
          </span>
        </p>
      </div>
      {err && (
        <div data-testid="claim-error" className="w-full">
          <StatusPanel tone="danger" layout="inline" title={err} />
        </div>
      )}
      <Button
        data-testid="claim-accept"
        size="lg"
        className="w-full"
        loading={claimMut.isPending}
        onClick={claim}
      >
        {me
          ? claimMut.isPending
            ? "Claiming…"
            : `Claim into ${workspace?.name ?? "your workspace"}`
          : "Create an account to claim"}
      </Button>
    </Shell>
  )
}
