import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef } from "react"
import { ChatComposer } from "@/components/chat/chat-composer"
import { ChatThread } from "@/components/chat/chat-thread"
import { json, useChatSession } from "@/components/chat/use-chat-session"
import { Icon } from "@/components/icons"
import { Kbd } from "@/components/ui/kbd"
import { isInAppPath } from "@/lib/in-app-path"
import { workspaceQuery } from "@/lib/queries"
import { useChatEnabled } from "@/lib/use-chat-enabled"

// ASKING, INSIDE THE PALETTE — the answer where the question was typed.
//
// This replaced a dock on the right of the page, and the reason is worth keeping: a panel that
// takes 340px from a flex row SQUEEZES the content card, so the library grid reflows and every
// card you were looking at moves. The one thing the surface promised was "ask without losing your
// place", and displacing the page is exactly losing it. The palette is already floating above the
// page, so growing it into an answer moves nothing at all.
//
// It is also where "take me there" already lives, which is why an answer's in-app links are
// lifted out as real rows below it: a question like "how do I add a member" has a DESTINATION,
// and reading a path is not the same as arriving.

/** Openers for a conversation started with no question (the rail row). Same three the page uses. */
const OPENERS = ["What changed this week?", "Find the pricing docs", "How do I add a member?"]

/**
 * The in-app destinations an answer names, in order, deduped.
 *
 * Root-relative links only: an answer's citations are `[Pricing v3](/artifacts/ab12cd34)` and its
 * app paths are `[Settings › Members](/settings/members)`, both written by the same rule (see
 * derive://skills/helping). An external link is left in the prose where it belongs — this row is
 * for places inside Derive you can be taken.
 */
export const destinationsIn = (markdown: string): { label: string; path: string }[] => {
  const found = new Map<string, string>()
  for (const m of markdown.matchAll(/\[([^\]]+)\]\((\/[^)\s]*)\)/g)) {
    const [, label, path] = m
    // isInAppPath, not startsWith("/"): `//evil.com` satisfies the regex above and leaves the
    // origin. The text being parsed was written by a model that just read documents anyone in the
    // workspace can author, so a planted link is a realistic input, not a hypothetical one.
    if (label && isInAppPath(path) && !found.has(path)) found.set(path, label)
  }
  return [...found].map(([path, label]) => ({ label, path }))
}

export function PaletteAsk(props: {
  /** The question to send on open. Empty means "just start a conversation". */
  initial: string
  /** Back to searching, keeping the palette open. */
  onBack: () => void
  /** Leave the palette (a destination was taken, or the person is done). */
  onClose: () => void
}) {
  const { initial, onBack, onClose } = props
  const navigate = useNavigate()
  const enabled = useChatEnabled()
  const { data: ws, isError: wsFailed } = useQuery({ ...workspaceQuery(), staleTime: 60_000 })
  const org = ws?.id ?? ""

  const open = useCallback(
    (body: string) =>
      json<{ session: { id: string } }>("/v1/chat-session", {
        method: "POST",
        body: JSON.stringify({ workspace: org, body_md: body }),
      }),
    [org],
  )
  const chat = useChatSession({ open, resetKey: org })

  // ONE SHOT. A ref rather than state, because React's double mount would otherwise ask the same
  // question twice — two turns, two costs, two answers to read.
  const sent = useRef<string | null>(null)
  useEffect(() => {
    if (!initial || !org || !enabled || sent.current === initial) return
    sent.current = initial
    void chat.send(initial)
  }, [initial, org, enabled, chat.send])

  // Destinations come from the LAST answer only: an older one's links belong to a question that
  // has already been answered, and offering all of them turns the row into a pile.
  const lastAnswer = [...chat.messages].reverse().find((m) => m.author_kind === "agent")
  const destinations = lastAnswer ? destinationsIn(lastAnswer.body_md).slice(0, 4) : []

  const go = (path: string) => {
    onClose()
    void navigate({ to: path })
  }

  return (
    <div className="flex min-h-0 flex-col" data-testid="palette-ask">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-sm">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to search"
          data-testid="palette-ask-back"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Icon name="chevron-left" size={15} />
        </button>
        <Icon name="sparkles" size={15} className="shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">Derive</span>
      </div>

      {/* A FIXED WINDOW for the transcript, and the height lives on this wrapper rather than on
          the thread: ChatThread is `flex-1`, so inside an auto-height dialog it collapses to its
          content and the palette grows with every streamed token — a centred dialog resizing under
          the reader's eyes, which is the same jarring this surface exists to remove. Given a
          measured box to fill, it fills it and scrolls. */}
      <div className="flex h-72 min-h-0 shrink-0 flex-col">
        <ChatThread
          messages={chat.messages}
          working={chat.working}
          streaming={chat.streaming}
          onPoll={chat.poll}
          className="px-3 py-3"
          empty={
            <div className="flex h-full flex-col justify-center gap-3 px-1">
              <p className="text-sm text-muted-foreground">
                {enabled
                  ? "Derive searches and reads with your own permissions, and links what it used."
                  : "Chat is not enabled here. An admin can turn it on in workspace settings."}
              </p>
              {enabled && (
                <div className="flex flex-wrap gap-1.5">
                  {OPENERS.map((opener) => (
                    <button
                      key={opener}
                      type="button"
                      onClick={() => void chat.send(opener)}
                      data-testid="palette-opener"
                      className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                    >
                      {opener}
                    </button>
                  ))}
                </div>
              )}
            </div>
          }
        />
      </div>

      {/* WHERE THE ANSWER POINTS, as somewhere you can go. The agent proposes and the person
          commits: it never navigates on its own, because a model deciding to move you off the
          page you were on is delightful exactly once. */}
      {destinations.length > 0 && (
        <div className="shrink-0 border-t px-2 py-1.5">
          {destinations.map((d) => (
            <button
              key={d.path}
              type="button"
              onClick={() => go(d.path)}
              data-testid={`palette-destination-${d.path}`}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Icon name="chevron-right" size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">{d.path}</span>
            </button>
          ))}
        </div>
      )}

      <ChatComposer
        onSend={chat.send}
        busy={chat.working}
        disabled={!enabled || !org}
        notice={
          wsFailed
            ? "Couldn't load your workspace."
            : !enabled
              ? "An admin can turn chat on in workspace settings."
              : (chat.error ?? undefined)
        }
        placeholder="Ask a follow-up…"
        // The command input this view replaced had focus; without taking it here, focus lands on
        // the body and the keyboard has nowhere to go inside an open dialog.
        autoFocus
        className="shrink-0"
      />

      <div className="flex shrink-0 items-center gap-4 border-t px-3 py-2 text-2xs text-muted-foreground">
        <span>
          <Kbd className="mr-1.5 text-2xs">↵</Kbd>send
        </span>
        {chat.sessionId && (
          <button
            type="button"
            data-testid="palette-open-in-chat"
            onClick={() => {
              onClose()
              void navigate({
                to: "/chat",
                search: { session: chat.sessionId ?? undefined, model: undefined, ask: undefined },
              })
            }}
            className="hover:text-foreground"
          >
            Open in chat →
          </button>
        )}
        <span className="ml-auto">
          <Kbd className="mr-1.5 text-2xs">esc</Kbd>close
        </span>
      </div>
    </div>
  )
}
