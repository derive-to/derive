import { useEffect, useRef, useState } from "react"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// CHAT WITH THIS DOCUMENT — the right-rail sibling of the comments panel.
//
// Comments and chat are both "conversation about this document" and compete for the same
// rail, so they tab rather than stack. The difference that matters: a comment is anchored
// to a text range and a chat turn is not, so this panel never draws anchor highlights.
//
// The transcript is the source of truth, NOT the request: a turn is served detached, so
// closing the tab mid-turn loses nothing and this just re-polls. That is why there is no
// optimistic-only state here — the message appears once the server has it.

export interface ChatMessage {
  id: string
  author_kind: "asker" | "agent"
  body_md: string
  created_at: string
}

/** Poll while a turn is in flight, stop when it settles. Cheap, and it survives a reload —
 *  which a websocket-only design would not, since the turn outlives the connection. */
const POLL_MS = 900

export function ArtifactChat(props: {
  messages: ChatMessage[]
  /** True while the agent owes a reply — drives the thinking row and the poll. */
  working: boolean
  disabled?: boolean
  /** Why chat cannot be used, when it cannot (no model configured, no permission). */
  disabledReason?: string
  onSend: (body: string) => Promise<void>
  onPoll: () => void
}) {
  const { messages, working, disabled, disabledReason, onSend, onPoll } = props
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  // Follow the tail as turns land. Depends on the message COUNT (and the working flag, which
  // adds the thinking row) — with empty deps this fired on mount only and every reply landed
  // below the fold.
  // These deps are the CHANGE SIGNAL to scroll on, not values the body reads. With none, this
  // fired on mount only and every reply landed below the fold.
  // biome-ignore lint/correctness/useExhaustiveDependencies: change signal, see above
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages.length, working])

  useEffect(() => {
    if (!working) return
    const t = setInterval(onPoll, POLL_MS)
    return () => clearInterval(t)
  }, [working, onPoll])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending || disabled) return
    setSending(true)
    setDraft("")
    try {
      await onSend(body)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-chat">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <EmptyState
            icon={<Icon name="sparkles" />}
            title="Chat with this document"
            description="Ask a question about it, or ask for a change. Edits land as a new version you can undo."
          />
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} />
            ))}
            {working && <Thinking />}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border p-2.5">
        {disabled && disabledReason ? (
          <p className="px-1 pb-2 text-xs text-muted-foreground">{disabledReason}</p>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a newline — the convention every chat surface
              // shares, and the one people's fingers already expect.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            disabled={disabled || sending}
            rows={2}
            placeholder="Ask about this doc, or ask for a change…"
            // 16px on touch avoids iOS zoom-on-focus, matching the comment composer.
            className="max-h-40 min-h-[2.5rem] resize-none text-base sm:text-sm"
            data-testid="chat-input"
          />
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={disabled || sending || !draft.trim()}
            data-testid="chat-send"
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const mine = msg.author_kind === "asker"
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
          mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {msg.body_md}
      </div>
    </div>
  )
}

function Thinking() {
  return (
    <div className="flex justify-start" data-testid="chat-thinking">
      <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
        <Icon name="sparkles" className="size-3.5 animate-pulse" />
        Working…
      </div>
    </div>
  )
}

/** The rail's tab strip. Two tabs only, so this is a pair of buttons rather than a full
 *  Tabs primitive — it has to sit inline in the panel header the comments rail already owns. */
export function RailTabs(props: {
  tab: "comments" | "chat"
  commentCount: number
  onTab: (t: "comments" | "chat") => void
}) {
  const { tab, commentCount, onTab } = props
  return (
    <div className="flex items-center gap-1" data-testid="rail-tabs">
      {(["comments", "chat"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onTab(t)}
          aria-pressed={tab === t}
          className={cn(
            "rounded-md px-2 py-1 text-sm font-medium capitalize transition-colors",
            tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          data-testid={`rail-tab-${t}`}
        >
          {t}
          {t === "comments" && commentCount > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground">{commentCount}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
