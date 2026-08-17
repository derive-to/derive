import { useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useCallback, useEffect, useRef } from "react"
import { api } from "@/api"
import { ChatComposer } from "@/components/chat/chat-composer"
import { ChatThread } from "@/components/chat/chat-thread"
import { json, useChatSession } from "@/components/chat/use-chat-session"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useDocumentTitle } from "@/lib/use-document-title"

// THE WORKSPACE CHAT — /chat.
//
// The document rail's sibling: the same conversation, the same transcript, the same streaming
// bubble, with the workspace as the subject instead of one file. That is why almost nothing
// here is chat machinery — it is components/chat/* plus this page's own three decisions: which
// workspace, which model, and which past conversation.
//
// The full-width view of the conversation the ⌘K palette also holds (chrome/palette-ask): reached
// by that view's Open in chat, by the rail row on a phone (where a conversation does not fit in a
// modal), and by link. It is also where the agent has room to WRITE — the palette is the same lane
// and can too, but this is the surface with history and a stop control.

interface ChatSessionRow {
  id: string
  created_at: string
  preview: string
  /**
   * The DOCUMENT a conversation is about, when it is about one.
   *
   * This list is every session in the workspace, and the rail on a document opens sessions here
   * too — so a conversation held against a file sits in the same history as one held against the
   * workspace. The field was declared away, which left the picker unable to tell them apart or
   * act on the difference: every row loaded into this page, and a document conversation arriving
   * on a surface with no document has no subject to render, a narrower tool set behind it, and
   * its own revision contract. It did not degrade, it came apart.
   */
  subject?: { kind: "artifact"; id: string } | null
}

