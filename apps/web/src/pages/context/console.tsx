import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams } from "@tanstack/react-router"
import { Copy as CopyIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { ApiError, api, type Session, type SessionMessage, type SessionMeta } from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { AccessSegmentToggle } from "@/components/shared/access-segment-toggle"
import { EmptyState } from "@/components/shared/empty-state"
import { PageShell } from "@/components/shared/page-shell"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { contextQuery, contextSessionsQuery, sessionQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { usePageVisible } from "@/lib/use-page-visible"
import { useUserEvent } from "@/lib/use-user-events"
import { cn } from "@/lib/utils"
import { mdToHtml } from "../artifact/lib/markdown"
import { ConsolePending } from "./context-skeleton"
import { answerMdToHtml } from "./lib/answer-md"

// The context console: ask, read the answer (with the query/confidence/caveats the
// runner attaches), follow up. One conversation at a time — older sessions are a
// picker away; the owner additionally gets the activity view. The transcript polls
// fast only while the runner owes a reply (sessionQuery's refetchInterval), and refetches
// immediately on the server's session.settled/session.progress push (SessionThread) —
// the poll is the fallback, the push is what makes a reply land without waiting out
// the interval.
export function ContextConsole() {
  const { id } = useParams({ from: "/contexts/$id" })
  // Keyed by context id: the router keeps this route's component mounted across
  // /contexts/A → /contexts/B, and a `picked` session id from A must not
  // survive into B's console.
  return <Console key={id} id={id} />
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
    data: sessions,
    isError: sessionsFailed,
    refetch: refetchSessions,
  } = useQuery(contextSessionsQuery(id))
  // The tab names the context; base title while it loads (or on no-access).
  useDocumentTitle(context?.name ?? null)

  // The session on screen: sticky once picked; defaults to the most recent.
  const [picked, setPicked] = useState<string | null>(null)
  // Controlled tabs so the Activity view can hand a session to the Ask view —
  // with defaultValue the row click would select a thread inside a hidden tab.
  const [tab, setTab] = useState("ask")
  const mine = (sessions ?? []).filter((s) => s.asker_id === me?.id)
  const active = picked === "new" ? null : (picked ?? mine[0]?.id ?? null)
  const isOwner = !!context && context.created_by === me?.id
  // Rotate the context's agent token — the recovery path for a lost runner token
  // (managed agents are hidden from the Settings roster, so this is their only
  // credential surface). Admin-gated server-side; a non-admin owner gets a loud
  // 403 toast, never a silent no-op. Shown exactly once, like every token.
  const [rotatedToken, setRotatedToken] = useState<string | null>(null)
  const rotateToken = useApiMutation({
    mutationFn: () => api.rotateAgent(context?.agent_id ?? ""),
    success: "Runner token rotated — the old one is dead",
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
              ? "Ask this context's owner to give you access — only workspace members they invite can ask it."
              : "Something went wrong loading this context. Try again in a moment."
          }
        />
      </PageShell>
    )
  }
  if (!context || isLoading) return <ConsolePending />

  return (
    <PageShell className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="context" className="text-muted-foreground" />
        <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
          {context.name}
        </h1>
        <RunnerLiveness seenAt={context.runner_seen_at} />
        <div className="ml-auto flex items-center gap-3">
          {isOwner && <ContextAccess id={id} name={context.name} policy={context.ask_policy} />}
          {isOwner && (
            <Button
              data-testid="console-rotate-token"
              variant="ghost"
              size="sm"
              onClick={() => rotateToken.mutate()}
              loading={rotateToken.isPending}
              disabled={rotateToken.isPending}
            >
              Rotate token
            </Button>
          )}
          {isOwner && context.manifest_short_id && (
            <Link
              to="/artifacts/$ref"
              params={{ ref: context.manifest_short_id }}
              data-testid="console-manifest-link"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              Manifest ↗
            </Link>
          )}
        </div>
      </div>

      {rotatedToken && (
        <div data-testid="console-rotated-token">
          <StatusPanel
            tone="warning"
            layout="inline"
            title="New runner token — copy it now, it won't be shown again. The old one is dead."
            description={
              <div className="flex flex-col gap-1.5">
                <code className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground">
                  {rotatedToken}
                </code>
                <span className="text-2xs text-muted-foreground">
                  Update it where the runner reads it (e.g.{" "}
                  <code className="font-mono">.derive/agent-token</code>) and restart the runner.
                </span>
              </div>
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  data-testid="console-rotated-copy"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(rotatedToken)
                    toast.success("Token copied")
                  }}
                >
                  Copy
                </Button>
                <Button
                  data-testid="console-rotated-done"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRotatedToken(null)}
                >
                  Done
                </Button>
              </div>
            }
          />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          <TabsTrigger value="ask" data-testid="console-tab-ask">
            Ask
          </TabsTrigger>
          {isOwner && (
            <TabsTrigger value="activity" data-testid="console-tab-activity">
              Activity
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="ask" className="flex flex-col gap-4 pt-4">
          {/* A failed sessions load mustn't masquerade as "no conversations yet" — say so and
              let them retry (they can still ask a fresh question below). */}
          {sessionsFailed && !sessions && (
            <StatusPanel
              tone="danger"
              layout="inline"
              title="Couldn't load your conversations"
              description="You can still ask below, or try again."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="console-sessions-retry"
                  onClick={() => refetchSessions()}
                >
                  Try again
                </Button>
              }
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
                <Icon name="plus" /> New question
              </Button>
            </div>
          )}
          {active ? (
            <SessionThread
              sessionId={active}
              contextId={id}
              contextName={context.name}
              onClosed={() => qc.invalidateQueries({ queryKey: contextSessionsQuery(id).queryKey })}
            />
          ) : (
            <AskComposer
              contextId={id}
              onAsked={(s) => {
                setPicked(s.id)
                qc.invalidateQueries({ queryKey: contextSessionsQuery(id).queryKey })
              }}
            />
          )}
        </TabsContent>

        {isOwner && (
          <TabsContent value="activity" className="pt-4">
            <ActivityList
              sessions={sessions ?? []}
              onOpen={(sid) => {
                setPicked(sid)
                setTab("ask")
              }}
            />
          </TabsContent>
        )}
      </Tabs>
    </PageShell>
  )
}

