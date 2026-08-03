import { useNavigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { isInAppPath } from "@/lib/in-app-path"
import { cn } from "@/lib/utils"
import { mdToHtml } from "@/pages/artifact/lib/markdown"
import { ANSWER_PROSE, answerMdToHtml } from "@/pages/context/lib/answer-md"

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
  meta?: { model?: { id: string; label: string }; tools?: string[] } | null
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
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const wrap = row ?? ((c: ReactNode) => c)
  // "Near enough" rather than exact: a couple of pixels of sub-pixel scroll drift should not
  // flip a control in and out of existence while somebody is reading.
  const [atBottom, setAtBottom] = useState(true)
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }, [])

  // CITATIONS OPEN IN-APP. An answer's citations are ROOT-RELATIVE anchors inside markdown we
  // rendered (see mdToHtml), so a plain click would reload the whole SPA to reach a document
  // one route away. This intercepts them once for every row.
  //
  // A NATIVE delegated listener rather than an onClick prop, because that is what this actually
  // is: the interactive elements are the anchors themselves (already focusable, already
  // keyboard-operable — Enter on a link dispatches a click, which bubbles to here), and the
  // scroll container is not a control. Hanging a React handler on the static div would claim
  // otherwise, which is exactly what the a11y rules object to.
  //
  // Left alone: external links (they carry target=_blank) and modified clicks (open-in-new-tab,
  // which people do deliberately).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onClick = (e: globalThis.MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest("a")
      if (!a || a.target === "_blank") return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      const href = a.getAttribute("href")
      // isInAppPath rather than startsWith("/"): `//evil.com` passes that test and is a
      // protocol-relative URL, so handing it to the router walks the reader off the origin. The
      // href comes from an answer, and an answer quotes documents anybody in the workspace can
      // author — so this is a planted link away from being an open redirect. An external link is
      // left to the browser, which is what the target=_blank check above already does.
      if (!isInAppPath(href)) return
      e.preventDefault()
      void navigate({ to: href })
    }
    el.addEventListener("click", onClick)
    return () => el.removeEventListener("click", onClick)
  }, [navigate])

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
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn("relative min-h-0 flex-1 overflow-y-auto", className)}
    >
      {/* READING BACK is a normal thing to do mid-answer, and the auto-scroll above fights it:
          every new row yanks the view to the bottom. This is the escape hatch — it appears only
          once you have actually scrolled away, so it costs nothing when you are already following
          along, and it is the one control that makes scrolling up safe. */}
      {!atBottom && messages.length > 0 && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
          className="sticky top-2 left-1/2 z-10 h-7 -translate-x-1/2 shadow-md"
          data-testid="chat-jump-latest"
        >
          ↓ Latest
        </Button>
      )}
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

/**
 * WHAT THE ANSWER ACTUALLY DID, in the words a reader thinks in.
 *
 * The empty state promises "Derive searches and reads with your own permissions, and links what
 * it used", and until the turn recorded its tools that was an assertion with nothing behind it:
 * an answer and a claim about how it was reached, indistinguishable from an answer made up.
 * Shown only when tools ran, so a turn that simply answered from the conversation does not
 * pretend otherwise.
 *
 * Tool NAMES translated rather than printed. "find" and "use" are our vocabulary, not anyone
 * else's, and an interface that leaks them asks the reader to learn the implementation.
 */
const TOOL_WORDS: Record<string, string> = {
  find: "searched the workspace",
  read: "read documents",
  publish: "wrote a document",
  use: "ran a packaged context",
}

const traceOf = (tools: string[] | undefined): string | null => {
  const words = (tools ?? []).map((t) => TOOL_WORDS[t]).filter(Boolean)
  if (words.length === 0) return null
  return words.length === 1
    ? `Derive ${words[0]}`
    : `Derive ${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const mine = msg.author_kind === "asker"
  const [copied, setCopied] = useState(false)
  const trace = mine ? null : traceOf(msg.meta?.tools)
  // The MARKDOWN, not the rendered text. What people paste an answer into is usually another
  // markdown surface (a document, a comment, an issue), so handing over the rendered form would
  // strip exactly the links and structure that made the answer worth keeping.
  const copy = () => {
    void navigator.clipboard?.writeText(msg.body_md).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className={cn("group flex items-start gap-1", mine ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[85%] flex-col gap-1", mine ? "items-end" : "items-start")}>
        {/* Above the answer, not inside it: it is provenance, not prose, and a reader scanning
            for the answer itself should be able to skip it in one glance. */}
        {trace && (
          <span className="px-1 text-muted-foreground text-xs" data-testid="chat-trace">
            {trace}
          </span>
        )}
        {/* TWO RENDERERS, because the two authors write differently — the same split the ask
          console makes, and for the same reason.

          An ANSWER is full GFM. Models write headings, bullet lists, fenced code and tables, and
          the comment renderer is deliberately inline-only: it knows bold, italic, code spans and
          links, and everything else it passes through as literal text with <br/> between the
          lines. So a three-bullet answer arrived as "- one" on its own line, and a fenced block
          as stray backticks — in the one panel whose entire job is reading the model's prose.
          answerMdToHtml is marked → xss whitelist, which is what the ask view has always used.

          A PERSON's message is not GFM and should not be reflowed as if it were, so it keeps the
          inline renderer: their line breaks stay theirs, and a stray "#" is a "#". */}
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm [word-break:break-word]",
            // The chrome has to match the MARKUP: an answer renders real <ul>/<h2>/<pre>, and the
            // comment bubble styles none of them, so a correct list came out unmarked under a
            // heading the same size as the body.
            mine
              ? "cmt-body bg-primary text-primary-foreground"
              : cn(ANSWER_PROSE, "bg-muted text-foreground"),
          )}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: mdToHtml escapes; answerMdToHtml is xss-whitelisted.
          dangerouslySetInnerHTML={{
            __html: mine ? mdToHtml(msg.body_md) : answerMdToHtml(msg.body_md),
          }}
        />
      </div>
      {/* ON THE ANSWER ONLY, and only on hover. A person's own message is already in their head;
          an answer is the thing they came to take away. Kept out of the flow until pointed at, so
          the transcript stays a transcript rather than a wall of controls. */}
      {!mine && (
        <Button
          size="icon"
          variant="ghost"
          onClick={copy}
          title={copied ? "Copied" : "Copy answer"}
          aria-label={copied ? "Copied" : "Copy answer"}
          className="mt-1 size-6 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          data-testid="chat-copy"
        >
          <Icon name={copied ? "check" : "copy"} className="size-3.5" />
        </Button>
      )}
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
      <div
        className={cn(
          ANSWER_PROSE,
          "max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground [word-break:break-word]",
        )}
      >
        {/* RENDERED AS IT ARRIVES, through the same renderer the settled message uses.
            This used to stream as plain text, on the reasoning that half-arrived markup thrashes
            as it completes. It does, slightly — but the thing a reader is actually shown while
            waiting is a citation written out as `[Q3 Roadmap](/artifacts/k9ffftpm)`, and bullets
            as literal hyphens, for the entire several seconds an answer takes. Trading a brief
            reflow for prose that reads like prose is the better side of that deal, and it also
            means the bubble no longer changes shape at the moment the turn settles.
            marked tolerates incomplete input, so a dangling `**` is simply literal until it
            closes. */}
        <span
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by answerMdToHtml.
          dangerouslySetInnerHTML={{ __html: answerMdToHtml(text) }}
        />
        <span className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 animate-pulse bg-foreground/70" />
      </div>
    </div>
  )
}
