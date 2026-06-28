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
import { PICKER_EMOJI } from "@/lib/emoji"
import { cn } from "@/lib/utils"
import { useCommentScope } from "./lib/comment-scope"

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
    if (autoFocus) ref.current?.focus()
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
  // 12.5px from md up. Backdrop + field share this, so the highlight stays aligned.
  const textBox = cn("px-2.5 py-1.5 pr-9 text-lg leading-relaxed md:text-sm", className)
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
    <div style={{ position: "relative" }}>
      <div className="relative rounded-md border border-input bg-card transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-accent">
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
        {multiline ? (
          <textarea {...handlers} className={fieldClass} />
        ) : (
          <input {...handlers} className={fieldClass} onClick={(e) => e.stopPropagation()} />
        )}
      </div>

      {/* Emoji picker: a one-tap grid of the common emoji. Typing :shortcode:
          works too (rendered on display); this is the no-memorization path. */}
      <button
        type="button"
        data-testid="emoji-trigger"
        title="Add emoji"
        aria-label="Add emoji"
        aria-expanded={emojiOpen}
        onClick={() => setEmojiOpen((o) => !o)}
        className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-base leading-none text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        🙂
      </button>
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
            className="absolute right-1.5 top-9 z-50 grid w-[244px] grid-cols-8 gap-0.5 rounded-lg border border-border bg-card p-1.5 shadow-[var(--shadow)]"
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
                className="grid size-7 place-items-center rounded text-lg leading-none hover:bg-hover"
              >
                {emo}
              </button>
            ))}
          </div>
        </>
      )}

      {menu && results.length > 0 && (
        <div className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-[200px] overflow-auto rounded-lg border border-border bg-card p-1 shadow-[var(--shadow)]">
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
                "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-foreground",
                i === active ? "bg-accent" : "bg-transparent",
              )}
            >
              <span className="text-sm font-semibold">
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
  personal,
}: {
  quote: string | null
  onSubmit: (t: string, mentions: Mention[]) => void
  onCancel: () => void
  /** Personal tab: a private note for you + your agents — reflected in the copy. */
  personal?: boolean
}) {
  const [text, setText] = useState("")
  const [mentions, setMentions] = useState<Mention[]>([])
  const submit = (resolved: Mention[]) => {
    if (text.trim()) onSubmit(text, resolved)
  }
  return (
    <div className="overflow-hidden rounded-lg border border-primary bg-card shadow-[var(--shadow)]">
      {quote && (
        // Phones get a longer multi-line preview of what you're commenting on; the
        // desktop margin composer stays a tight single line.
        <div className="block w-full break-words border-l-[3px] border-primary bg-accent px-2.5 py-1.5 text-left text-xs italic text-foreground line-clamp-4 md:line-clamp-1">
          “{quote}”
        </div>
      )}
      <div className="p-2.5">
        <MentionField
          multiline
          autoFocus
          testId="composer-input"
          className="min-h-[56px] resize-y"
          value={text}
          onChange={setText}
          mentions={mentions}
          onMentions={setMentions}
          onSubmit={submit}
          onCancel={onCancel}
          placeholder={
            personal
              ? "Add a personal note… (@ to mention)"
              : quote
                ? "Comment on the selection… (@ to mention)"
                : "Add a comment… (@ to mention)"
          }
        />
        {personal && (
          <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Icon name="lock" size={11} />
            Visible only to you and the agents you've connected.
          </div>
        )}
        <div className="mt-1.5 flex gap-1.5">
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            disabled={!text.trim()}
            data-testid="composer-submit"
            onClick={() => submit(mentions.filter((m) => text.includes(`@${m.name}`)))}
          >
            {personal ? "Post note" : "Comment"}
          </Button>
          <Button variant="outline" size="sm" data-testid="composer-cancel" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

// Collapsed rail: a thin column of dots, each beside its comment's text.