// Who may ASK — the context's own workspace-scoped grant, built to feel like the
// artifact Share dialog (same modal, segment toggle, roster, PersonSearchInput)
// with the "Anyone"/world-link segment REMOVED by design: a context is a
// data-access grant, not a document, and must never be reachable outside its
// workspace. Two segments, both workspace-bounded.
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
        <Button variant="ghost" size="sm" data-testid="context-access" className="gap-1.5">
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
            <SectionEyebrow action={policyMut.isPending && <Spinner className="size-3" />}>
              Who can ask
            </SectionEyebrow>
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
              <SectionEyebrow count={roster?.length}>Invited to ask</SectionEyebrow>
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
                    No one invited yet — only you can ask.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-border-soft pt-3 text-xs text-muted-foreground">
            <Icon name="lock" className="size-3.5" />
            Workspace members only — a context is never reachable outside the workspace.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Whether the context's runner is alive, derived from the queue poll's stamp
// (runner_seen_at) — no heartbeat protocol. Thresholds follow the write path:
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
  const age = seenAt ? Date.now() - new Date(seenAt).getTime() : Number.POSITIVE_INFINITY
  const [dot, label] =
    seenAt && age < 90_000
      ? ["bg-success", "runner online"]
      : seenAt && age < 600_000
        ? ["bg-warning", `seen ${ago(seenAt)}`]
        : [
            "bg-muted-foreground",
            `runner offline — ${seenAt ? `seen ${ago(seenAt)}` : "never seen"}`,
          ]
  return (
    <span
      data-testid="console-runner-liveness"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  )
}