export function ChatPage() {
  useDocumentTitle("Chat")
  const navigate = useNavigate()
  const { session: sessionParam, model: modelParam, ask } = useSearch({ from: "/chat" })

  // The workspace is this page's one hard dependency: without its id there is nothing to
  // chat ABOUT, so a failure here is a page-level error rather than a degraded control.
  const {
    data: ws,
    isError: wsFailed,
    refetch: retryWs,
  } = useQuery({
    ...workspaceQuery(),
    staleTime: 60_000,
  })
  const settings = useQuery({ ...workspaceSettingsQuery(), staleTime: 60_000 }).data
  const org = ws?.id ?? ""

  // Past conversations, this person's own. Refetched when a new one opens so the picker does
  // not go stale behind a running turn.
  const history = useQuery({
    queryKey: ["chat-sessions", org],
    queryFn: () => json<{ sessions: ChatSessionRow[] }>(`/v1/chat-sessions?workspace=${org}`),
    enabled: !!org,
  })

  const open = useCallback(
    (body: string) =>
      api.createChatSession({
        workspace: org,
        body_md: body,
        // Sending the default explicitly would pin the conversation to today's default.
        ...(modelParam ? { model: modelParam } : {}),
      }),
    [org, modelParam],
  )
  // The model rides every follow-up too, so switching mid-conversation applies to the NEXT
  // turn and leaves the answers already given alone.
  const followUp = useCallback(
    (id: string, body: string) => api.postSessionMessage(id, body, modelParam),
    [modelParam],
  )

  const chat = useChatSession({ open, followUp, resetKey: org })

  // STOP means CLOSE the session, which is the only honest thing it can mean here: the turn runs
  // detached on the server, so nothing local can call it back. Closing settles it, the poll sees
  // a session that is no longer working, and the spinner stops. The answer may still land — this
  // ends the WAIT, not the work — and re-reading afterwards is what shows whether it did.
  const stop = useCallback(() => {
    const id = chat.sessionId
    if (!id) return
    void json(`/v1/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) })
      .catch(() => {})
      .finally(() => chat.poll())
  }, [chat.sessionId, chat.poll])

  // A session named in the URL is the deep link every other surface points at ("continue in
  // chat"), and it is also how the history picker navigates — one path, so a reload of a
  // picked conversation lands on the same screen the click did.
  useEffect(() => {
    if (sessionParam && sessionParam !== chat.sessionId) void chat.adopt(sessionParam)
  }, [sessionParam, chat.sessionId, chat.adopt])

  // Keep the URL honest once a new conversation exists, so a reload does not start over.
  useEffect(() => {
    if (chat.sessionId && chat.sessionId !== sessionParam) {
      void navigate({
        to: "/chat",
        search: { session: chat.sessionId ?? undefined, model: modelParam, ask: undefined },
        replace: true,
      })
      // A new conversation exists, so the picker's list is stale by exactly one row.
      void history.refetch()
    }
  }, [chat.sessionId, sessionParam, modelParam, navigate, history.refetch])

  const chatOff = settings ? settings.chatBeta !== true : false

  // A QUESTION HANDED OVER, sent once.
  //
  // `?ask=` is how a surface with nowhere to put an answer hands one here: the rail row and the
  // search sheet on a phone (there is no dock there), a pasted link, Slack. Two things make
  // "once" true — a `session` in the URL wins outright, so a named conversation is never
  // interrupted by a stale param, and the ref flips synchronously, so React's double mount cannot
  // send twice.
  //
  // IT DOES NOT STRIP THE PARAM ITSELF, and that is the whole subtlety. Navigating to clear `ask`
  // right after sending REMOUNTS this page, which throws away the session id of the turn just
  // started: the server has a live conversation and the surface has forgotten it, so the answer
  // lands nowhere and the person watches an empty thread. The effect above already rewrites the
  // URL the moment a session id exists — with `ask: undefined` — so the param clears on its own,
  // one beat later, with no second navigation racing the send. Until then a reload re-sends the
  // same question, which is what reloading a failed ask should do anyway.
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (!ask || sessionParam || !org || chatOff || asked.current === ask) return
    asked.current = ask
    void chat.send(ask)
  }, [ask, sessionParam, org, chatOff, chat.send])

  // The picker queries above degrade on their own (a picker with nothing to show simply does
  // not render), but this one cannot: with no workspace there is no conversation to have, and
  // a disabled composer with no explanation reads as a broken page.
  if (wsFailed)
    return (
      <PageShell className="flex justify-center pt-16">
        <LoadError
          title="Couldn’t load your workspace"
          description="Chat needs to know which workspace you're asking about."
          testId="chat-ws-retry"
          onRetry={() => void retryWs()}
        />
      </PageShell>
    )

  // FULL SCREEN, on purpose. Chat is not a document page: the thread should own the viewport,
  // and the composer should sit where the eye already is (the bottom edge), not float in the
  // middle of a card. PageShell is therefore deliberately NOT used here — it exists to give
  // reading pages one measure and one scroll rhythm, and this surface wants neither.
  //
  // Full-bleed does not mean full-width TEXT: the rows are centred in a reading column, so a
  // wide monitor gets air rather than 200-character lines. That is the `row` wrapper below.
  const measure = (children: ReactNode) => (
    <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">{children}</div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-page">
      {/* The header is chrome, so it stays quiet: a small label, and the controls that change
          what the next turn does. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 sm:px-6">
        {/* The app's mobile top bar already says "Chat", so the page does not repeat it there —
            the heading stays in the a11y tree, and the controls keep the row. */}
        <Icon name="sparkles" className="size-4 text-muted-foreground max-sm:hidden" />
        <h1 className="text-sm font-semibold tracking-tight text-foreground max-sm:sr-only">
          Chat
        </h1>
        {chat.sessionId ? (
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {history.data?.sessions.find((x) => x.id === chat.sessionId)?.preview ?? ""}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {chat.sessionId ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                chat.reset()
                void navigate({
                  to: "/chat",
                  search: { session: undefined, model: modelParam, ask: undefined },
                  replace: true,
                })
              }}
              data-testid="chat-new"
            >
              New chat
            </Button>
          ) : null}
          <HistoryPicker
            sessions={history.data?.sessions ?? []}
            current={chat.sessionId}
            onPick={(id) =>
              void navigate({
                to: "/chat",
                search: { session: id, model: modelParam, ask: undefined },
              })
            }
            onOpenDoc={(shortId) =>
              void navigate({ to: "/artifacts/$ref", params: { ref: shortId } })
            }
          />
        </div>
      </header>

      <ChatThread
        messages={chat.messages}
        working={chat.working}
        streaming={chat.streaming}
        onPoll={chat.poll}
        className="py-6"
        row={measure}
        empty={
          <div className="flex h-full items-center justify-center px-4">
            <div className="w-full max-w-lg">
              <EmptyState
                icon={<Icon name="sparkles" />}
                title={chatOff ? "Chat is not enabled here" : "Ask about your workspace"}
                description={
                  chatOff
                    ? "An admin can turn chat on in workspace settings."
                    : "Derive searches, reads and writes with your own permissions, and links what it used."
                }
              />
              {!chatOff && (
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((sug) => (
                    <button
                      key={sug}
                      type="button"
                      onClick={() => void chat.send(sug)}
                      className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                      data-testid="chat-suggestion"
                    >
                      {sug}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        }
      />

      <div className="shrink-0 border-t border-border">
        {/* NO MODEL NAME ON THIS SURFACE. Which model answers is an operator's decision and an
            implementation detail; naming it in the product invites people to read it as a promise,
            and it changes. The catalog, the `model` parameter and the per-turn record all stay, so
            switching remains possible. It is simply not advertised. */}
        {measure(
          <ChatComposer
            onSend={chat.send}
            busy={chat.working}
            onStop={stop}
            disabled={chatOff || !org}
            notice={chat.error ?? undefined}
            placeholder="Ask about your workspace…"
            // The page's own bottom edge, so it owes the phone its safe area — the same floor
            // the artifact comment composer uses.
            className="border-t-0 px-0 pb-[max(10px,env(safe-area-inset-bottom))]"
          />,
        )}
      </div>
    </div>
  )
}

/** Openers that show what this surface is FOR, in the words someone would actually type. Each
 *  is a real question the tools can answer, not a feature tour. */
const SUGGESTIONS = [
  "What do we have about onboarding?",
  "Summarize what changed this week",
  "Find the pricing docs",
]

function HistoryPicker(props: {
  sessions: ChatSessionRow[]
  current: string | null
  onPick: (id: string) => void
  onOpenDoc: (shortId: string) => void
}) {
  const { sessions, current, onPick, onOpenDoc } = props
  if (sessions.length === 0) return null
  // Split once, here, so the two groups below cannot drift on what counts as which.
  const here = sessions.filter((s) => !s.subject)
  const onDocs = sessions.filter((s) => !!s.subject)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="chat-history">
          History
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-sm">
        {/* TWO KINDS, SAID OUT LOUD. Both are the person's own conversations and both belong
            here, so neither is hidden — but one of them cannot be opened on this page, and a
            list that renders them identically is a list that invites the click that breaks.
            Labelled groups rather than a badge, because the question a reader has at this
            moment is exactly "which of these is about a document". */}
        <DropdownMenuLabel>About this workspace</DropdownMenuLabel>
        {here.length === 0 && (
          <DropdownMenuItem
            disabled
            className="text-muted-foreground text-xs"
            data-testid="chat-history-empty"
          >
            No workspace conversations yet
          </DropdownMenuItem>
        )}
        {here.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => onPick(s.id)}
            className={s.id === current ? "bg-muted" : undefined}
            data-testid="chat-history-item"
          >
            <span className="truncate">{s.preview || "(empty)"}</span>
            <span className="ml-2 shrink-0 text-xs text-muted-foreground">{ago(s.created_at)}</span>
          </DropdownMenuItem>
        ))}
        {onDocs.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>On a document</DropdownMenuLabel>
            {/* THESE OPEN THE DOCUMENT, rather than loading into a page that has none. The
                subject carries the artifact's short_id, which is exactly what /artifacts/$ref
                resolves, so the conversation is one click away on the surface that can actually
                show it — its own rail, against the document it is about. Disabling them was a
                stand-in for a route I had not checked; the route was already there. */}
            {onDocs.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onSelect={() => onOpenDoc(s.subject?.id ?? "")}
                data-testid="chat-history-item-doc"
              >
                <span className="truncate">{s.preview || "(empty)"}</span>
                <span className="ml-2 shrink-0 text-muted-foreground text-xs">open doc</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
