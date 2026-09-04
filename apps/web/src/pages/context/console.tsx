import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams } from "@tanstack/react-router"
import { Copy as CopyIcon, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import {
  ApiError,
  api,
  type ContextDetail,
  type ManifestSkillInfo,
  type Session,
  type SessionMessage,
  type SessionMeta,
} from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { AccessSegmentToggle } from "@/components/shared/access-segment-toggle"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageShell } from "@/components/shared/page-shell"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionTitle } from "@/components/shared/section-title"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge, type badgeVariants } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { copyText, useCopy } from "@/lib/clipboard"
import {
  artifactQuery,
  contextOutputsQuery,
  contextQuery,
  contextSessionsQuery,
  sessionQuery,
} from "@/lib/queries"
import { applyDelta, type DeltaState, EMPTY_DELTA } from "@/lib/session-delta"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { usePageVisible } from "@/lib/use-page-visible"
import { useUserEvent } from "@/lib/use-user-events"
import { cn } from "@/lib/utils"
import { mdToHtml } from "../artifact/lib/markdown"
import { ConsolePending, ContextRowsSkeleton } from "./context-skeleton"
import { ANSWER_PROSE, answerMdToHtml } from "./lib/answer-md"
import { runnerStatus } from "./runner-status"

// The Context console combines package configuration, execution status, and run history.
// The transcript polls fast only while the runner owes a reply (sessionQuery's
// refetchInterval), and refetches immediately on the server's session.settled /
// session.progress push (SessionThread) — the poll is the fallback, the push is what
// makes a reply land without waiting out the interval.
export function ContextConsole() {
  const { id } = useParams({ from: "/contexts/$id" })
  // Keyed by context id: the router keeps this route's component mounted across
  // /contexts/A → /contexts/B, and a `picked` session id from A must not
  // survive into B's console.
  return <Console key={id} id={id} />
}

