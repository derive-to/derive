import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { ApiError, api, type Session, type SessionMessage, type SessionMeta } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PageShell } from "@/components/shared/page-shell"
import { Spinner } from "@/components/shared/spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { contextQuery, contextSessionsQuery, sessionQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { mdToHtml } from "../artifact/lib/markdown"

// The context console: ask, read the answer (with the query/confidence/caveats the
// runner attaches), follow up. One conversation at a time — older sessions are a
// picker away; the owner additionally gets the activity view. The transcript polls
// fast only while the runner owes a reply (sessionQuery's refetchInterval).
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
  const { data: context } = useQuery(contextQuery(id))
  const { data: sessions } = useQuery(contextSessionsQuery(id))

  // The session on screen: sticky once picked; defaults to the most recent.
  const [picked, setPicked] = useState<string | null>(null)
  // Controlled tabs so the Activity view can hand a session to the Ask view —
  // with defaultValue the row click would select a thread inside a hidden tab.
  const [tab, setTab] = useState("ask")
  const mine = (sessions ?? []).filter((s) => s.asker_id === me?.id)
  const active = picked === "new" ? null : (picked ?? mine[0]?.id ?? null)
  const isOwner = !!context && context.created_by === me?.id

  if (!context)
    return (
      <PageShell className="flex justify-center pt-16">
        <Spinner />
      </PageShell>
    )

  return (
    <PageShell className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="context" className="text-muted-foreground" />
        <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
          {context.name}
        </h1>
        {context.manifest_short_id && (
          <Link
            to="/artifacts/$ref"
            params={{ ref: context.manifest_short_id }}
            data-testid="console-manifest-link"
            className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Manifest ↗
          </Link>
        )}
      </div>

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

// Ask the first question — the empty-conversation state.
function AskComposer({ contextId, onAsked }: { contextId: string; onAsked: (s: Session) => void }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const ask = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const r = await api.askContext(contextId, text.trim())
      setText("")
      onAsked(r.session)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not send the question")
      setBusy(false)
    }
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
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask()
        }}
      />
      <Button
        data-testid="console-ask-submit"
        onClick={ask}
        loading={busy}
        disabled={busy || !text.trim()}
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
  const { data } = useQuery(sessionQuery(sessionId))
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  // The picker pills read the sessions LIST; the transcript polls its own key.
  // Sync the list whenever this session's state settles, so a pill never keeps
  // saying "open" after the answer has already rendered below it.
  const state = data?.session.state
  useEffect(() => {
    if (state && state !== "open")
      qc.invalidateQueries({ queryKey: contextSessionsQuery(contextId).queryKey })
  }, [state, contextId, qc])
  if (!data) return <Spinner className="mx-auto mt-8" />
  const { session, messages } = data
  // Only the asker may post (the server 404s anyone else) — the owner reads
  // someone else's session from Activity and can close it, nothing more.
  const isMine = session.asker_id === me?.id
  const refresh = () => qc.invalidateQueries({ queryKey: sessionQuery(sessionId).queryKey })

  const send = async () => {
    // Guards the keyboard path too — Cmd+Enter must respect the same turn gate
    // as the disabled Send button.
    if (!text.trim() || busy || session.state === "open") return
    setBusy(true)
    try {
      await api.postSessionMessage(sessionId, text.trim())
      setText("")
      refresh()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not send")
    } finally {
      setBusy(false)
    }
  }

  const close = async () => {
    try {
      await api.closeSession(sessionId)
      refresh()
      onClosed()
    } catch {
      /* already closed is fine */
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3" data-testid="console-thread">
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} contextName={contextName} />
        ))}
        {session.state === "open" && (
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
              loading={busy}
              disabled={busy || !text.trim() || session.state === "open"}
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

function MessageRow({ m, contextName }: { m: SessionMessage; contextName: string }) {
  const [showQuery, setShowQuery] = useState(false)
  const fromAgent = m.author_kind === "agent"
  const meta = safeMeta(m.meta)
  return (
    <div
      data-testid="console-message"
      className={cn("rounded-xl px-4 py-3", fromAgent ? "border bg-card" : "bg-secondary")}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">{fromAgent ? contextName : "You"}</span>
        <span>{ago(m.created_at)}</span>
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
      <div
        className="cmt-body text-sm [word-break:break-word]"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped first in mdToHtml.
        dangerouslySetInnerHTML={{ __html: mdToHtml(m.body_md) }}
      />
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
