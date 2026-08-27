import { useQuery } from "@tanstack/react-query"
import { ArrowUp } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { api, type DirUser, type Mention } from "@/api"
import { workspaceSettingsQuery } from "@/lib/queries"

/** The reserved mention id for the built-in agent — the same string the server answers as
 *  (lib/comment-turn.ts), so "who was mentioned" and "who replied" are one identity. */
const DERIVE_MENTION_ID = "derive"

import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PICKER_EMOJI } from "@/lib/emoji"
import { useIsMobile } from "@/lib/use-is-mobile"
import { cn } from "@/lib/utils"
import { useCommentScope } from "./lib/comment-scope"
import { quoteChipClass } from "./quote-chip"

// Split the composer text into plain / mention runs for the highlight backdrop.
// React renders each run (escaping text itself, so no innerHTML), and the inline
// call is auto-memoised by the React Compiler. Longest names first so "@Ann"
// inside "@Annie" can't shadow the longer match.
type Run = { text: string; mention: boolean }
function splitMentions(text: string, mentions: Mention[]): Run[] {
  const names = [...new Set(mentions.map((m) => m.name))].sort((a, b) => b.length - a.length)
  if (!names.length) return [{ text, mention: false }]
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const re = new RegExp(`@(?:${alt})`, "g")
  const runs: Run[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) runs.push({ text: text.slice(last, i), mention: false })
    runs.push({ text: m[0], mention: true })
    last = i + m[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last), mention: false })
  // A trailing newline gets no height under white-space:pre-wrap, so pad it with a
  // zero-width space to keep the backdrop the same line count as the textarea.
  if (text.endsWith("\n")) runs.push({ text: "​", mention: false })
  return runs
}

// New-comment composer (anchored or general).
/**
 * A text control with @mention autocomplete. Typing "@" opens a live directory
 * popover (/v1/users); picking inserts "@Name " and records the user's id. The
 * picker — not a server-side @name parse — is the source of mention ids, so the
 * data is unambiguous. Mentions whose inserted "@Name" is later deleted from the
 * text are dropped at submit time. Enter submits and Shift+Enter breaks the line
 * (the Notion/Slack chat grammar) — one rule for the composer and replies alike,
 * instead of the old Enter-newline/Cmd+Enter-submit split nobody could guess.
 */
