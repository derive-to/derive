import { useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useCallback, useEffect } from "react"
import { ChatComposer } from "@/components/chat/chat-composer"
import { ChatThread } from "@/components/chat/chat-thread"
import { json, useChatSession } from "@/components/chat/use-chat-session"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PageShell } from "@/components/shared/page-shell"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
// Deliberately NOT in the sidebar yet. It is reached by direct link while it earns its place.

interface ChatModel {
  id: string
  label: string
  is_default: boolean
}

interface ChatSessionRow {
  id: string
  created_at: string
  preview: string
}

export function ChatPage() {
  useDocumentTitle("Chat")
  const navigate = useNavigate()
  const { session: sessionParam, model: modelParam } = useSearch({ from: "/chat" })

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

  // The deploy's models. One entry (or none) means there is nothing to choose, and the picker
  // does not render — a control with a single option is furniture, not a choice.
  const models =
    useQuery({
      queryKey: ["chat-models"],
      queryFn: () => json<{ models: ChatModel[] }>("/v1/chat/models"),
      staleTime: Number.POSITIVE_INFINITY,
    }).data?.models ?? []

  // Past conversations, this person's own. Refetched when a new one opens so the picker does
  // not go stale behind a running turn.
  const history = useQuery({
    queryKey: ["chat-sessions", org],
    queryFn: () => json<{ sessions: ChatSessionRow[] }>(`/v1/chat-sessions?workspace=${org}`),
    enabled: !!org,
  })

  const open = useCallback(
    (body: string) =>
      json<{ session: { id: string } }>("/v1/chat-session", {
        method: "POST",
        body: JSON.stringify({
          workspace: org,
          body_md: body,
          // Only when the person actually picked one: sending the default explicitly would
          // pin a conversation to today's default forever, which is not what "default" means.
          ...(modelParam ? { model: modelParam } : {}),
        }),
      }),
    [org, modelParam],
  )
  // The model rides every follow-up too, so switching mid-conversation applies to the NEXT
  // turn and leaves the answers already given alone.
  const followUp = useCallback(
    (id: string, body: string) =>
      json(`/v1/sessions/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body_md: body, ...(modelParam ? { model: modelParam } : {}) }),
      }),
    [modelParam],
  )

  const chat = useChatSession({ open, followUp, resetKey: org })

  // WHICH MODEL THE PICKER SHOWS, and it has to be the one that would actually answer. The URL
  // wins (the person just picked it); otherwise the model this conversation was LAST answered
  // with, read off the transcript exactly as the server reads it. Without this a reloaded
  // conversation showed the deploy's default while the next turn would have run on the model it
  // was already using — the label lying about what happens next.
  const lastUsed = [...chat.messages].reverse().find((m) => m.meta?.model?.id)?.meta?.model?.id
  const chosen =
    models.find((m) => m.id === modelParam) ??
    models.find((m) => m.id === lastUsed) ??
    models.find((m) => m.is_default)

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
        search: { session: chat.sessionId ?? undefined, model: modelParam },
        replace: true,
      })
      // A new conversation exists, so the picker's list is stale by exactly one row.
      void history.refetch()
    }
  }, [chat.sessionId, sessionParam, modelParam, navigate, history.refetch])

  const chatOff = settings ? settings.chatBeta !== true : false

  // The picker queries above degrade on their own (a picker with nothing to show simply does
  // not render), but this one cannot: with no workspace there is no conversation to have, and
  // a disabled composer with no explanation reads as a broken page.
  if (wsFailed)
    return (
      <PageShell className="flex justify-center pt-16">
        <StatusPanel
          tone="danger"
          title="Couldn't load your workspace"
          description="Chat needs to know which workspace you're asking about."
          action={
            <Button size="sm" onClick={() => void retryWs()} data-testid="chat-ws-retry">
              Try again
            </Button>
          }
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
        <Icon name="sparkles" className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold tracking-tight text-foreground">Chat</h1>
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
                  search: { session: undefined, model: modelParam },
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
              void navigate({ to: "/chat", search: { session: id, model: modelParam } })
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
                    : "Derive searches and reads with your own permissions, and links what it used."
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
        {measure(
          <ChatComposer
            onSend={chat.send}
            disabled={chatOff || !org}
            disabledReason={chat.error ?? undefined}
            placeholder="Ask about your workspace…"
            className="border-t-0 px-0"
            accessory={
              models.length > 1 ? (
                <ModelPicker
                  models={models}
                  chosen={chosen}
                  onPick={(id) =>
                    void navigate({
                      to: "/chat",
                      search: { session: sessionParam, model: id },
                      replace: true,
                    })
                  }
                />
              ) : null
            }
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

function ModelPicker(props: {
  models: ChatModel[]
  chosen: ChatModel | undefined
  onPick: (id: string) => void
}) {
  const { models, chosen, onPick } = props
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="chat-model">
          {chosen?.label ?? "Model"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Answer with</DropdownMenuLabel>
        {models.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => onPick(m.id)}
            data-testid={`chat-model-${m.id}`}
          >
            {m.label}
            {m.is_default ? (
              <span className="ml-2 text-xs text-muted-foreground">default</span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HistoryPicker(props: {
  sessions: ChatSessionRow[]
  current: string | null
  onPick: (id: string) => void
}) {
  const { sessions, current, onPick } = props
  if (sessions.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="chat-history">
          History
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-sm">
        <DropdownMenuLabel>Your conversations</DropdownMenuLabel>
        {sessions.map((s) => (
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
