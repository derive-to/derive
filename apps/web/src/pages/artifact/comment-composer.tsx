import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { api, type DirUser, type Mention } from "@/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

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
  const [menu, setMenu] = useState<{ at: number; end: number; q: string } | null>(null)
  const [results, setResults] = useState<DirUser[]>([])
  const [active, setActive] = useState(0)

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
      .users(menu.q)
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
  }, [menu])

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
    const insert = `@${u.name} `
    onChange(before + insert + value.slice(menu.end))
    if (!mentions.some((m) => m.id === u.id)) onMentions([...mentions, { id: u.id, name: u.name }])
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

  const shared = {
    ref,
    className: cn(
      "w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-accent",
      className,
    ),
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
    style,
  }

  return (
    <div style={{ position: "relative" }}>
      {multiline ? (
        <textarea {...shared} />
      ) : (
        <input {...shared} onClick={(e) => e.stopPropagation()} />
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
              <span className="text-sm font-semibold">{u.name}</span>
              <span className="font-mono text-2xs text-muted-foreground">{u.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// New-comment composer (anchored or general).
export function Composer({
  quote,
  onSubmit,
  onCancel,
}: {
  quote: string | null
  onSubmit: (t: string, mentions: Mention[]) => void
  onCancel: () => void
}) {
  const [text, setText] = useState("")
  const [mentions, setMentions] = useState<Mention[]>([])
  const submit = (resolved: Mention[]) => {
    if (text.trim()) onSubmit(text, resolved)
  }
  return (
    <div className="overflow-hidden rounded-lg border border-primary bg-card shadow-[var(--shadow)]">
      {quote && (
        <div className="block w-full truncate border-l-[3px] border-primary bg-accent px-2.5 py-1.5 text-left text-xs italic text-foreground">
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
            quote ? "Comment on the selection… (@ to mention)" : "Add a comment… (@ to mention)"
          }
        />
        <div className="mt-1.5 flex gap-1.5">
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            disabled={!text.trim()}
            data-testid="composer-submit"
            onClick={() => submit(mentions.filter((m) => text.includes(`@${m.name}`)))}
          >
            Comment
          </Button>
          <Button variant="outline" size="sm" data-testid="composer-cancel" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
