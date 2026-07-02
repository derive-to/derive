import { useEffect, useRef, useState } from "react"
import { api, type Proposal, type Role } from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useFocusTrap } from "@/lib/use-focus-trap"
import { cn } from "@/lib/utils"
import { ReviewBody } from "./body"
import { ReviewDecisionBar } from "./decision-bar"
import { ReviewRail } from "./rail"
import { ago, STATE_META, StateBadge, useNarrow } from "./shared"

type View = "proposed" | "current" | "diff"

/**
 * The review surface. A proposed version renders exactly like a live one so a
 * reviewer approves the EXPERIENCE, not a source dump — toggle Proposed ↔ Current
 * to compare, with the line diff demoted to a third tab. A queue rail lists every
 * proposal with its state and the reviewer's note. Full-screen overlay; composes
 * onto the artifact page with one button.
 */
export function ReviewOverlay({
  shortId,
  currentVersion,
  myRole,
  meName,
  onClose,
  onApplied,
}: {
  shortId: string
  currentVersion: number
  myRole?: Role | null
  meName?: string | null
  onClose: () => void
  onApplied: () => void
}) {
  const narrow = useNarrow()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, true)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<Proposal | null>(null)
  const [view, setView] = useState<View>("proposed")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<"changes" | "approve" | null>(null)
  const [note, setNote] = useState("")

  const canApprove = myRole === "editor" || myRole === "owner"

  const load = () =>
    api
      .listProposals(shortId)
      .then((r) => {
        const live = r.proposals.filter((p) => p.state !== "withdrawn")
        setProposals(live)
        if (live.length === 0) {
          onClose()
          return
        }
        setActiveId((cur) => {
          if (cur && live.some((p) => p.id === cur)) return cur
          const next = live.find((p) => p.state === "open") ?? live[0]
          return next ? next.id : cur
        })
      })
      .catch(() => {})

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is keyed to shortId; onClose (which load may call) is not a refetch trigger.
  useEffect(() => {
    load()
  }, [shortId])

  // Refetch the detail when the selection changes OR when the selected proposal's
  // state flips (just approved / changes-requested), so the note + badge update.
  const activeState = proposals.find((p) => p.id === activeId)?.state
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeState is an intentional trigger so the detail refetches when the selected proposal's state flips.
  useEffect(() => {
    if (activeId)
      api
        .getProposal(shortId, activeId)
        .then(setActive)
        .catch(() => setActive(null))
    else setActive(null)
  }, [shortId, activeId, activeState])

  // Esc closes the overlay; if a note composer is open, Esc cancels that first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (noteFor) {
        setNoteFor(null)
        setNote("")
      } else onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [noteFor, onClose])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      setNoteFor(null)
      setNote("")
      onApplied()
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusy(false)
    }
  }

  const adds = active?.diff?.ops.filter((o) => o.t === "add").length ?? 0
  const dels = active?.diff?.ops.filter((o) => o.t === "del").length ?? 0
  const isAuthor = !!meName && active?.author === meName
  const isOpen = active?.state === "open"
  const stale = !!active && isOpen && active.base_version !== currentVersion

  const strip =
    view === "proposed"
      ? { text: "Viewing the proposed version — not live yet", accent: true }
      : view === "current"
        ? { text: `Viewing the current live version (v${currentVersion})`, accent: false }
        : { text: `Source diff · v${active?.base_version ?? "?"} → proposed`, accent: false }

  const ViewTabs = (
    <Tabs value={view} onValueChange={(v) => setView(v as View)}>
      <TabsList className="h-8">
        <TabsTrigger value="proposed" data-testid="review-view-proposed" className="px-2.5 py-0.5">
          Proposed
        </TabsTrigger>
        <TabsTrigger value="current" data-testid="review-view-current" className="px-2.5 py-0.5">
          Current
        </TabsTrigger>
        <TabsTrigger value="diff" data-testid="review-view-diff" className="px-2.5 py-0.5">
          Diff
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Review proposed changes"
      className="fixed inset-0 z-[80] flex flex-col bg-background"
    >
      {/* Top bar: selected proposal identity + view controls. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-3 py-2.5 md:flex-nowrap md:px-5">
        {/* Mono eyebrow grammar: uppercase only with mono + tracking-wide. */}
        <Badge variant="secondary" className="flex-none font-mono text-2xs tracking-wide">
          REVIEW
        </Badge>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              data-testid="review-title"
              className="truncate text-sm font-semibold text-foreground"
            >
              {active?.message ?? "Proposed change"}
            </span>
            {active && !narrow && <StateBadge state={active.state} />}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {active ? `${active.author} · proposed ${ago(active.created_at)}` : "Loading…"}
          </div>
        </div>
        {narrow && proposals.length > 1 && (
          <Select value={activeId ?? undefined} onValueChange={setActiveId}>
            <SelectTrigger
              data-testid="review-proposal-select"
              aria-label="Select proposal"
              className="w-[150px] flex-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {proposals.map((p, i) => (
                <SelectItem key={p.id} value={p.id}>
                  {(p.message ? p.message.slice(0, 26) : `Proposal ${i + 1}`) +
                    (p.state === "open" ? "" : ` · ${STATE_META[p.state].label}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {!narrow && ViewTabs}
        <Button
          data-testid="review-close"
          variant="ghost"
          size="sm"
          className="flex-none"
          onClick={onClose}
        >
          Close
        </Button>
        {narrow && <div className="flex w-full justify-center">{ViewTabs}</div>}
      </div>

      {/* Context strip. */}
      <div
        className={cn(
          "flex items-center gap-2 border-b border-l-[3px] border-border-soft px-5 py-1.5 text-xs font-medium",
          // "Viewing the proposed version" is a brand moment: amber bar + soft tint.
          strip.accent
            ? "border-l-primary bg-primary/10 text-foreground"
            : "border-l-border bg-card text-muted-foreground",
        )}
      >
        {strip.text}
        {view === "diff" && (
          <span className="ml-auto flex gap-3 font-mono tabular-nums">
            <span className="text-success">+{adds}</span>
            <span className="text-destructive">−{dels}</span>
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {!narrow && <ReviewRail proposals={proposals} activeId={activeId} onSelect={setActiveId} />}
        <ReviewBody
          shortId={shortId}
          view={view}
          active={active}
          currentVersion={currentVersion}
          isOpen={isOpen}
          stale={stale}
          onCompareCurrent={() => setView("current")}
        />
      </div>

      <ReviewDecisionBar
        active={active}
        isOpen={isOpen}
        isAuthor={isAuthor}
        canApprove={canApprove}
        stale={stale}
        currentVersion={currentVersion}
        narrow={narrow}
        busy={busy}
        err={err}
        noteFor={noteFor}
        note={note}
        onNoteChange={setNote}
        onOpenChanges={() => setNoteFor("changes")}
        onOpenApprove={() => setNoteFor("approve")}
        onCancel={() => {
          setNoteFor(null)
          setNote("")
        }}
        onWithdraw={() => active && act(() => api.withdrawProposal(shortId, active.id))}
        onSubmitChanges={() =>
          active && act(() => api.requestChanges(shortId, active.id, note.trim()))
        }
        onConfirmApprove={() =>
          active && act(() => api.approveProposal(shortId, active.id, note.trim() || undefined))
        }
      />
    </div>
  )
}