export function MentionField({
  value,
  onChange,
  mentions,
  onMentions,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
  multiline,
  className,
  style,
  testId,
  sendTestId,
  bare,
}: {
  value: string
  onChange: (v: string) => void
  mentions: Mention[]
  onMentions: (m: Mention[]) => void
  /** Receives the mentions still present in the text (deleted ones pruned). */
  onSubmit: (resolved: Mention[]) => void
  onCancel?: () => void
  placeholder?: string
  autoFocus?: boolean
  multiline?: boolean
  className?: string
  style?: CSSProperties
  testId?: string
  /** Render an in-well ↑ send button (the thread reply grammar: the field carries
   *  its own send, nothing floats outside the well). Appears once there's text.
   *  Replaces the emoji trigger — the two share the right rail, and :shortcodes:
   *  still cover emoji here. */
  sendTestId?: string
  /** No border/ring of its own — for a field living inside a container that
   *  already draws the edge (the thread card's reply line). A bordered well
   *  inside a bordered card stacked three edges in twenty pixels. Focus shows
   *  as a quiet wash; the caret does the rest. */
  bare?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const { shortId } = useCommentScope()
  // Is @derive worth offering? Same flag, same cached read the artifact page already made
  // (staleTime keeps this a cache hit, not a second request).
  // surface-ignore: an ambient read that degrades to "Derive is not offered in the picker".
  // A failure here costs one optional menu row; every other mention keeps working, so a
  // page-level error state would be wildly out of proportion to what was lost.
  const chatEnabled =
    useQuery({ ...workspaceSettingsQuery(), staleTime: 60_000 }).data?.chatBeta === true
  const isMobile = useIsMobile()
  const [menu, setMenu] = useState<{ at: number; end: number; q: string } | null>(null)
  const [results, setResults] = useState<DirUser[]>([])
  const [active, setActive] = useState(0)
  const [emojiOpen, setEmojiOpen] = useState(false)

  // Insert an emoji at the caret (replacing any selection), then restore focus.
  const insertEmoji = (emo: string) => {
    const el = ref.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? start
    onChange(value.slice(0, start) + emo + value.slice(end))
    setEmojiOpen(false)
    const pos = start + emo.length
    requestAnimationFrame(() => {
      const e = ref.current
      if (e) {
        e.focus()
        e.setSelectionRange(pos, pos)
      }
    })
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!autoFocus || !el) return
    el.focus()
    // Place the caret AT THE END of any seeded text (e.g. the "@Agent " an agent
    // request pre-fills) — `focus()` alone leaves the caret position browser-defined
    // (Safari/Firefox can land it at 0), which would drop typing before the mention.
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [autoFocus])

  // Fetch directory matches as the @query under the caret changes.
  useEffect(() => {
    if (!menu) {
      setResults([])
      return
    }
    let cancelled = false
    api
      .users(menu.q, shortId ?? undefined)
      .then((r) => {
        if (!cancelled) {
          // DERIVE IS PINNED FIRST when chat is on. It is not a directory row — there is no
          // agent record, no seat and no owner — so it is added here rather than returned by
          // the people search, which is exactly what keeps it from needing to be administered.
          // The contrast with the rows below it is the feature: Derive answers in the thread
          // now, a registered agent's mention waits in its pull inbox, a person gets a bell.
          const derive: DirUser[] =
            chatEnabled && "derive".startsWith(menu.q.toLowerCase())
              ? [{ id: DERIVE_MENTION_ID, name: "Derive", handle: "derive" } as DirUser]
              : []
          setResults([...derive, ...r.users.filter((u) => u.id !== DERIVE_MENTION_ID)].slice(0, 6))
          setActive(0)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [menu, shortId, chatEnabled])

  // Is the caret sitting at the end of an "@token"? If so, open the popover.
  const detect = (el: HTMLTextAreaElement | HTMLInputElement) => {
    const caret = el.selectionStart ?? el.value.length
    const m = /(?:^|\s)@([\w.-]{0,30})$/.exec(el.value.slice(0, caret))
    if (m) {
      const tok = m[1] ?? ""
      setMenu({ at: caret - tok.length - 1, end: caret, q: tok })
    } else setMenu(null)
  }

  const choose = (u: DirUser) => {
    if (!menu) return
    const before = value.slice(0, menu.at)
    // Mention by handle (the stable public identity); fall back to display name / id.
    const label = u.handle ?? u.name ?? u.id
    const insert = `@${label} `
    onChange(before + insert + value.slice(menu.end))
    if (!mentions.some((m) => m.id === u.id)) onMentions([...mentions, { id: u.id, name: label }])
    setMenu(null)
    const pos = before.length + insert.length
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  // Mentions whose "@Name" survived edits are the real ones.
  const resolve = () => mentions.filter((m) => value.includes(`@${m.name}`))
  const submit = () => {
    if (value.trim()) onSubmit(resolve())
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (menu && results.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActive((a) => (a + 1) % results.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setActive((a) => (a - 1 + results.length) % results.length)
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const sel = results[active]
        if (sel) choose(sel)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    if (e.key === "Escape") {
      onCancel?.()
      return
    }
    // Enter sends; Shift+Enter inserts a newline (falls through to the textarea's
    // default). Cmd/Ctrl+Enter still sends, for the muscle memory. On a PHONE the
    // keyboard has no Shift+Enter, so Enter keeps its newline meaning there and
    // the visible Comment/Reply button is the send.
    if (e.key === "Enter" && !e.shiftKey && (!isMobile || !multiline)) {
      e.preventDefault()
      submit()
    }
  }

  // The FIELD's own text is the visible text — the caret and what you read are the
  // same layout by construction and can never drift apart. The backdrop clones the
  // text INVISIBLY (transparent) purely for metrics, painting only the tint boxes
  // behind mention runs (see .mention-live). The old inverse arrangement (visible
  // clone under a transparent field) put the caret one line off whenever the clone's
  // scroll or wrap diverged. Both share `textBox` exactly, or a tint box drifts off
  // its tag — now a cosmetic pixel, never a broken input.
  // 16px on phones so iOS doesn't zoom the page when the field focuses; the usual
  // 14px control base from md up.
  const textBox = cn("px-2.5 py-1.5 pr-9 text-base md:text-sm", className)
  const handlers = {
    ref,
    "data-testid": testId,
    value,
    placeholder,
    onChange: (e: { target: HTMLTextAreaElement | HTMLInputElement }) => {
      onChange(e.target.value)
      detect(e.target)
    },
    onKeyUp: (e: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      // Caret moves (arrows/click) can leave or re-enter a token.
      if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") detect(e.currentTarget)
    },
    onKeyDown,
    onScroll: (e: { currentTarget: HTMLElement }) => {
      const b = backdropRef.current
      if (b) {
        b.scrollTop = e.currentTarget.scrollTop
        b.scrollLeft = e.currentTarget.scrollLeft
      }
    },
    style,
  }
  const fieldClass = cn(
    "relative block w-full bg-transparent outline-none placeholder:text-muted-foreground",
    textBox,
  )

  // Sync the metrics clone's scroll AFTER React commits its new content, too. The
  // field's scroll event alone loses a race: typing auto-scrolls the field and the
  // event fires BEFORE the clone re-renders taller, so the sync clamps against the
  // stale, shorter clone and nothing ever corrects it — that was the permanent
  // one-line drift (then of the caret; now it could only nudge a tint box).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync on every value commit.
  useLayoutEffect(() => {
    const el = ref.current
    const b = backdropRef.current
    if (!el || !b) return
    b.scrollTop = el.scrollTop
    b.scrollLeft = el.scrollLeft
  }, [value])

  return (
    <div className="relative">
      {/* Editable focus grammar (mirrors ui/textarea): ink border + soft glow —
          unless `bare`, where the surrounding card is the edge and focus is a
          quiet wash. */}
      <div
        className={cn(
          "relative rounded-lg",
          bare
            ? "focus-within:bg-secondary/60"
            : "border border-input bg-transparent focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 dark:bg-input/30",
        )}
      >
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={cn(
            // text-transparent: this clone exists for metrics only; the mention
            // spans paint their tint boxes, the field paints the text.
            "pointer-events-none absolute inset-0 overflow-hidden text-transparent",
            multiline ? "whitespace-pre-wrap break-words" : "whitespace-pre",
            textBox,
          )}
        >
          {splitMentions(value, mentions).map((run, i) =>
            run.mention ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are a pure derivation of `value`, fully rebuilt each render.
              <span key={i} className="mention-live">
                {run.text}
              </span>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              <span key={i}>{run.text}</span>
            ),
          )}
        </div>
        {/* Raw elements (the mention backdrop needs them), so they carry the
            password-manager ignore set themselves — see ui/input for why. */}
        {multiline ? (
          // break-words + no scrollbar: the field must wrap at EXACTLY the clone's
          // width (the clone never shows a scrollbar), or a long token puts the
          // tint boxes on the wrong line.
          <textarea
            {...handlers}
            data-1p-ignore="true"
            data-lpignore="true"
            className={cn(fieldClass, "break-words [scrollbar-width:none]")}
          />
        ) : (
          <input
            {...handlers}
            data-1p-ignore="true"
            data-lpignore="true"
            className={fieldClass}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>

      {/* In-well send (thread replies): the ↑ ink button rides the well's bottom-
          right and tracks the field as it grows — Enter does the same thing. It
          appears with the first character; an always-on disabled blob is noise. */}
      {sendTestId && value.trim() && (
        <Button
          type="button"
          variant="default"
          size="icon-xs"
          data-testid={sendTestId}
          aria-label="Send"
          // mousedown-preventDefault keeps the field focused through the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={submit}
          className="absolute bottom-1 right-1 size-6 rounded-md"
        >
          <ArrowUp aria-hidden className="size-3.5" />
        </Button>
      )}

      {/* Emoji picker: a one-tap grid of the common emoji. Typing :shortcode:
          works too (rendered on display); this is the no-memorization path.
          A Tooltip (not a title attr) labels the icon-only trigger — safe here
          because the button is a plain toggle, not another asChild trigger. */}
      {!sendTestId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="emoji-trigger"
              aria-label="Add emoji"
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((o) => !o)}
              className="absolute right-1 top-1 text-muted-foreground"
            >
              {/* Explicit size-4 class: icon-xs would otherwise downscale a bare svg. */}
              <Icon name="react" className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add emoji</TooltipContent>
        </Tooltip>
      )}
      {!sendTestId && emojiOpen && (
        <>
          {/* click-catcher to dismiss */}
          <button
            type="button"
            data-testid="emoji-picker-backdrop"
            aria-label="Close emoji picker"
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setEmojiOpen(false)}
          />
          <div
            data-testid="emoji-picker"
            className="absolute right-1.5 top-9 z-50 grid w-61 grid-cols-8 gap-0.5 rounded-xl bg-popover p-1.5 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10"
          >
            {PICKER_EMOJI.map((emo) => (
              <button
                key={emo}
                type="button"
                aria-label={`Insert ${emo} emoji`}
                data-testid="emoji-option"
                // mousedown only prevents the textarea from losing focus; the
                // actual insert is onClick so keyboard (Enter/Space) works too.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertEmoji(emo)}
                className="grid size-7 place-items-center rounded-md text-lg leading-none outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                {emo}
              </button>
            ))}
          </div>
        </>
      )}

      {menu && results.length > 0 && (
        <div className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-50 overflow-auto rounded-xl bg-popover p-1 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10">
          {results.map((u, i) => (
            <button
              key={u.id}
              type="button"
              data-testid={`mention-option-${u.id}`}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(u)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-foreground outline-none focus-visible:bg-accent",
                i === active ? "bg-accent" : "bg-transparent",
              )}
            >
              <span className="text-sm font-medium">
                {u.name ?? (u.handle ? `@${u.handle}` : "")}
              </span>
              {u.name && u.handle && (
                <span className="font-mono text-2xs text-muted-foreground">@{u.handle}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Composer({
  quote,
  answering,
  onSubmit,
  onCancel,
}: {
  quote: string | null
  /** The pending review round this text answers (the phone sheet's send-back): the
   *  verb becomes "Send back", and an empty note is a valid answer. */
  answering?: { by: string | null; version: number } | null
  onSubmit: (t: string, mentions: Mention[]) => void
  onCancel: () => void
}) {
  // Starts empty; @mention anyone (including an agent) by typing. The composer unmounts
  // between opens (it only renders for a live composer), so this initial state resets
  // each time.
  const [text, setText] = useState("")
  const [mentions, setMentions] = useState<Mention[]>([])
  const submit = (resolved: Mention[]) => {
    if (answering || text.trim()) onSubmit(text, resolved)
  }
  return (
    <div
      data-testid="comment-composer"
      className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow)]"
    >
      {answering && (
        <div className="px-3 pt-2.5">
          <Badge variant="brand" className="max-w-full">
            <Icon name="review" />
            <span className="truncate">
              Answering {answering.by ? `${answering.by}'s` : "the"} review of v{answering.version}
            </span>
          </Badge>
        </div>
      )}
      {quote && (
        // Inset with the card's padding (the reference is context, not a banner).
        // Phones get a longer multi-line preview of what you're commenting on; the
        // desktop margin composer stays a tight single line.
        <div className="px-3 pt-2.5">
          <div
            className={quoteChipClass({
              className: "block w-full break-words line-clamp-4 md:line-clamp-1",
            })}
          >
            “{quote}”
          </div>
        </div>
      )}
      <div className="p-2.5">
        <MentionField
          multiline
          autoFocus
          testId="composer-input"
          // field-sizing-content: the box grows with the text (to a cap, then
          // scrolls) instead of trapping a multi-line comment in a two-line
          // window. resize-y stays as the manual override.
          className="field-sizing-content min-h-14 max-h-48 resize-y"
          value={text}
          onChange={setText}
          mentions={mentions}
          onMentions={setMentions}
          onSubmit={submit}
          onCancel={onCancel}
          placeholder={
            answering
              ? 'Answers, asks, or "good to go — ship it"'
              : quote
                ? "Comment on the selection… (@ to mention)"
                : "Add a comment… (@ to mention)"
          }
        />
        {/* The send is right-aligned and compact (a full-width filled bar made the
            composer bottom-heavy); the ↵ hint teaches the chat grammar quietly.
            Phones hide it — Enter is a newline there and the button is the send. */}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="inline-flex select-none items-center gap-1 font-mono text-2xs text-muted-foreground max-sm:hidden">
            <Kbd>↵</Kbd> to send
          </span>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" data-testid="composer-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!answering && !text.trim()}
            data-testid={answering ? "review-send-back" : "composer-submit"}
            onClick={() => submit(mentions.filter((m) => text.includes(`@${m.name}`)))}
          >
            {answering ? "Send back" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  )
}