// A context's own scopes, read off its manifest's body — a presentation-layer parse
// (never authoritative; the server never sees this), mirroring the narrow spirit of
// the server's own frontmatter parsers. Looks for the first heading naming
// scope/try/example, then takes inline-code spans out of what follows it, stopping at
// the next heading. No matching section ⇒ no chips — nothing here is invented.
function tryChipsFrom(md: string | null | undefined): string[] {
  if (!md) return []
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^#{1,6}\s.*\b(scope|try|example)/i.test(l))
  if (start === -1) return []
  const chips: string[] = []
  for (let i = start + 1; i < lines.length && chips.length < 5; i++) {
    const line = lines[i] as string
    if (/^#{1,6}\s/.test(line)) break
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      if (m[1] && chips.length < 5) chips.push(m[1])
    }
  }
  return chips
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

type ContextOutput = Awaited<ReturnType<typeof api.listContextOutputs>>["outputs"][number]

export type ContextNowSummary = {
  working: number
  waiting: number
  needsReview: number
  failed: number
  headline: string
}

/** Reduce the visible session record to the small set of states a person needs first.
 * It never infers help: only an authored escalated state becomes "needs review". */
export function contextNowSummary(sessions: Session[]): ContextNowSummary {
  const working = sessions.filter((session) => session.state === "working").length
  const waiting = sessions.filter((session) => session.state === "open").length
  const needsReview = sessions.filter((session) => session.state === "escalated").length
  const failed = sessions.filter((session) => session.state === "failed").length
  const headline = needsReview
    ? `${needsReview} ${needsReview === 1 ? "run needs" : "runs need"} your review.`
    : failed
      ? `${failed} ${failed === 1 ? "run has" : "runs have"} failed.`
      : working
        ? `${working} ${working === 1 ? "run is" : "runs are"} working now.`
        : waiting
          ? `${waiting} ${waiting === 1 ? "run is" : "runs are"} waiting to start.`
          : "Ready for a new question."
  return { working, waiting, needsReview, failed, headline }
}

function Console({ id }: { id: string }) {
  const { me } = useAuth()
  const qc = useQueryClient()
  // Polled (unlike the one-shot route loader fetch): runner_seen_at only moves
  // when the server re-reads the row, and liveness going STALE is exactly the
  // signal this page exists to show.
  const {
    data: context,
    error,
    isLoading,
  } = useQuery({
    ...contextQuery(id),
    refetchInterval: 60_000,
  })
  const {
    data: sessionPages,
    isError: sessionsFailed,
    refetch: refetchSessions,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(contextSessionsQuery(id))
  // One flat list off the pages — the picker and Activity both read it, and neither
  // cares where a page boundary fell.
  const sessions = sessionPages?.pages.flatMap((p) => p.sessions)
  const {
    data: outputs,
    isPending: outputsPending,
    isError: outputsFailed,
  } = useQuery(contextOutputsQuery(id))
  // The tab names the Context; use a stable base title while it loads or access is checked.
  useDocumentTitle(context?.name ?? null)

  // The session on screen: sticky once picked; defaults to the most recent.
  const [picked, setPicked] = useState<string | null>(null)
  // Controlled tabs so the Activity view can hand a session to Chat, and the rail's
  // "see manifest" link can hand off to the Manifest tab.
  const [tab, setTab] = useState("chat")
  const mine = (sessions ?? []).filter((s) => s.asker_id === me?.id)
  const active = picked === "new" ? null : (picked ?? mine[0]?.id ?? null)
  const isOwner = !!context && context.created_by === me?.id
  // Managed connections are absent from Settings, so their runner token is rotated here.
  // The API enforces admin access and returns the replacement token once.
  const [rotatedToken, setRotatedToken] = useState<string | null>(null)
  const rotateToken = useApiMutation({
    mutationFn: () => api.rotateAgent(context?.agent_id ?? ""),
    success: "New key issued. The old key no longer works.",
    onSuccess: (a) => setRotatedToken(a.token),
  })

  // No ask-access reads as 404 (a context's existence never leaks outside its
  // workspace). Say so instead of spinning forever — the loader prefetches (no
  // rethrow), so this component owns the state. Gate on `!context` too: this query
  // polls every 60s, and a background-poll blip sets `error` while the loaded context
  // is retained — don't throw a working console (and any half-typed follow-up) to this
  // screen over a transient blip; it self-heals next poll.
  if (error && !context) {
    const status = error instanceof ApiError ? error.status : undefined
    return (
      <PageShell className="flex justify-center pt-16">
        <EmptyState
          icon={<Icon name="lock" strokeWidth={1.75} />}
          title={status === 404 || status === 403 ? "You don't have access" : "Couldn't load"}
          description={
            status === 404 || status === 403
              ? "Ask the owner for access. Only invited workspace members can use this Context."
              : "Something went wrong loading this Context. Try again in a moment."
          }
        />
      </PageShell>
    )
  }
  if (!context || isLoading) return <ConsolePending />

  const skillsCount = context.skills?.length ?? context.skills_count ?? 0
  const sourcesCount = context.connection_ids.length
  const budgetMin = context.max_run_ms ? Math.round(context.max_run_ms / 60_000) : null

  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <Icon name="context" className="text-muted-foreground" />
          <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
            {context.name}
          </h1>
          <RunnerLiveness seenAt={context.runner_seen_at} />
        </div>
        <Eyebrow>
          Context
          {context.manifest_version != null && <> · definition v{context.manifest_version}</>}
          {" · "}
          {skillsCount} {skillsCount === 1 ? "skill" : "skills"}
          {sourcesCount > 0 && (
            <>
              {" · "}
              {sourcesCount} {sourcesCount === 1 ? "source" : "sources"}
            </>
          )}
          {budgetMin != null && <> · budget {budgetMin}m</>}
        </Eyebrow>
        {context.description && (
          <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
            {context.description}
          </p>
        )}
      </div>

      <ContextStatusWorkspace
        context={context}
        sessions={sessions ?? []}
        outputs={outputs ?? []}
        outputsPending={outputsPending}
        outputsFailed={outputsFailed}
        onSeeAllOutputs={() => setTab("output")}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          <TabsTrigger value="chat" data-testid="console-tab-chat">
            Chat
          </TabsTrigger>
          <TabsTrigger value="manifest" data-testid="console-tab-manifest">
            Definition
          </TabsTrigger>
          <TabsTrigger value="output" data-testid="console-tab-output">
            Output
          </TabsTrigger>
          {isOwner && (
            <TabsTrigger value="activity" data-testid="console-tab-activity">
              Activity
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent
          value="chat"
          className="flex flex-col gap-4 pt-4 lg:flex-row lg:items-start lg:gap-6"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* A failed sessions load mustn't masquerade as "no conversations yet" — say so and
                let them retry (they can still ask a fresh question below). */}
            {sessionsFailed && !sessions && (
              <LoadError
                layout="inline"
                title="Couldn’t load your conversations"
                description="You can still message it below, or try again."
                testId="console-sessions-retry"
                onRetry={() => refetchSessions()}
              />
            )}
            {mine.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Recent conversations only — the full history is the owner's
                    Activity view, not a chat surface's job. */}
                {mine.slice(0, 6).map((s) => (
                  <Button
                    key={s.id}
                    variant={s.id === active ? "secondary" : "ghost"}
                    size="sm"
                    data-testid="console-session-pick"
                    onClick={() => setPicked(s.id)}
                    className="text-muted-foreground data-[here=true]:text-foreground"
                    data-here={s.id === active}
                  >
                    {ago(s.created_at)}
                    <StateBadge state={s.state} />
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="console-new-session"
                  onClick={() => setPicked("new")}
                  className="text-muted-foreground"
                >
                  <Icon name="plus" /> New chat
                </Button>
              </div>
            )}
            {active ? (
              <SessionThread
                sessionId={active}
                contextId={id}
                contextName={context.name}
                onClosed={() =>
                  qc.invalidateQueries({ queryKey: contextSessionsQuery(id).queryKey })
                }
              />
            ) : (
              <ChatComposer
                contextId={id}
                contextName={context.name}
                tryChips={tryChipsFrom(context.manifest?.md)}
                onAsked={(s) => {
                  setPicked(s.id)
                  qc.invalidateQueries({ queryKey: contextSessionsQuery(id).queryKey })
                }}
              />
            )}
          </div>

          <div className="flex w-full flex-col gap-3 lg:w-72 lg:flex-none">
            <RunnerCard
              context={context}
              isOwner={isOwner}
              rotatedToken={rotatedToken}
              onRotate={() => rotateToken.mutate()}
              rotating={rotateToken.isPending}
              onCopy={() => {
                if (!rotatedToken) return
                void copyText(rotatedToken, { success: "Key copied" })
              }}
              onDoneRotate={() => setRotatedToken(null)}
            />
            {skillsCount > 0 && (
              <SkillsCard skills={context.skills ?? []} onSeeManifest={() => setTab("manifest")} />
            )}
            {sourcesCount > 0 && <SourcesCard count={sourcesCount} />}
            {isOwner && (
              <div className="rounded-xl border bg-card p-3.5">
                <SectionTitle className="mb-2.5">Access</SectionTitle>
                <ContextAccess id={id} name={context.name} policy={context.ask_policy} />
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="manifest" className="pt-4">
          <ManifestTab context={context} />
        </TabsContent>

        <TabsContent value="output" className="pt-4">
          <OutputList contextId={id} />
        </TabsContent>

        {isOwner && (
          <TabsContent value="activity" className="pt-4">
            <ActivityList
              sessions={sessions ?? []}
              onOpen={(sid) => {
                setPicked(sid)
                setTab("chat")
              }}
              onLoadMore={hasNextPage ? () => fetchNextPage() : undefined}
              loadingMore={isFetchingNextPage}
            />
          </TabsContent>
        )}
      </Tabs>
    </PageShell>
  )
}

function ContextOutputCard({
  output,
  testId = "context-now-output",
}: {
  output: ContextOutput
  testId?: string
}) {
  const unreadable = output.title === null
  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          unreadable ? "bg-muted-foreground/35" : "bg-success",
        )}
      />
      <span className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {output.title ?? output.short_id}
          </span>
          <span className="mt-0.5 block text-2xs text-muted-foreground">
            {output.runs} {output.runs === 1 ? "run" : "runs"}
          </span>
        </span>
        {output.version != null ? (
          <span className="shrink-0 rounded-md border border-share/20 bg-share/10 px-1.5 py-0.5 font-mono text-2xs font-semibold text-share">
            v{output.version}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "mt-2 inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-2xs",
          unreadable
            ? "border-border bg-muted/45 text-muted-foreground"
            : "border-success/20 bg-success/10 text-success",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            unreadable ? "bg-muted-foreground/55" : "bg-success",
          )}
        />
        Updated {ago(output.last_run_at)}
      </span>
    </>
  )
  const className = cn(
    "relative min-w-56 overflow-hidden rounded-xl border bg-card p-3 pl-4 text-left transition-colors lg:min-w-0",
    unreadable ? "opacity-60" : "hover:border-primary/35 hover:bg-muted/30",
  )
  return unreadable ? (
    <div className={className} data-testid={`${testId}-unavailable`}>
      {body}
    </div>
  ) : (
    <Link
      to="/artifacts/$ref"
      params={{ ref: output.short_id }}
      data-testid={testId}
      className={className}
    >
      {body}
    </Link>
  )
}

function ContextStatusWorkspace({
  context,
  sessions,
  outputs,
  outputsPending,
  outputsFailed,
  onSeeAllOutputs,
}: {
  context: ContextDetail
  sessions: Session[]
  outputs: ContextOutput[]
  outputsPending: boolean
  outputsFailed: boolean
  onSeeAllOutputs: () => void
}) {
  const summary = contextNowSummary(sessions)
  const runner = runnerStatus(context.runner_seen_at)
  const latest = sessions[0]
  return (
    <section
      className="grid gap-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]"
      data-testid="context-now-workspace"
    >
      <div className="rounded-xl border bg-card p-4">
        <Eyebrow>Now</Eyebrow>
        <h2 className="mt-2 text-base font-medium tracking-tight text-foreground">
          {summary.headline}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-2xs">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5",
              runner.online
                ? "border-success/20 bg-success/10 text-success"
                : runner.away
                  ? "border-warning/20 bg-warning/10 text-warning"
                  : "border-border bg-muted/45 text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                runner.online
                  ? "bg-success"
                  : runner.away
                    ? "bg-warning"
                    : "bg-muted-foreground/50",
              )}
            />
            {runner.online ? "runner ready" : runner.away ? "runner away" : "runner offline"}
          </span>
          {summary.working ? (
            <span className="rounded-md border border-insights/20 bg-insights/10 px-1.5 py-0.5 text-insights">
              {summary.working} working
            </span>
          ) : null}
          {summary.waiting ? (
            <span className="rounded-md border border-warning/20 bg-warning/10 px-1.5 py-0.5 text-warning">
              {summary.waiting} waiting
            </span>
          ) : null}
          {summary.needsReview ? (
            <span className="rounded-md border border-warning/20 bg-warning/10 px-1.5 py-0.5 font-semibold text-warning">
              {summary.needsReview} need review
            </span>
          ) : null}
          {summary.failed ? (
            <span className="rounded-md border border-destructive/20 bg-destructive/10 px-1.5 py-0.5 font-semibold text-destructive">
              {summary.failed} failed
            </span>
          ) : null}
          {context.manifest_version != null ? (
            <span className="rounded-md border border-share/20 bg-share/10 px-1.5 py-0.5 font-semibold text-share">
              definition v{context.manifest_version}
            </span>
          ) : null}
        </div>
        {latest ? (
          <p className="mt-2 text-2xs text-muted-foreground">
            Latest activity {ago(latest.updated_at)} · Context v{latest.context_version ?? "—"}
          </p>
        ) : (
          <p className="mt-2 text-2xs text-muted-foreground">No runs yet.</p>
        )}
      </div>

      <div className="min-w-0 rounded-xl border bg-card p-4" data-testid="context-artifact-shelf">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <div>
            <SectionTitle as="h2">Living artifacts</SectionTitle>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              Latest results stay visible as they evolve
            </p>
          </div>
          {outputs.length > 3 ? (
            <button
              type="button"
              data-testid="context-now-see-all-outputs"
              onClick={onSeeAllOutputs}
              className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              See all {outputs.length} →
            </button>
          ) : (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {outputs.length} total
            </span>
          )}
        </div>
        {outputsPending ? (
          <div className="h-20 animate-pulse rounded-xl bg-muted" />
        ) : outputsFailed ? (
          <div className="rounded-xl border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
            Artifacts unavailable right now
          </div>
        ) : outputs.length ? (
          <div className="flex gap-2 overflow-x-auto pb-1 lg:grid lg:grid-cols-2 lg:overflow-visible lg:pb-0">
            {outputs.slice(0, 3).map((output) => (
              <ContextOutputCard key={output.short_id} output={output} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed px-3 py-5 text-center">
            <p className="text-xs font-medium text-foreground">No published artifacts yet</p>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              A result appears here when a run publishes or updates one.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

// Context access reuses the artifact sharing controls but omits public-link access.
// A Context may expose connected workspace data even when its instruction artifact is public.
const CONTEXT_SEGMENTS: { value: "invited" | "workspace"; label: string; icon: IconName }[] = [
  { value: "invited", label: "Invited", icon: "lock" },
  { value: "workspace", label: "Workspace", icon: "workspace" },
]

function ContextAccess({
  id,
  name,
  policy,
}: {
  id: string
  name: string
  policy: "workspace" | "invited"
}) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const rosterKey = ["context-askers", id] as const
  const { data: roster } = useQuery({
    queryKey: rosterKey,
    queryFn: () => api.listContextAskers(id).then((r) => r.askers),
    enabled: open && policy === "invited",
  })

  // Mutations go through useApiMutation (#361): one place for the error toast +
  // settle-time invalidation, so these can't drift from the app's write contract.
  const policyMut = useApiMutation({
    mutationFn: (next: "workspace" | "invited") => api.setContextAskPolicy(id, next),
    invalidate: [contextQuery(id).queryKey],
  })
  const addMut = useApiMutation({
    mutationFn: (v: string) => api.addContextAsker(id, v),
    invalidate: [rosterKey],
    onSuccess: () => setEmail(""),
  })
  const removeMut = useApiMutation({
    mutationFn: (userId: string) => api.removeContextAsker(id, userId),
    invalidate: [rosterKey],
  })
  const busy = policyMut.isPending || addMut.isPending

  const add = (e?: { preventDefault: () => void }) => {
    e?.preventDefault()
    const v = email.trim()
    if (v) addMut.mutate(v)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Ghost, like the artifact toolbar's non-primary actions; the glyph
            carries the state — lock = invited, people = whole workspace. */}
        <Button
          variant="ghost"
          size="sm"
          data-testid="context-access"
          className="-ml-2 gap-1.5 text-muted-foreground"
        >
          <Icon name={policy === "workspace" ? "workspace" : "lock"} />
          {policy === "workspace" ? "Workspace can ask" : "Invited only"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="line-clamp-1 pr-6">Share “{name}”</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          <div>
            <SectionTitle action={policyMut.isPending && <Spinner className="size-3" />}>
              Who can ask
            </SectionTitle>
            <div className="mt-2 flex flex-col">
              <AccessSegmentToggle
                segments={CONTEXT_SEGMENTS}
                value={policy}
                onChange={(next) => next !== policy && policyMut.mutate(next)}
                disabled={busy}
                testId="context-access-segment"
              />
              <p className="mt-3 text-sm text-muted-foreground">
                {policy === "invited"
                  ? "Only the workspace members you add below can ask."
                  : "Everyone in the workspace can ask. Removing someone from the workspace revokes it automatically."}
              </p>
            </div>
          </div>

          {policy === "invited" && (
            <div>
              <SectionTitle count={roster?.length}>Invited to ask</SectionTitle>
              <form onSubmit={add} className="mt-2 flex items-center gap-2">
                <PersonSearchInput
                  value={email}
                  onChange={setEmail}
                  placeholder="Add a member by @handle or email…"
                  testId="context-asker-add"
                  className="flex-1"
                />
                <Button
                  type="submit"
                  data-testid="context-asker-add-submit"
                  disabled={busy || !email.trim()}
                >
                  Add
                </Button>
              </form>
              <div className="mt-2 flex flex-col">
                {(roster ?? []).map((a) => (
                  <div
                    key={a.user_id}
                    className="flex items-center gap-3 border-t border-border-soft py-2 first:border-t-0"
                  >
                    <span className="truncate text-sm text-foreground">
                      {a.username ? `@${a.username}` : a.user_id}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="context-asker-remove"
                      onClick={() => removeMut.mutate(a.user_id)}
                      className="ml-auto text-muted-foreground"
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                {roster?.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">
                    No one invited yet. Only you can ask.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="lock" className="size-3.5" />
            Workspace members only. People outside this workspace cannot use the Context.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Runner availability is derived from the queue poll timestamp; there is no separate heartbeat.
// Thresholds follow the write path:
// the runner polls ~5s but the server stamps at most once a minute, so online
// = seen within 90s (throttle + grace); within 10 minutes reads as recently
// seen; anything older (or never) is offline.
function RunnerLiveness({ seenAt }: { seenAt: string | null }) {
  // Re-evaluate on a clock, not only on refetch: a dead runner stops CHANGING
  // the stamp, and unchanged query data never re-renders this component.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const status = runnerStatus(seenAt)
  // Same words as the card below it (RunnerCard): one state should not have two names on one
  // page, and "runner online" names our machinery rather than what it means for the reader.
  const [dot, label] = status.online
    ? ["bg-success", "taking on work"]
    : status.away
      ? ["bg-warning", `last here ${ago(seenAt as string)}`]
      : ["bg-muted-foreground", `not taking on work${seenAt ? `; last here ${ago(seenAt)}` : ""}`]
  return (
    <span
      data-testid="console-runner-liveness"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={status.title}
    >
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  )
}

// The rail's "Doing work" card — the "runs from your own machine" story, everyone reads it;
// the commands and the key live below a hairline, owner-only. Presence and last-seen read as
// messenger grammar on purpose: a context runs wherever its owner runs it, and offline is its
// normal resting state, not an outage.
//
// WORDED FOR SOMEONE WHO ARRIVED FROM THE GUIDED BUILDER, where most first-timers come from.
// They never met a runner, a token or a queue, so every line here answers one of two questions —
// what does this state MEAN for me, and why would I need this — before it shows a command. The
// commands themselves stay verbatim: those are things to paste, not things to read, and
// rewriting them into prose would leave nothing that works.
function RunnerCard({
  context,
  isOwner,
  rotatedToken,
  onRotate,
  rotating,
  onCopy,
  onDoneRotate,
}: {
  context: ContextDetail
  isOwner: boolean
  rotatedToken: string | null
  onRotate: () => void
  rotating: boolean
  onCopy: () => void
  onDoneRotate: () => void
}) {
  const seenAt = context.runner_seen_at
  const state = runnerStatus(seenAt)
  const [dot, status] = state.online
    ? ["bg-success", `taking on work now; checked ${ago(seenAt as string)}`]
    : state.away
      ? ["bg-warning", `quiet just now; last here ${ago(seenAt as string)}`]
      : [
          "bg-muted-foreground",
          seenAt ? `not taking on work; last here ${ago(seenAt)}` : "not set up to take on work",
        ]

  return (
    <div
      className="flex flex-col gap-2.5 rounded-xl border bg-card p-3.5"
      data-testid="rail-runner"
    >
      <SectionTitle>Doing work</SectionTitle>
      <div className="flex items-center gap-1.5 text-xs text-foreground">
        <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
        {status}
      </div>
      <p className="text-xs text-muted-foreground">
        Reading this Context always works. Running a task is different: an agent does that work on a
        connected machine.{" "}
        {state.online
          ? "One is connected, so tasks usually come back within minutes."
          : "None is connected right now, so tasks wait in line and run once one is."}
      </p>
      {isOwner && (
        <div className="flex flex-col gap-2">
          <Eyebrow as="h4">Use your own agent</Eyebrow>
          <div>
            <p className="text-2xs text-muted-foreground">
              Start a task with this Context in Chat above or from your coding session:
            </p>
            <code className="mt-1 block overflow-x-auto rounded-md bg-secondary px-2 py-1 font-mono text-2xs text-foreground">
              use({"{"} context: "{context.name}", instruction: "…" {"}"})
            </code>
          </div>
          <div>
            <p className="text-2xs text-muted-foreground">
              From that same session, run the command below to pick up waiting work. There is
              nothing to install and no key to copy. It stops when the queue is empty:
            </p>
            <code className="mt-1 block overflow-x-auto rounded-md bg-secondary px-2 py-1 font-mono text-2xs text-foreground">
              use({"{"} context: "{context.name}" {"}"})
            </code>
          </div>
          <div>
            <p className="text-2xs text-muted-foreground">
              Or leave a machine connected all the time, so tasks are picked up while you are away.
              That one needs the key below:
            </p>
            <code className="mt-1 block overflow-x-auto rounded-md bg-secondary px-2 py-1 font-mono text-2xs text-foreground">
              derive runner serve {context.id}
            </code>
          </div>
          {context.max_run_ms != null && (
            <p className="text-2xs text-muted-foreground">
              One task gets up to {Math.round(context.max_run_ms / 60_000)} minutes, and{" "}
              {context.max_concurrency ?? 1}{" "}
              {context.max_concurrency === 1 ? "task runs" : "tasks run"} at a time.
            </p>
          )}
          <div className="flex flex-col gap-1.5 pt-1">
            <Button
              data-testid="console-rotate-token"
              variant="outline"
              size="sm"
              onClick={onRotate}
              loading={rotating}
              disabled={rotating}
              className="self-start"
            >
              Replace the key
            </Button>
            <p className="text-2xs text-muted-foreground">
              Use this if the key was shared by mistake. The old one stops working straight away;
              anything you run from your own session is unaffected.
            </p>
          </div>
          {rotatedToken && (
            <div data-testid="console-rotated-token">
              <StatusPanel
                tone="warning"
                layout="inline"
                title="Copy this new key now. It will not be shown again, and the old key no longer works."
                description={
                  <div className="flex flex-col gap-1.5">
                    <code className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground">
                      {rotatedToken}
                    </code>
                    <span className="text-2xs text-muted-foreground">
                      Put it wherever the always-on machine reads it from (usually{" "}
                      <code className="font-mono">.derive/agent-token</code>) and start it again.
                    </span>
                  </div>
                }
                action={
                  <div className="flex items-center gap-2">
                    <Button
                      data-testid="console-rotated-copy"
                      variant="secondary"
                      size="sm"
                      onClick={onCopy}
                    >
                      Copy
                    </Button>
                    <Button
                      data-testid="console-rotated-done"
                      variant="ghost"
                      size="sm"
                      onClick={onDoneRotate}
                    >
                      Done
                    </Button>
                  </div>
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SkillsCard({
  skills,
  onSeeManifest,
}: {
  skills: ManifestSkillInfo[]
  onSeeManifest: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-3.5" data-testid="rail-skills">
      <SectionTitle count={skills.length}>Skills</SectionTitle>
      <ul className="flex flex-col gap-1.5">
        {skills.slice(0, 6).map((s) => (
          <li key={s.short_id} className="flex items-center gap-2 text-sm text-foreground">
            <Link
              to="/artifacts/$ref"
              params={{ ref: s.short_id }}
              className="min-w-0 truncate underline-offset-4 hover:underline"
              data-testid={`rail-skill-${s.short_id}`}
            >
              {s.title ?? s.short_id}
            </Link>
            <span
              className={cn(
                "ml-auto shrink-0 font-mono text-2xs tabular-nums",
                s.stale ? "text-warning" : "text-muted-foreground",
              )}
            >
              {s.pinned == null
                ? "unpinned"
                : s.stale
                  ? `v${s.pinned} → v${s.current}`
                  : `v${s.pinned}`}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="rail-see-manifest"
        onClick={onSeeManifest}
        className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        View Context definition →
      </button>
    </div>
  )
}

function SourcesCard({ count }: { count: number }) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border bg-card p-3.5"
      data-testid="rail-sources"
    >
      <SectionTitle count={count}>Sources</SectionTitle>
      <p className="text-xs text-muted-foreground">
        {count === 1 ? "One connection" : `${count} connections`} this Context may use as tools.
      </p>
    </div>
  )
}

// The Context definition, framed as a package rather than a raw document: pin health (each
// skill's pinned version against its actual current one), the frontmatter's repo
// pointers, and the body as a doc — the YAML never renders raw, because a human
// reading "id: cd34y version: 3" learns nothing a title + a status column can't say
// better. "Open as artifact ↗" keeps history, comments, and raw source one click away.
function ManifestTab({ context }: { context: ContextDetail }) {
  const manifest = context.manifest
  const skills = context.skills ?? []
  const staleCount = skills.filter((s) => s.stale).length
  if (!manifest) {
    return (
      <EmptyState
        icon={<Icon name="context" strokeWidth={1.75} />}
        title="No definition"
        description="This Context's definition artifact can't be resolved."
      />
    )
  }
  return (
    <div className="flex flex-col gap-6" data-testid="manifest-tab">
      <div className="flex flex-wrap items-center gap-3">
        <Eyebrow>
          definition · {manifest.title ?? context.name} · v{manifest.version} · pushed{" "}
          {ago(manifest.pushed_at)}
        </Eyebrow>
        <Link
          to="/artifacts/$ref"
          params={{ ref: manifest.short_id }}
          data-testid="manifest-open-artifact"
          className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Open as artifact ↗
        </Link>
      </div>

      {skills.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <SectionTitle
            action={
              staleCount > 0 ? (
                <span className="font-mono text-2xs text-warning">
                  ▲ {staleCount} {staleCount === 1 ? "pin" : "pins"} behind
                </span>
              ) : (
                <span className="font-mono text-2xs text-muted-foreground">all pins current</span>
              )
            }
          >
            Skills · {skills.length}
          </SectionTitle>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-card">
                  <Eyebrow as="th" className="px-3.5 py-2 text-left">
                    Skill
                  </Eyebrow>
                  <Eyebrow as="th" className="px-3.5 py-2 text-left">
                    Pinned
                  </Eyebrow>
                  <Eyebrow as="th" className="px-3.5 py-2 text-left">
                    Current
                  </Eyebrow>
                  <Eyebrow as="th" className="px-3.5 py-2 text-left">
                    Status
                  </Eyebrow>
                </tr>
              </thead>
              <tbody>
                {skills.map((s) => (
                  <tr
                    key={s.short_id}
                    className={cn(
                      "border-b border-border-soft last:border-0",
                      s.stale && "bg-warning/5",
                    )}
                  >
                    <td className="px-3.5 py-2">
                      <Link
                        to="/artifacts/$ref"
                        params={{ ref: s.short_id }}
                        data-testid="manifest-skill-link"
                        className="text-foreground hover:underline"
                      >
                        {s.title ?? s.short_id}
                      </Link>{" "}
                      <span className="font-mono text-2xs text-muted-foreground">{s.short_id}</span>
                    </td>
                    <td className="px-3.5 py-2 font-mono text-xs tabular-nums text-muted-foreground">
                      {s.pinned ?? "Not set"}
                    </td>
                    <td className="px-3.5 py-2 font-mono text-xs tabular-nums text-muted-foreground">
                      {s.current ?? "Not set"}
                    </td>
                    <td
                      className={cn(
                        "px-3.5 py-2 text-xs",
                        s.stale ? "text-warning" : "text-muted-foreground",
                      )}
                    >
                      {s.pinned == null
                        ? "unpinned"
                        : s.stale
                          ? `▲ ${(s.current as number) - s.pinned} behind`
                          : "current"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            A pin is exact. The runner uses the pinned version, not the latest one.{" "}
            <code className="font-mono">derive context push</code> re-pins to current and publishes
            a new definition version; the runner picks it up on its next pull. No deploy.
          </p>
        </div>
      )}

      {context.repos && context.repos.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionTitle count={context.repos.length}>Repos</SectionTitle>
          <ul className="flex flex-col gap-1">
            {context.repos.map((r) => (
              <li key={r.url} className="flex items-center gap-2 font-mono text-sm text-foreground">
                <Icon name="repo" size={14} className="text-muted-foreground" />
                {r.url}
                {r.ref && <span className="text-muted-foreground">@{r.ref}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <SectionTitle>Document</SectionTitle>
        <div
          className={ANSWER_PROSE}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized in answerMdToHtml (xss whitelist).
          dangerouslySetInnerHTML={{ __html: answerMdToHtml(stripFrontmatter(manifest.md)) }}
        />
      </div>
    </div>
  )
}

// Message it the first time — the empty-conversation state. The manifest's own
// scopes surface as `try` chips: click to prefill, never to send, so a first-time
// visitor learns the vocabulary without reading a page.
function ChatComposer({
  contextId,
  contextName,
  tryChips,
  onAsked,
}: {
  contextId: string
  contextName: string
  tryChips: string[]
  onAsked: (s: Session) => void
}) {
  const [text, setText] = useState("")
  const ask = useApiMutation({
    mutationFn: () => api.askContext(contextId, text.trim()),
    onSuccess: (r) => {
      setText("")
      onAsked(r.session)
    },
  })
  const submit = () => {
    if (text.trim()) ask.mutate()
  }
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        data-testid="console-ask-input"
        aria-label="Message"
        placeholder={`Message ${contextName} about new work or a past run.`}
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit()
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {tryChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Eyebrow>try</Eyebrow>
            {tryChips.map((chip) => (
              <button
                key={chip}
                type="button"
                data-testid="console-try-chip"
                onClick={() => setText(chip)}
                className="rounded-full bg-secondary px-2.5 py-1 font-mono text-xs text-foreground hover:bg-accent"
              >
                {chip}
              </button>
            ))}
          </div>
        )}
        <Button
          data-testid="console-ask-submit"
          onClick={submit}
          loading={ask.isPending}
          disabled={ask.isPending || !text.trim()}
          className="ml-auto"
        >
          Send
        </Button>
      </div>
    </div>
  )
}

// One conversation: transcript + follow-up composer + close.
function SessionThread({
  sessionId,
  contextId,
  contextName,
  onClosed,
}: {
  sessionId: string
  contextId: string
  contextName: string
  onClosed: () => void
}) {
  const { me } = useAuth()
  const qc = useQueryClient()
  const { data, isError } = useQuery(sessionQuery(sessionId))
  const [text, setText] = useState("")
  // The picker pills read the sessions LIST; the transcript polls its own key.
  // Sync the list whenever this session's state settles, so a pill never keeps
  // saying "open" after the answer has already rendered below it. Output goes with
  // it: the turn that settles is the turn that may have bound a result artifact.
  const state = data?.session.state
  useEffect(() => {
    if (state && state !== "open") {
      qc.invalidateQueries({ queryKey: contextSessionsQuery(contextId).queryKey })
      qc.invalidateQueries({ queryKey: contextOutputsQuery(contextId).queryKey })
    }
  }, [state, contextId, qc])
  const refresh = () => qc.invalidateQueries({ queryKey: sessionQuery(sessionId).queryKey })
  // The server already publishes these on the same per-user SSE stream the notification
  // bell uses (contexts.ts settleWake/progressWake) — react to them instead of waiting out
  // sessionQuery's poll interval, so a reply that lands between polls shows up at once
  // instead of quantised to the next tick.
  //
  // Subscribed while the session is UNSETTLED, which is deliberately wider than the poll's
  // `open`: a runner that claims a session flips it to `working`, and sessionQuery stops
  // polling there, so a `working` transcript had nothing refreshing it at all. Those are
  // exactly the long runs that emit `session.progress`. The push covers that gap for free —
  // the EventSource is already open for the notification bell, so this adds no requests.
  //
  // Where the poll IS running (`open`) it stays on as the fallback for a missed event or a
  // dropped stream: this shortens the common case, it does not replace the safety net.
  //
  // SCOPE: this file is the CONTEXT CONSOLE. The chat rail on an artifact is a separate
  // surface — `use-artifact-chat.ts`, plain fetch into local state, on its own poll — and it
  // subscribes to these same events itself. The two implement one contract in two places;
  // keep them in step.
  //
  // WHICH TURNS ACTUALLY PUSH (verified on the PR preview, not inferred): only a turn that
  // goes through the runner report path or a close/fail — contexts.ts calls settleWake /
  // progressWake there and nowhere else. `serveAttended`, which serves an Ask answered
  // in-process by the model, settles the session WITHOUT publishing anything, so on that
  // path these subscriptions sat idle and the poll did all the work.
  //
  // THAT GAP IS NOW CLOSED: serveAttended publishes `session.settled` when it finishes, and
  // streams the answer as `session.delta` on the way (see routes/contexts.ts). So both kinds
  // of turn — a real runner reporting, and an Ask answered in-process — push here.
  const visible = usePageVisible()
  const pushRefresh = (e: MessageEvent) => {
    let payload: { session_id?: string }
    try {
      payload = JSON.parse(e.data) as { session_id?: string }
    } catch {
      return
    }
    if (payload.session_id === sessionId) refresh()
  }
  const unsettled = state === "open" || state === "working"
  const pushEnabled = !!me && visible && unsettled
  useUserEvent("session.settled", pushRefresh, pushEnabled)
  useUserEvent("session.progress", pushRefresh, pushEnabled)

  // The answer as it is being written. Same contract as the artifact chat rail: a VIEW only,
  // never persisted, replaced by the transcript row the moment the turn settles. Anything not
  // strictly newer than the last slice is dropped, so a reconnect redelivering one is a no-op.
  // The accumulation rules are shared with the artifact chat rail (lib/session-delta.ts) so the
  // two surfaces cannot drift — they did once, and only one of them was right.
  const [delta, setDelta] = useState<DeltaState>(EMPTY_DELTA)
  const streaming = delta.text
  useUserEvent(
    "session.delta",
    (e) => setDelta((s) => applyDelta(s, e.data, sessionId)),
    pushEnabled,
  )
  // Drop the provisional text once the persisted reply is in the transcript, so the two are
  // never on screen together. Keyed on the message COUNT: a settling turn appends the agent's
  // row, which is exactly the moment the streamed copy stops being the freshest thing here.
  const agentCount = (data?.messages ?? []).filter((m) => m.author_kind === "agent").length
  // agentCount is the CHANGE SIGNAL to clear on, not a value the body reads — the same shape
  // as the reset effects elsewhere in this file, and the rule cannot see the difference.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset trigger, see above
  useEffect(() => {
    setDelta(EMPTY_DELTA)
  }, [agentCount])
  // Post a follow-up / close the conversation. Defined ABOVE the `!data` guard so the
  // hooks run unconditionally (a hook can't sit below an early return).
  const post = useApiMutation({
    mutationFn: () => api.postSessionMessage(sessionId, text.trim()),
    onSuccess: () => {
      setText("")
      refresh()
    },
  })
  const closeMut = useApiMutation({
    mutationFn: () => api.closeSession(sessionId),
    // A genuine close failure surfaces via the safety net (the old errorToast:false swallowed
    // real network/500 errors too, not just the benign already-closed race).
    onSuccess: () => {
      refresh()
      onClosed()
    },
  })
  // `isError && !data`: only when the FIRST load fails (no transcript yet). A background-poll
  // blip sets isError while `data` is retained — don't replace a live transcript with an error
  // screen; it self-heals on the next poll.
  if (isError && !data)
    return (
      <LoadError
        layout="inline"
        title="Couldn’t load this conversation"
        description="Try again in a moment."
        testId="console-retry"
        onRetry={refresh}
        className="mt-8"
      />
    )
  if (!data) return <Spinner className="mx-auto mt-8" />
  const { session, messages } = data
  // Only the asker may post (the server 404s anyone else) — the owner reads
  // someone else's session from Activity and can close it, nothing more.
  const isMine = session.asker_id === me?.id
  const send = () => {
    // Guards the keyboard path too — Cmd+Enter must respect the same turn gate as the
    // disabled Send button.
    if (text.trim() && !post.isPending && session.state !== "open") post.mutate()
  }
  const close = () => closeMut.mutate()
  const lastAgentIdx = messages.map((m) => m.author_kind).lastIndexOf("agent")

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3" data-testid="console-thread">
        {messages.map((m, i) => (
          <div key={m.id} className="flex flex-col gap-2">
            <MessageRow m={m} contextName={contextName} />
            {i === lastAgentIdx && session.result_artifact_id && (
              <ResultChip shortId={session.result_artifact_id} />
            )}
          </div>
        ))}
        {/* The answer mid-write. Plain text with preserved whitespace, not the markdown the
            settled row renders: a half-arrived reply is half-arrived markup too, and running
            each slice through the renderer makes it visibly thrash as it completes. */}
        {streaming && (
          <div className="flex flex-col gap-1 px-1" data-testid="console-streaming">
            <Eyebrow>{contextName}</Eyebrow>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {streaming}
              <span className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 animate-pulse bg-foreground/70" />
            </p>
          </div>
        )}
        {/* The spinner is what you show when there is NOTHING yet. Once text is arriving it
            would read as a second, stalled turn sitting under a reply that is visibly moving. */}
        {session.state === "open" && !streaming && (
          <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <Spinner size="sm" tone="current" data-testid="console-waiting" />
            Waiting for the runner to pick this up.
          </div>
        )}
        {session.state === "failed" && (
          <p className="px-1 text-sm text-destructive" data-testid="console-failed">
            The run failed. Give it again, or check the runner's log.
          </p>
        )}
      </div>

      {session.state === "closed" ? (
        <p className="text-sm text-muted-foreground">This conversation is closed.</p>
      ) : isMine ? (
        <div className="flex flex-col gap-2">
          <Textarea
            data-testid="console-followup-input"
            aria-label="Follow-up"
            placeholder="Follow up…"
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send()
            }}
          />
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              data-testid="console-close-session"
              onClick={close}
              className="text-muted-foreground"
            >
              Close conversation
            </Button>
            <Button
              data-testid="console-followup-submit"
              onClick={send}
              loading={post.isPending}
              disabled={post.isPending || !text.trim() || session.state === "open"}
            >
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            data-testid="console-close-session"
            onClick={close}
            className="text-muted-foreground"
          >
            Close conversation
          </Button>
        </div>
      )}
    </div>
  )
}

// A session's bound result artifact — republished each run, so its own version
// history is the trend line. Renders once, right after the answer that bound it.
function ResultChip({ shortId }: { shortId: string }) {
  const { data } = useQuery({ ...artifactQuery(shortId), enabled: !!shortId })
  const currentVersion = data?.versions.find((version) => version.n === data.current_version)
  return (
    <div className="ml-1 flex flex-col gap-0.5">
      <Link
        to="/artifacts/$ref"
        params={{ ref: shortId }}
        data-testid="console-result-chip"
        className="relative inline-flex w-fit items-center gap-2 overflow-hidden rounded-lg border bg-secondary px-3 py-1.5 pl-4 text-sm font-medium text-foreground hover:bg-accent"
      >
        <span className="absolute inset-y-0 left-0 w-1 bg-success" aria-hidden="true" />
        <Icon name="all" size={14} className="text-muted-foreground" />
        {data?.title ?? shortId}
        {data?.current_version != null && (
          <span className="rounded-md border border-share/20 bg-share/10 px-1.5 py-0.5 font-mono text-2xs font-semibold text-share">
            v{data.current_version}
          </span>
        )}
        {currentVersion ? (
          <span className="font-mono text-2xs text-success">
            updated {ago(currentVersion.created_at)}
          </span>
        ) : null}
      </Link>
      <span className="text-2xs text-muted-foreground">
        Living artifact · republished after each run
      </span>
    </div>
  )
}

const confidenceTone = (confidence: number): string => {
  if (confidence >= 0.85) return "border-success/20 bg-success/10 text-success"
  if (confidence < 0.6) return "border-warning/20 bg-warning/10 text-warning"
  return "border-insights/20 bg-insights/10 text-insights"
}

// meta is runner-supplied and schema-free on the server (deliberately, for
// forward compat) — so the renderer must not trust its shape. A malformed blob
// would otherwise throw during render and brick the transcript for BOTH
// participants, permanently (the message is persisted). Narrow every field here.
function safeMeta(meta: SessionMeta | null) {
  const m = meta && typeof meta === "object" ? meta : {}
  return {
    query: typeof m.query === "string" ? m.query : null,
    confidence: typeof m.confidence === "number" ? m.confidence : null,
    escalation: typeof m.escalation_reason === "string" ? m.escalation_reason : null,
    caveats: Array.isArray(m.caveats) ? m.caveats.filter((c) => typeof c === "string") : [],
    artifacts: Array.isArray(m.artifacts)
      ? m.artifacts.filter(
          (a) => a && typeof a.short_id === "string" && typeof a.title === "string",
        )
      : [],
  }
}

function MessageRow({ m, contextName }: { m: SessionMessage; contextName: string }) {
  const [showQuery, setShowQuery] = useState(false)
  const { copied, copy } = useCopy()
  const fromAgent = m.author_kind === "agent"
  const meta = safeMeta(m.meta)
  // Answers travel onward as markdown (into docs, Slack, a PR) — copy the
  // SOURCE, not the rendered text.
  const copyMd = () => void copy(m.body_md, { error: "Couldn't copy" })
  return (
    <div
      data-testid="console-message"
      className={cn("rounded-xl px-4 py-3", fromAgent ? "border bg-card" : "bg-secondary")}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">{fromAgent ? contextName : "You"}</span>
        <span>{ago(m.created_at)}</span>
        {fromAgent && (
          <Button
            variant="ghost"
            size="icon-xs"
            data-testid="console-copy-md"
            aria-label="Copy answer as markdown"
            onClick={copyMd}
            className="text-muted-foreground"
          >
            {copied ? <Icon name="check" className="text-success" /> : <CopyIcon />}
          </Button>
        )}
        {meta.escalation && (
          <Badge variant="warning" data-testid="console-escalated">
            Escalated: {meta.escalation}
          </Badge>
        )}
        {meta.confidence !== null && (
          <span
            className={cn(
              "ml-auto rounded-md border px-1.5 py-0.5 font-mono text-2xs tabular-nums",
              confidenceTone(meta.confidence),
            )}
          >
            confidence {Math.round(meta.confidence * 100)}%
          </span>
        )}
      </div>
      {fromAgent ? (
        <div
          className={ANSWER_PROSE}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized in answerMdToHtml (xss whitelist).
          dangerouslySetInnerHTML={{ __html: answerMdToHtml(m.body_md) }}
        />
      ) : (
        <div
          className="cmt-body text-sm [word-break:break-word]"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped first in mdToHtml.
          dangerouslySetInnerHTML={{ __html: mdToHtml(m.body_md) }}
        />
      )}
      {meta.artifacts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {meta.artifacts.map((a) => (
            <Link
              key={a.short_id}
              to="/artifacts/$ref"
              params={{ ref: a.short_id }}
              data-testid="console-artifact-link"
              className="flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Icon name="all" size={14} className="text-muted-foreground" />
              {a.title}
            </Link>
          ))}
        </div>
      )}
      {meta.caveats.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {meta.caveats.map((c) => (
            <li key={c} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3 shrink-0 text-warning" />
              {c}
            </li>
          ))}
        </ul>
      )}
      {meta.query && (
        <div className="mt-2">
          <Button
            variant="link"
            size="xs"
            data-testid="console-query-toggle"
            onClick={() => setShowQuery((v) => !v)}
            className="px-0 text-muted-foreground"
          >
            {showQuery ? "Hide query" : "Show query"}
          </Button>
          {showQuery && (
            <pre className="mt-1 overflow-x-auto rounded-lg bg-secondary p-2.5 font-mono text-xs">
              {meta.query}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// Owners can page through the complete session history, newest first.
function ActivityList({
  sessions,
  onOpen,
  onLoadMore,
  loadingMore,
}: {
  sessions: Session[]
  onOpen: (id: string) => void
  /** Undefined once the list is exhausted — the button disappears rather than no-ops. */
  onLoadMore?: () => void
  loadingMore?: boolean
}) {
  if (sessions.length === 0)
    return <EmptyState title="No sessions yet" description="The first message starts the record." />
  return (
    <ul className="flex flex-col">
      {sessions.map((s) => (
        <li
          key={s.id}
          className="flex items-center gap-3 border-b px-1 py-2.5 text-sm last:border-0 hover:bg-accent"
        >
          {/* A Link can't nest inside a button (invalid HTML, and the result link needs its
              own navigation) — the row's open-chat click zone and the result link are siblings,
              not parent/child; the result link stops propagation so it navigates instead of
              also opening the thread underneath it. */}
          <button
            type="button"
            data-testid="console-activity-row"
            onClick={() => onOpen(s.id)}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <span className="text-foreground">{ago(s.created_at)}</span>
            {s.asker_username && <span className="text-muted-foreground">@{s.asker_username}</span>}
            <StateBadge state={s.state} />
            {s.lane === "local" && (
              <Badge variant="default" shape="pill" className="text-2xs">
                local
              </Badge>
            )}
          </button>
          <span className="font-mono text-xs text-muted-foreground">v{s.context_version}</span>
          {s.result_artifact_id && (
            <Link
              to="/artifacts/$ref"
              params={{ ref: s.result_artifact_id }}
              data-testid="console-activity-result"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              <Icon name="all" size={12} />
              result
            </Link>
          )}
        </li>
      ))}
      {onLoadMore && (
        <li className="pt-3">
          <Button
            variant="outline"
            size="sm"
            data-testid="console-activity-more"
            onClick={onLoadMore}
            loading={loadingMore}
            disabled={loadingMore}
          >
            Load more
          </Button>
        </li>
      )}
    </ul>
  )
}

// WHAT THIS CONTEXT HAS PRODUCED — its body of work, not its conversation log. One row
// per artifact however many runs bound it, so a report republished nightly reads as one
// living document with a run count rather than fifty identical rows.
function OutputList({ contextId }: { contextId: string }) {
  const { data: outputs, isPending, isError, refetch } = useQuery(contextOutputsQuery(contextId))
  if (isPending) return <ContextRowsSkeleton />
  if (isError)
    return (
      <LoadError
        layout="inline"
        title="Couldn’t load this Context’s output"
        description="Try again in a moment."
        testId="console-output-retry"
        onRetry={() => refetch()}
      />
    )
  if (!outputs || outputs.length === 0)
    return (
      <EmptyState
        icon={<Icon name="all" strokeWidth={1.75} />}
        title="Nothing published yet"
        description="Published results appear here. Each document has one row, even when it took several runs."
      />
    )
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {outputs.map((output) => (
        <ContextOutputCard key={output.short_id} output={output} testId="console-output-row" />
      ))}
    </div>
  )
}

// Six real states, told apart with the tokens the app already has — never a new
// color. "queued" isn't a server state; the runner explains its own absence in the
// rail, so the picker/Activity pill stays the honest "waiting" either way.
const STATE_BADGE: Record<
  Session["state"],
  {
    variant: NonNullable<Parameters<typeof badgeVariants>[0]>["variant"]
    label: string
    className?: string
  }
> = {
  open: {
    variant: "outline",
    label: "waiting",
    className: "border-warning/25 bg-warning/10 text-warning",
  },
  working: {
    variant: "outline",
    label: "working",
    className: "border-insights/25 bg-insights/10 text-insights",
  },
  answered: { variant: "success", label: "answered" },
  escalated: { variant: "warning", label: "escalated" },
  failed: { variant: "destructive", label: "failed" },
  closed: { variant: "default", label: "closed" },
}

function StateBadge({ state }: { state: Session["state"] }) {
  const cfg = STATE_BADGE[state]
  return (
    <Badge variant={cfg.variant} shape="pill" className={cn("gap-1 text-xs", cfg.className)}>
      {state === "working" && (
        <Spinner size="sm" tone="current" className="size-2.5 border-[1.5px]" aria-hidden />
      )}
      {cfg.label}
    </Badge>
  )
}
