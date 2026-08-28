import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { ConnectAgent } from "@/components/shared/connect-agent"
import { AskChip, EXAMPLE_ASKS } from "@/components/shared/example-asks"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { connectedAgentsQuery, onboardingQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useDocumentTitle } from "@/lib/use-document-title"

// Persist "onboarding finished" server-side (authoritative + cross-device) and cache
// locally for an instant guard on the very next nav. The cache stores the USER ID —
// needsOnboarding only honors it for the account that wrote it, so a second account
// created in this browser is still gated. Fire-and-forget: the flag is one-way, so a
// dropped write just re-shows /welcome once. The in-memory `me` update happens at the
// call site (setMe) — that's what keeps the redirect guard from bouncing even when
// localStorage is unavailable (private mode).
const persistOnboarded = (userId: string) => {
  api.setOnboarded().catch(() => {})
  try {
    localStorage.setItem(STORAGE_KEYS.onboarded, userId)
  } catch {
    /* private mode — setMe carries the in-session guard */
  }
}

// How fast the screen notices the user acting in their OTHER window (the agent
// completing OAuth, the first artifact landing). 2s matches the sync-chip poll —
// both are single indexed reads a user is actively watching.
const WATCH_INTERVAL_MS = 2000

/**
 * First-run onboarding, slimmed to the one activation moment: connect the agent
 * you already use, watch it publish. Three live states — the page polls the
 * consent + first-publish signals and advances itself, no "next" button:
 *   1. waiting to connect (the per-agent tabs)
 *   2. connected → suggest first asks
 *   3. first artifact live → open it / continue
 * Profile, passkey, and Brandprint setup live in Settings and the home nudges now;
 * activation pays for everything else. Reachable any time at /welcome — it stays
 * the app's coding-agent connection surface after onboarding,
 * so the connected state keeps the tabs one click away for adding a second agent.
 */
