import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Icon } from "@/components/icons"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SidebarMenuItem } from "@/components/ui/sidebar"
import { useAuth } from "@/ctx"
import { onboardingQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useDeferredGate } from "@/lib/use-deferred-gate"
import { cn } from "@/lib/utils"

// Reads a per-browser checklist flag; storage failures (private mode) read as unset.
const flag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

/**
 * The getting-started pill: onboarding as a STATE the app is in, not a page that
 * vanished. Sits above the account pod until the user has activated — connected an
 * agent and had it publish — then retires itself for good. Each row completes from
 * a real signal from the server's onboarding endpoint, never from clicks. Dismiss
 * is one click and permanent
 * (per-browser); the instructions stay reachable via ⌘K → "Connect an agent".
 * Rendered for EVERY signed-in user who hasn't finished or dismissed it — including
 * accounts onboarded before this shipped: they are the unactivated cohort this
 * exists for.
 */
export function GettingStarted() {
  const { me } = useAuth()
  // One dismissal state for the session; reading localStorage once per mount is
  // fine — the pill is chrome, not data.
  const [dismissed, setDismissed] = useState(() => flag(STORAGE_KEYS.gettingStartedDismissed))
  const deferred = useDeferredGate()
  const [open, setOpen] = useState(false)

  // refetchOnWindowFocus: the journey happens in the user's TERMINAL — they connect
  // an agent, it publishes, they tab back. The app default (no focus refetch) would
  // freeze this checklist for the whole session; focus is exactly the moment to look.
  const { data: ob } = useQuery({
    ...onboardingQuery(),
    // Ambient: the pill renders nothing until this resolves, so it waits until the
    // boot's real reads have settled rather than competing with them.
    enabled: !!me && !dismissed && deferred,
    refetchOnWindowFocus: true,
  })

  // Both server-side steps done → this browser never needs the pill again. Persisted
  // in an effect (never during render); the mounted pill keeps rendering this session
  // so the user watching their journey sees completion before
  // it retires on the next visit.
  const serverDone = !!ob && ob.agent_connected && ob.published_via_agent
  useEffect(() => {
    if (serverDone) {
      try {
        localStorage.setItem(STORAGE_KEYS.gettingStartedDismissed, "1")
      } catch {
        /* private mode — it just re-checks next session */
      }
    }
  }, [serverDone])
  // An activated account on a NEW device sees serverDone on its very first data —
  // that user finished long ago; hide without a nag. Mid-journey users saw an
  // incomplete first read, so they keep the pill for this session.
  const [initiallyDone, setInitiallyDone] = useState<boolean | null>(null)
  useEffect(() => {
    if (ob && initiallyDone === null) setInitiallyDone(serverDone)
  }, [ob, serverDone, initiallyDone])

  if (!me || dismissed || !ob || initiallyDone !== false) return null

  const steps = [
    {
      key: "connect",
      label: "Connect an agent",
      detail: "One command links the agent you already use.",
      done: ob.agent_connected,
      doneNote: ob.agent_name,
    },
    {
      key: "publish",
      label: "Publish through your agent",
      detail: "Ask it to publish anything — you get a permanent, versioned link.",
      done: ob.published_via_agent,
      doneNote: null,
    },
  ]
  const doneCount = steps.filter((s) => s.done).length

  const dismiss = () => {
    setDismissed(true)
    setOpen(false)
    try {
      localStorage.setItem(STORAGE_KEYS.gettingStartedDismissed, "1")
    } catch {
      /* private mode */
    }
  }

  return (
    <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="getting-started-pill"
            className="flex h-8 w-full items-center gap-2 rounded-full border border-sidebar-border bg-sidebar px-3 text-xs font-medium text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <ProgressRing done={doneCount} total={steps.length} />
            <span className="truncate">Getting started</span>
            <span className="ml-auto font-mono text-2xs text-muted-foreground">
              {doneCount}/{steps.length}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 p-0">
          <div className="flex flex-col gap-0.5 px-4 pt-4 pb-1">
            <p className="font-serif text-base font-medium text-foreground">Getting started.</p>
            <p className="text-xs text-muted-foreground">
              Derive works through the agent you already use.
            </p>
          </div>
          <div className="flex flex-col px-2 py-2">
            {steps.map((s) => (
              <div
                key={s.key}
                data-testid={`getting-started-${s.key}`}
                className="flex items-start gap-2.5 rounded-md px-2 py-2"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                    s.done ? "bg-success/15 text-success" : "border border-border text-transparent",
                  )}
                >
                  <Icon name="check" size={11} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      "text-sm",
                      s.done ? "text-muted-foreground line-through" : "font-medium text-foreground",
                    )}
                  >
                    {s.label}
                    {s.done && s.doneNote ? (
                      <span className="ml-1.5 font-mono text-2xs no-underline">{s.doneNote}</span>
                    ) : null}
                  </span>
                  {!s.done && (
                    <span className="text-xs text-pretty text-muted-foreground">{s.detail}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t px-4 py-2.5">
            {/* Every row's instructions live on /welcome — the connect surface. */}
            <Link
              to="/welcome"
              data-testid="getting-started-open"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-foreground underline-offset-3 hover:underline"
            >
              Show me how
            </Link>
            <button
              type="button"
              data-testid="getting-started-dismiss"
              onClick={dismiss}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  )
}

// A tiny conic progress ring — the pill's only ornament. Ink on the done arc,
// hairline on the rest; no color, per the chrome's monochrome register.
function ProgressRing({ done, total }: { done: number; total: number }) {
  const pct = (done / total) * 100
  return (
    <span
      aria-hidden="true"
      className="size-3.5 shrink-0 rounded-full"
      style={{
        background: `conic-gradient(var(--sidebar-foreground) ${pct}%, var(--sidebar-border) ${pct}% 100%)`,
        // Punch the middle out so it reads as a ring, not a pie.
        WebkitMask: "radial-gradient(circle at center, transparent 42%, black 46%)",
        mask: "radial-gradient(circle at center, transparent 42%, black 46%)",
      }}
    />
  )
}
