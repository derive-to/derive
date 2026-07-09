import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { api, type DirUser, type Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PICKER_EMOJI } from "@/lib/emoji"
import { cn } from "@/lib/utils"
import { useCommentScope } from "./lib/comment-scope"
import { quoteChipClass } from "./quote-chip"
import type { AgentTarget } from "./types"

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
 * text are dropped at submit time. Single-line submits on Enter; multiline on
 * Cmd/Ctrl+Enter (matching the surrounding composer/reply conventions).
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
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const { shortId } = useCommentScope()
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
          setResults(r.users.slice(0, 6))
          setActive(0)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [menu, shortId])

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
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }

  // The field's text is transparent; the highlight backdrop paints the same text
  // (with lit-up mentions) directly underneath, so a tag glows live as you type or
  // pick someone. Both share `textBox` exactly, or the highlight drifts off the caret.
  // 16px on phones so iOS doesn't zoom the page when the field focuses; the usual
  // 14px control base from md up. Backdrop + field share this, so the highlight
  // stays aligned.
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
    "relative block w-full bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground",
    textBox,
  )

  return (
    <div className="relative">
      {/* Editable focus grammar (mirrors ui/textarea): ink border + soft glow. */}
      <div className="relative rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 dark:bg-input/30">
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden text-foreground",
            multiline ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre",
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
          <textarea
            {...handlers}
            data-1p-ignore="true"
            data-lpignore="true"
            className={fieldClass}
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

      {/* Emoji picker: a one-tap grid of the common emoji. Typing :shortcode:
          works too (rendered on display); this is the no-memorization path.
          A Tooltip (not a title attr) labels the icon-only trigger — safe here
          because the button is a plain toggle, not another asChild trigger. */}
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
      {emojiOpen && (
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
  onSubmit,
  onCancel,
  agent,
}: {
  quote: string | null
  onSubmit: (t: string, mentions: Mention[]) => void
  onCancel: () => void
  /** Set when this is a revision REQUEST addressed to an agent — seeds the mention,
   *  reframes the copy, and posts so the request drops into the agent's MCP inbox. */
  agent?: AgentTarget
}) {
  // A request seeds `@Agent ` + the mention up front, so the note is addressed the
  // moment it opens; a plain comment starts empty. The composer unmounts between opens
  // (it only renders for a live composer), so this initial state re-seeds each time.
  // MentionField's autofocus drops the caret after the seed (see its setSelectionRange).
  const [text, setText] = useState(agent ? `@${agent.name} ` : "")
  const [mentions, setMentions] = useState<Mention[]>(
    agent ? [{ id: agent.id, name: agent.name }] : [],
  )
  const submit = (resolved: Mention[]) => {
    if (text.trim()) onSubmit(text, resolved)
  }
  return (
    <div
      data-testid={agent ? "agent-request-composer" : "comment-composer"}
      className={cn(
        "overflow-hidden rounded-lg border bg-card shadow-[var(--shadow)]",
        // A request reads as a distinct, ink-tinted moment (the one place the accent
        // carries a "hand this to an agent" action), not a plain neutral comment box.
        agent ? "border-primary/40 ring-1 ring-primary/15" : "border-border",
      )}
    >
      {agent && (
        <div className="flex items-center gap-1.5 border-b border-primary/20 bg-primary/5 px-2.5 py-1.5 text-sm font-medium text-foreground">
          <Icon name="sparkles" size={14} className="text-primary" />
          Ask {agent.name} to revise
        </div>
      )}
      {quote && (
        // Phones get a longer multi-line preview of what you're commenting on; the
        // desktop margin composer stays a tight single line.
        <div
          className={quoteChipClass({
            className: "block w-full break-words line-clamp-4 md:line-clamp-1",
          })}
        >
          “{quote}”
        </div>
      )}
      <div className="p-2.5">
        <MentionField
          multiline
          autoFocus
          testId="composer-input"
          className="min-h-14 resize-y"
          value={text}
          onChange={setText}
          mentions={mentions}
          onMentions={setMentions}
          onSubmit={submit}
          onCancel={onCancel}
          placeholder={
            agent
              ? "Describe the change… e.g. tighten this paragraph"
              : quote
                ? "Comment on the selection… (@ to mention)"
                : "Add a comment… (@ to mention)"
          }
        />
        <div className="mt-1.5 flex gap-1.5">
          <Button
            variant="default"
            size="sm"
            className="flex-1"
            disabled={!text.trim()}
            data-testid="composer-submit"
            onClick={() => submit(mentions.filter((m) => text.includes(`@${m.name}`)))}
          >
            {agent ? "Send request" : "Comment"}
          </Button>
          <Button variant="outline" size="sm" data-testid="composer-cancel" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