export function Welcome() {
  useDocumentTitle("Welcome")
  const { me, setMe } = useAuth()
  const nav = useNavigate()
  // The connected state collapses the tabs; this reopens them (add a second agent).
  const [showConnect, setShowConnect] = useState(false)

  // Live signal 1: has an agent been authorized? Poll until one appears; stop on
  // error too (the LoadError's Try again restarts the loop) so a down API isn't
  // hammered every 2s behind a manual-retry affordance.
  const agentsQ = useQuery({
    ...connectedAgentsQuery(),
    enabled: !!me,
    refetchInterval: (q) =>
      q.state.status === "error" || (q.state.data?.length ?? 0) > 0 ? false : WATCH_INTERVAL_MS,
  })
  const agent = agentsQ.data?.[0] ?? null

  // Live signal 2: has it published yet? Only asked once an agent is connected,
  // and stops polling the moment the first artifact lands (or on error).
  const obQ = useQuery({
    ...onboardingQuery(),
    enabled: !!me && !!agent,
    refetchInterval: (q) =>
      q.state.status === "error" || q.state.data?.published_via_agent ? false : WATCH_INTERVAL_MS,
  })
  const first = obQ.data?.first_artifact ?? null
  // The polls are the page's live half; the instructions above them keep working
  // regardless, so an error surfaces inline without replacing the surface.
  const watchFailed = agentsQ.isError || obQ.isError
  const retryWatch = () => {
    if (agentsQ.isError) void agentsQ.refetch()
    if (obQ.isError) void obQ.refetch()
  }

  // Activation IS onboarding: the moment the first artifact exists, the gate is
  // done — even if the user closes the tab from here without clicking an exit.
  const activated = !!first
  const meId = me?.id
  useEffect(() => {
    if (activated && meId) persistOnboarded(meId)
  }, [activated, meId])

  if (!me) return null
  const firstName = (me.name ?? me.username ?? me.email).split(/[@\s]/)[0]

  // Every exit marks onboarding done — server, storage, AND the in-memory session
  // (setMe), so the guard can't bounce back here even when storage writes fail.
  const leave = (to: "/" | "artifact") => {
    persistOnboarded(me.id)
    setMe({ ...me, onboarded: true })
    if (to === "artifact" && first) {
      nav({ to: "/artifacts/$ref", params: { ref: first.short_id } })
    } else {
      nav({ to: "/" })
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-14">
        <div className="flex flex-col gap-1.5">
          {/* First-run greeting — a voice moment, so it renders in the serif display. */}
          <h1 className="font-serif text-2xl font-medium tracking-tight text-balance text-foreground sm:text-3xl">
            Welcome to Derive, {firstName}.
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">
            Connect the agent you already work with and give its useful output a durable home. Two
            minutes, start to first artifact.
          </p>
        </div>

        {/* Step 1 — connect. Collapses to a done-row once the OAuth consent lands,
            with the tabs one click away (this page stays THE connect surface). */}
        {agent ? (
          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <DoneRow testId="welcome-connected">{agent.clientName} connected</DoneRow>
              <Button
                variant="ghost"
                size="sm"
                data-testid="welcome-connect-another"
                className="text-muted-foreground"
                onClick={() => setShowConnect((v) => !v)}
              >
                {showConnect ? "Hide setup" : "Connect another coding agent"}
              </Button>
            </div>
            {showConnect && <ConnectAgent testidPrefix="welcome" />}
          </section>
        ) : (
          <section className="flex flex-col gap-4">
            <ConnectAgent testidPrefix="welcome" />
            <WatchRow testId="welcome-watch-connect">Waiting for your agent to connect…</WatchRow>
          </section>
        )}

        {/* Offer a first publish after connection, then replace it with the published artifact. */}
        {agent && !first && (
          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-xl font-medium tracking-tight text-foreground">
              Now ask it to publish something.
            </h2>
            <p className="text-sm text-pretty text-muted-foreground">
              Anything becomes a living page with a permanent link. Try one of these, or ask in your
              own words.
            </p>
            <div className="flex flex-col gap-2">
              {EXAMPLE_ASKS.map((ask, i) => (
                <AskChip key={ask} text={ask} testId={`welcome-ask-${i}`} />
              ))}
            </div>
            <WatchRow testId="welcome-watch-publish">Watching for your first artifact…</WatchRow>
          </section>
        )}

        {/* Show the first artifact here for new and returning users. */}
        {first && (
          <section className="flex flex-col gap-4" data-testid="welcome-first-artifact">
            <DoneRow testId="welcome-published">First artifact published</DoneRow>
            <Link
              to="/artifacts/$ref"
              params={{ ref: first.short_id }}
              className="flex flex-col gap-1 rounded-lg border bg-card px-4 py-3 shadow-xs transition-colors hover:border-foreground/25"
            >
              <span className="font-serif text-lg font-medium text-foreground">
                {first.title ?? "Untitled"}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                by {agent?.clientName ?? "your agent"}, for you
              </span>
            </Link>
            <p className="text-sm text-pretty text-muted-foreground">
              It's live at a permanent link with its version history. Keep it here, share it when
              useful, or continue the work with comments, direct edits, and your agent.
            </p>
          </section>
        )}

        {watchFailed && (
          <LoadError
            layout="inline"
            title="Can't check your setup status right now."
            testId="welcome-retry"
            onRetry={retryWatch}
          />
        )}

        <div className="flex items-center justify-between gap-3">
          {first ? (
            <>
              <Button
                variant="ghost"
                data-testid="welcome-skip"
                className="text-muted-foreground"
                onClick={() => leave("/")}
              >
                Continue to Derive
              </Button>
              <Button
                variant="default"
                data-testid="welcome-open"
                onClick={() => leave("artifact")}
              >
                Open your artifact
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              data-testid="welcome-skip"
              className="text-muted-foreground"
              onClick={() => leave("/")}
            >
              Skip for now
            </Button>
          )}
        </div>

        <p className="text-center text-sm text-muted-foreground">
          Return from the account menu or search for “Connect your coding agent.”
        </p>
      </div>
    </div>
  )
}

// Compact completed state shared by the connection and publish steps.
function DoneRow({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <p data-testid={testId} className="flex items-center gap-2 text-sm font-medium text-foreground">
      <Icon name="check" className="text-success" />
      <span>{children}</span>
    </p>
  )
}

// Replaced by DoneRow when the polling query sees the expected state.
function WatchRow({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <p data-testid={testId} className="flex items-center gap-2.5 text-sm text-muted-foreground">
      <span className="relative flex size-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground opacity-50" />
        <span className="relative inline-flex size-2 rounded-full bg-muted-foreground" />
      </span>
      <span>{children}</span>
    </p>
  )
}
