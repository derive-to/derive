import { useNavigate } from "@tanstack/react-router"
import type { MouseEvent, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { Icon } from "@/components/icons"
import { cn } from "@/lib/utils"
import { mdToHtml } from "@/pages/artifact/lib/markdown"

// THE TRANSCRIPT, shared by every chat surface: the rail on a document and the workspace chat
// page render the same rows, the same thinking state and the same streaming bubble, because
// they are the same conversation with a different subject. What differs is the frame around it.

export interface ChatMessage {
  id: string
  author_kind: "asker" | "agent"
  body_md: string
  created_at: string
  /** The turn's structured payload on an agent message. Carries which MODEL answered, which is
   *  how a surface can show what a conversation is running on without a second request. */
  meta?: { model?: { id: string; label: string } } | null
}

/** Poll while a turn is in flight, stop when it settles. Cheap, and it survives a reload —
 *  which a websocket-only design would not, since the turn outlives the connection. */
export const POLL_MS = 900
/**
 * ...but once slices are arriving, back the poll right off.
 *
 * A streaming turn announces its own end (`session.settled` triggers an immediate read), so the
 * poll stops being the way the answer arrives and becomes purely the safety net for a dropped
 * stream. Every tick is a real request and a database read, so leaving it at 900ms would have
 * meant ~22 of them across a twenty-second answer that needed none. At 5s it is 4, and if the
 * stream really does die the reader waits at most that long.
 */
export const POLL_STREAMING_MS = 5_000

export function ChatThread(props: {
  messages: ChatMessage[]
  /** True while the agent owes a reply — drives the thinking row and the poll. */
  working: boolean
  /** The reply being written, when the gateway streams one. "" means nothing in flight, which
   *  is also what a non-streaming turn looks like — the surface falls back to the spinner. */
  streaming?: string
  /** What to show before the first message. */
  empty: ReactNode
  onPoll: () => void
  className?: string
  /** Wraps each row — the page centres its rows in a reading column while the scroll area
   *  stays full-bleed. Omitted, rows render as-is (the rail, which is already narrow). */
  row?: (children: ReactNode) => ReactNode
}) {
  const { messages, working, streaming, empty, onPoll, className, row } = props
  const endRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const wrap = row ?? ((c: ReactNode) => c)

  // An answer's citations are ROOT-RELATIVE anchors inside markdown we rendered (see mdToHtml),
  // so a plain click would reload the whole SPA to open a document that is one route away.
  // Caught here, once, for every row: external links (they carry target=_blank) and modified
  // clicks (open-in-new-tab, which people do deliberately) are left entirely alone.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a")
    if (!a || a.target === "_blank") return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    const href = a.getAttribute("href")
    if (!href?.startsWith("/")) return
    e.preventDefault()
    void navigate({ to: href })
  }

  // Follow the tail as turns land. Depends on the message COUNT (and the working flag, which
  // adds the thinking row) — with empty deps this fired on mount only and every reply landed
  // below the fold.
  // These deps are the CHANGE SIGNAL to scroll on, not values the body reads.
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

  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto", className)} onClick={onClick}>
      {messages.length === 0 ? (
        empty
      ) : (
        <div className="space-y-3">
          {messages.map((m) => (
            <div key={m.id}>{wrap(<Bubble msg={m} />)}</div>
          ))}
          {/* The reply as it is being written. Once any of it has arrived it REPLACES the
              thinking row — a spinner sitting under text that is visibly streaming reads as a
              second, stalled turn. Falls back to the spinner while the model has not emitted
              yet, and whenever nothing is streaming at all, so a turn with no deltas looks
              exactly as it always did. */}
          {streaming ? wrap(<Streaming text={streaming} />) : working ? wrap(<Thinking />) : null}
          <div ref={endRef} />
        </div>
      )}
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
