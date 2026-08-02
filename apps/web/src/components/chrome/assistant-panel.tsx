import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useCallback, useEffect, useRef } from "react"
import { ChatComposer } from "@/components/chat/chat-composer"
import { ChatThread } from "@/components/chat/chat-thread"
import { json, useChatSession } from "@/components/chat/use-chat-session"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useShell } from "./shell-context"

// THE ASSISTANT DOCK — the agent, beside whatever you are already doing.
//
// The same conversation as /chat, in the geometry a document already uses for its rail: a card
// on the recessed backdrop, peer to the content card. That is the whole idea. Asking a question
// should not cost you the page you asked it from, and an answer about your workspace is worth
// nothing if you had to leave the workspace to read it.
//
// It owns almost nothing. The transcript, the streaming bubble, the poll and the session state
// are components/chat/*, identical to the page and the document rail — what belongs to this file
// is only the frame, and the three decisions the frame implies: which workspace, what the empty
// state promises, and where "expand" goes.
//
// DESKTOP ONLY, by construction: AppShell never mounts it below `sm` (a 340px dock on a 390px
// screen is a modal wearing a costume), and openAssistant navigates to /chat there instead. So
// nothing in here needs a mobile branch.

/** Openers that teach what this surface is for, in the words someone would type. The third is
 *  deliberate: the agent can answer about Derive itself now (derive://skills/helping), and
 *  nothing else on screen would ever tell you that. */
const OPENERS = ["What changed this week?", "Find the pricing docs", "How do I add a member?"]

export function AssistantPanel(props: {
  /** A question handed over by whatever opened the panel (the palette, a page's Ask button).
   *  Sent once, then handed back so the shell can forget it. */
  ask: string | null
  onAskConsumed: () => void
}) {
  const { ask, onAskConsumed } = props
  const { closeAssistant } = useShell()

  // The workspace is the subject: without its id there is nothing to ask ABOUT. A failure here
  // degrades to a disabled composer that says why, rather than a panel that silently cannot send.
  const { data: ws, isError: wsFailed, refetch: retryWs } = useQuery({ ...workspaceQuery() })
  const settings = useQuery({ ...workspaceSettingsQuery(), staleTime: 60_000 }).data
  const org = ws?.id ?? ""
  const chatOff = settings ? settings.chatBeta !== true : false

  const open = useCallback(
    (body: string) =>
      json<{ session: { id: string } }>("/v1/chat-session", {
        method: "POST",
        body: JSON.stringify({ workspace: org, body_md: body }),
      }),
    [org],
  )
  const chat = useChatSession({ open, resetKey: org })

  // ONE SHOT, and a ref rather than state: React double-mounts in development, and a question
  // sent twice is two turns, two costs and two answers to read. The ref flips synchronously, so
  // the second mount finds it already spent.
  const sent = useRef<string | null>(null)
  useEffect(() => {
    if (!ask || !org || chatOff || sent.current === ask) return
    sent.current = ask
    void chat.send(ask)
    onAskConsumed()
  }, [ask, org, chatOff, chat.send, onAskConsumed])

  const notice = wsFailed
    ? "Couldn't load your workspace."
    : chatOff
      ? "An admin can turn chat on in workspace settings."
      : (chat.error ?? undefined)

  return (
    <aside
      data-testid="assistant-panel"
      aria-label="Chat with Derive"
      // Peer to the content card, on the same recessed backdrop and with the same mat: this is
      // one shell holding two cards, not a drawer floating over the app.
      className="hidden w-85 shrink-0 flex-col overflow-hidden rounded-xl bg-background shadow ring-1 ring-sidebar-border sm:my-2 sm:mr-2 sm:flex"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="sparkles" size={15} className="text-muted-foreground" />
        <h2 className="flex-1 truncate text-sm font-semibold tracking-tight">Derive</h2>
        {/* EXPAND, not "open in chat": it is the same conversation at full width, so the word
            for it is a size, not a destination. Carries the session when there is one, which is
            what makes the transcript survive the trip. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild data-testid="assistant-expand">
              <Link
                to="/chat"
                search={{ session: chat.sessionId ?? undefined, model: undefined, ask: undefined }}
                aria-label="Expand to the full chat page"
                onClick={() => closeAssistant()}
              >
                <Icon name="present" size={15} />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Expand</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={closeAssistant}
              aria-label="Close chat"
              data-testid="assistant-close"
            >
              <Icon name="close" size={15} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close</TooltipContent>
        </Tooltip>
      </header>

      <ChatThread
        messages={chat.messages}
        working={chat.working}
        streaming={chat.streaming}
        onPoll={chat.poll}
        className="px-3 py-3"
        empty={
          <div className="flex h-full flex-col justify-center gap-3 px-1 pb-6">
            <p className="text-sm text-muted-foreground">
              {chatOff
                ? "Chat is not enabled here. An admin can turn it on in workspace settings."
                : wsFailed
                  ? "Couldn't load your workspace, so there is nothing to ask about yet."
                  : "Derive searches and reads with your own permissions, and links what it used."}
            </p>
            {wsFailed ? (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void retryWs()}
                  data-testid="assistant-retry"
                >
                  Try again
                </Button>
              </div>
            ) : chatOff ? null : (
              // Wrapped, never a sideways scroll: a hidden third opener is a worse teacher
              // than three visible ones.
              <div className="flex flex-wrap gap-1.5">
                {OPENERS.map((opener) => (
                  <button
                    key={opener}
                    type="button"
                    onClick={() => void chat.send(opener)}
                    data-testid="assistant-opener"
                    className="rounded-full border border-border px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    {opener}
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      />

      <ChatComposer
        onSend={chat.send}
        busy={chat.working}
        disabled={chatOff || !org}
        notice={notice}
        placeholder="Ask about your workspace…"
      />
    </aside>
  )
}
