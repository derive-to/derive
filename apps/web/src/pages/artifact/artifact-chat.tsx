import { useEffect, useRef, useState } from "react"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { mdToHtml } from "./lib/markdown"

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
/**
 * ...but once slices are arriving, back the poll right off.
 *
 * A streaming turn announces its own end (`session.settled` triggers an immediate read), so the
 * poll stops being the way the answer arrives and becomes purely the safety net for a dropped
 * stream. Every tick is a real request and a database read, so leaving it at 900ms would have
 * meant ~22 of them across a twenty-second answer that needed none. At 5s it is 4, and if the
 * stream really does die the reader waits at most that long.
 */
const POLL_STREAMING_MS = 5_000

export function ArtifactChat(props: {
  messages: ChatMessage[]
  /** True while the agent owes a reply — drives the thinking row and the poll. */
  working: boolean
  /** The reply being written, when the gateway streams one. "" means nothing in flight, which
   *  is also what a non-streaming turn looks like — the panel falls back to the spinner. */
  streaming?: string
  disabled?: boolean
  /** Why chat cannot be used, when it cannot (no model configured, no permission). */
  disabledReason?: string
  onSend: (body: string) => Promise<void>
  onPoll: () => void
}) {
  const { messages, working, streaming, disabled, disabledReason, onSend, onPoll } = props
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

  // Slices arriving means the stream is alive and will announce its own end, so the poll drops
  // to a safety net. It stays ON rather than switching off entirely: a stream that dies silently
  // would otherwise leave the turn hanging with nothing to recover it.
  const streamAlive = !!streaming
  useEffect(() => {
    if (!working) return
    const t = setInterval(onPoll, streamAlive ? POLL_STREAMING_MS : POLL_MS)
    return () => clearInterval(t)
  }, [working, streamAlive, onPoll])

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
            {/* The reply as it is being written. Once any of it has arrived it REPLACES the
                thinking row — a spinner sitting under text that is visibly streaming reads as a
                second, stalled turn. Falls back to the spinner while the model has not emitted
                yet, and whenever nothing is streaming at all, so a turn with no deltas looks
                exactly as it always did. */}
            {streaming ? <Streaming text={streaming} /> : working ? <Thinking /> : null}
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
      {/* The SAME renderer the comments rail uses. Rendering body_md raw showed the model's
          `**bold**` as literal asterisks in the one panel whose whole job is reading its prose,
          while the ask view beside it rendered the identical text correctly. mdToHtml escapes
          before it transforms, and it turns newlines into <br/>, so no pre-wrap here. */}
      <div
        className={cn(
          "cmt-body max-w-[85%] rounded-lg px-3 py-2 text-sm [word-break:break-word]",
          mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped first in mdToHtml.
        dangerouslySetInnerHTML={{ __html: mdToHtml(msg.body_md) }}
      />
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

/** The reply mid-write. Deliberately the SAME bubble an agent message renders into, so the
 *  moment the turn settles and the persisted message takes over there is no visual jump — the
 *  text simply stops growing. A caret marks it as still being written. */
function Streaming({ text }: { text: string }) {
  return (
    <div className="flex justify-start" data-testid="chat-streaming">
      <div className="cmt-body max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground [word-break:break-word]">
        {/* Markdown is rendered on the SETTLED message, not here: a half-arrived reply is
            half-arrived markup too (an unclosed fence, a dangling `**`), and running it through
            the renderer makes the text visibly thrash as it completes. Plain text with preserved
            whitespace streams calmly and lands on the identical bubble when the real one
            arrives. */}
        <span className="whitespace-pre-wrap">{text}</span>
        <span className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 animate-pulse bg-foreground/70" />
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