// Ask the first question — the empty-conversation state.
function AskComposer({ contextId, onAsked }: { contextId: string; onAsked: (s: Session) => void }) {
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
        aria-label="Your question"
        placeholder="Ask a question — the answer arrives here, with the query behind it."
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit()
        }}
      />
      <Button
        data-testid="console-ask-submit"
        onClick={submit}
        loading={ask.isPending}
        disabled={ask.isPending || !text.trim()}
        className="self-end"
      >
        Ask
      </Button>
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
  // saying "open" after the answer has already rendered below it.
  const state = data?.session.state
  useEffect(() => {
    if (state && state !== "open")
      qc.invalidateQueries({ queryKey: contextSessionsQuery(contextId).queryKey })
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
  // SCOPE: this is the CONTEXT CONSOLE only. The chat rail on an artifact is a separate
  // surface — `use-artifact-chat.ts`, plain fetch into local state, polled from
  // artifact-chat.tsx on its own 900ms interval, and it never touches sessionQuery. It has
  // no `working` hole (its gate is already `working || open`), so it does not have the bug
  // fixed here, but it also gets none of this push. Wiring it up is its own change.
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
  const [streaming, setStreaming] = useState("")
  const lastSeq = useRef(0)
  // Which model attempt the accumulated text belongs to (see the `attempt` note in
  // lib/session-stream.ts): a re-generated reply must replace the abandoned one, not append.
  const lastAttempt = useRef(0)
  useUserEvent(
    "session.delta",
    (e) => {
      let p: { session_id?: string; seq?: number; text?: string; attempt?: number }
      try {
        p = JSON.parse(e.data) as typeof p
      } catch {
        return
      }
      if (p.session_id !== sessionId || typeof p.text !== "string") return
      const seq = typeof p.seq === "number" ? p.seq : lastSeq.current + 1
      if (seq <= lastSeq.current) return
      lastSeq.current = seq
      const at = typeof p.attempt === "number" ? p.attempt : lastAttempt.current
      const fresh = at > lastAttempt.current
      lastAttempt.current = at
      const text = p.text
      setStreaming((s) => (fresh ? text : s + text))
    },
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
    setStreaming("")
    lastSeq.current = 0
    lastAttempt.current = 0
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
      <StatusPanel
        layout="inline"
        tone="danger"
        title="Couldn't load this conversation"
        description="Try again in a moment."
        action={
          <Button variant="outline" size="sm" data-testid="console-retry" onClick={refresh}>
            Try again
          </Button>
        }
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3" data-testid="console-thread">
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} contextName={contextName} />
        ))}
        {/* The answer mid-write. Plain text with preserved whitespace, not the markdown the
            settled row renders: a half-arrived reply is half-arrived markup too, and running
            each slice through the renderer makes it visibly thrash as it completes. */}
        {streaming && (
          <div className="flex flex-col gap-1 px-1" data-testid="console-streaming">
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">
              {contextName}
            </span>
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
            Thinking — the runner picks this up on its next poll.
          </div>
        )}
        {session.state === "failed" && (
          <p className="px-1 text-sm text-destructive" data-testid="console-failed">
            The run failed. Ask again, or check the runner's log.
          </p>
        )}
      </div>

      {session.state === "closed" ? (
        <p className="border-t pt-3 text-sm text-muted-foreground">This conversation is closed.</p>
      ) : isMine ? (
        <div className="flex flex-col gap-2 border-t pt-3">
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
        <div className="flex items-center border-t pt-3">
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

// GFM chrome for rendered answers, kept local via arbitrary variants (tokens
// only — the design-token check applies). Tables and fences are the two block
// forms models actually produce that need styling beyond cmt-body's inline set.
const ANSWER_PROSE = cn(
  "text-sm [word-break:break-word] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium",
  "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs",
  "[&_th]:border-b [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border-b [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1.5 [&_td]:tabular-nums",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-secondary [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-xs",
  "[&_code]:font-mono [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
)

function MessageRow({ m, contextName }: { m: SessionMessage; contextName: string }) {
  const [showQuery, setShowQuery] = useState(false)
  const [copied, setCopied] = useState(false)
  const fromAgent = m.author_kind === "agent"
  const meta = safeMeta(m.meta)
  // Answers travel onward as markdown (into docs, Slack, a PR) — copy the
  // SOURCE, not the rendered text.
  const copyMd = async () => {
    try {
      await navigator.clipboard.writeText(m.body_md)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Couldn't copy")
    }
  }
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
          <Badge variant="outline" data-testid="console-escalated">
            Escalated — {meta.escalation}
          </Badge>
        )}
        {meta.confidence !== null && (
          <span className="ml-auto tabular-nums">
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
        <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {meta.caveats.map((c) => (
            <li key={c}>⚠ {c}</li>
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

// The owner's view: every session on this context, most recent first.
function ActivityList({ sessions, onOpen }: { sessions: Session[]; onOpen: (id: string) => void }) {
  if (sessions.length === 0)
    return <EmptyState title="No sessions yet" description="Questions will show up here." />
  return (
    <ul className="flex flex-col">
      {sessions.map((s) => (
        <li key={s.id} className="border-b last:border-0">
          <button
            type="button"
            data-testid="console-activity-row"
            onClick={() => onOpen(s.id)}
            className="flex w-full items-center gap-3 px-1 py-2.5 text-left text-sm hover:bg-accent"
          >
            <span className="text-foreground">{ago(s.created_at)}</span>
            <StateBadge state={s.state} />
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              v{s.context_version}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function StateBadge({ state }: { state: Session["state"] }) {
  return (
    <Badge variant="outline" shape="pill" className="text-xs">
      {state}
    </Badge>
  )
}
