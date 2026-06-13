import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { api, type Comment, type DirUser, type Mention } from "@/api"
import { ColoredAvatar } from "@/components/shared/colored-avatar"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { useActions } from "./comment-actions"
import { anchorExact, COMPOSER_ID, layoutPins } from "./lib/layout"
import { mdToHtml } from "./lib/markdown"
import { REACTION_EMOJI } from "./lib/reactions"
import type { PinItem, Sel } from "./types"

export function PinnedZone({
  pins,
  composer,
  activeThread,
  hoverThread,
  inDoc,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
  onSubmitNew,
  onCancelNew,
}: {
  pins: PinItem[]
  composer: { anchor: Sel | null; top: number | null } | null
  activeThread: string | null
  hoverThread: string | null
  inDoc: Record<string, boolean>
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
}) {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const obs = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    obs.current = new ResizeObserver((entries) => {
      setHeights((h) => {
        let changed = false
        const next = { ...h }
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.pin
          if (!id) continue
          const hh = Math.round((e.target as HTMLElement).offsetHeight)
          if (next[id] !== hh) {
            next[id] = hh
            changed = true
          }
        }
        return changed ? next : h
      })
    })
    return () => obs.current?.disconnect()
  }, [])
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) obs.current?.observe(el)
  }, [])

  // A composer for a new anchored comment joins the same layout as a pinned
  // item that owns priority, so neighbouring cards flow around it instead of
  // colliding with it.
  const composing = !!(composer?.anchor && composer?.top != null)
  const items = pins.map((p) => ({ id: p.thread[0].thread_id, desiredY: p.desiredY }))
  if (composing) items.push({ id: COMPOSER_ID, desiredY: composer!.top! })
  const activeId = composing ? COMPOSER_ID : activeThread
  const pos = layoutPins(items, heights, activeId, 12)

  return (
    <div className="absolute inset-0 overflow-hidden">
      {pins.map((p) => {
        const id = p.thread[0].thread_id
        const active = !composing && activeThread === id
        const y = pos[id] ?? p.desiredY
        return (
          <div
            key={id}
            ref={measure}
            data-pin={id}
            className="absolute inset-x-2.5 top-0 transition-transform duration-[180ms]"
            style={{
              transform: `translateY(${Math.round(y)}px)`,
              zIndex: active ? 6 : hoverThread === id ? 4 : 2,
              opacity: p.located ? 1 : 0,
            }}
          >
            <CommentCard
              thread={p.thread}
              active={active}
              hovered={hoverThread === id}
              present={inDoc[id]}
              onActivate={onActivate}
              onHover={onHover}
              onResolve={onResolve}
              onReply={onReply}
              onJump={onJump}
            />
          </div>
        )
      })}
      {composing && (
        <div
          ref={measure}
          data-pin={COMPOSER_ID}
          className="absolute inset-x-2.5 top-0 z-10 transition-transform duration-[180ms]"
          style={{ transform: `translateY(${Math.round(pos[COMPOSER_ID] ?? composer!.top!)}px)` }}
        >
          <Composer
            quote={composer!.anchor?.exact ?? null}
            onSubmit={onSubmitNew}
            onCancel={onCancelNew}
          />
        </div>
      )}
    </div>
  )
}

// Stack a set of cards by desired Y without overlap. The active card is pinned
// to its exact anchor and its neighbours are pushed up/down to make room.
export function CommentRow({ c, compact }: { c: Comment; compact?: boolean }) {
  const A = useActions()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.body_md)
  const [open, setOpen] = useState<null | "react" | "menu">(null)
  const mine = !!A.meName && c.author === A.meName
  const reactions = c.reactions ?? {}

  if (c.deleted)
    return (
      <div className={cn("px-3 py-2.5", !compact && "border-b border-border-soft")}>
        <span className="text-sm italic text-muted-foreground">Comment deleted</span>
      </div>
    )

  return (
    <div
      data-testid="comment-row"
      className={cn("group relative px-3 py-2.5", !compact && "border-b border-border-soft")}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <ColoredAvatar name={c.author} />
        <span className="text-xs font-bold text-foreground">{c.author}</span>
        <span className="ml-auto font-mono text-2xs text-muted-foreground">
          {ago(c.created_at)}
          {c.edited ? " · edited" : ""}
        </span>
      </div>

      {editing ? (
        <div onClick={(e) => e.stopPropagation()}>
          <Textarea
            value={draft}
            autoFocus
            data-testid="comment-edit-input"
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[52px] resize-y text-sm"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditing(false)
                setDraft(c.body_md)
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                void A.edit(c.id, draft)
                setEditing(false)
              }
            }}
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button
              variant="primary"
              size="sm"
              disabled={!draft.trim()}
              data-testid="comment-edit-save"
              onClick={async () => {
                await A.edit(c.id, draft)
                setEditing(false)
              }}
            >
              Save
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(false)
                setDraft(c.body_md)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "cmt-body text-sm leading-relaxed [word-break:break-word]",
            compact && "line-clamp-2",
          )}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped first in mdToHtml.
          dangerouslySetInnerHTML={{ __html: mdToHtml(c.body_md, c.mentions) }}
        />
      )}

      {Object.keys(reactions).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {Object.entries(reactions).map(([emoji, who]) => (
            <button
              key={emoji}
              type="button"
              data-testid={`reaction-pill-${emoji}`}
              title={who.join(", ")}
              onClick={(e) => {
                e.stopPropagation()
                A.react(c.id, emoji)
              }}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors",
                who.includes(A.meName)
                  ? "border-primary bg-accent font-bold text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-primary",
              )}
            >
              <span>{emoji}</span>
              <span className="font-mono text-2xs">{who.length}</span>
            </button>
          ))}
        </div>
      )}

      {!editing && (
        <div
          className={cn(
            "absolute right-2 top-1.5 z-[6] flex gap-px rounded-[9px] border border-border bg-card p-0.5 shadow-[var(--shadow)] transition-opacity",
            open
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Popover open={open === "react"} onOpenChange={(o) => setOpen(o ? "react" : null)}>
            <PopoverTrigger asChild>
              <button
                type="button"
                title="React"
                data-testid="comment-react"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
              >
                😊
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-1">
              <div className="grid grid-cols-4 gap-px">
                {REACTION_EMOJI.map((em) => (
                  <button
                    key={em}
                    type="button"
                    data-testid={`react-emoji-${em}`}
                    onClick={() => {
                      A.react(c.id, em)
                      setOpen(null)
                    }}
                    className="grid size-[30px] place-items-center rounded-md text-lg hover:bg-hover"
                  >
                    {em}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Popover open={open === "menu"} onOpenChange={(o) => setOpen(o ? "menu" : null)}>
            <PopoverTrigger asChild>
              <button
                type="button"
                title="More"
                data-testid="comment-more"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
              >
                ⋯
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto min-w-[132px] p-1">
              {mine && (
                <button
                  type="button"
                  data-testid="comment-edit"
                  onClick={() => {
                    setEditing(true)
                    setOpen(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-hover"
                >
                  ✎ Edit
                </button>
              )}
              <button
                type="button"
                data-testid="comment-copy-link"
                onClick={() => {
                  A.copyLink(c.thread_id)
                  setOpen(null)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-hover"
              >
                🔗 Copy link
              </button>
              {mine && (
                <button
                  type="button"
                  data-testid="comment-delete"
                  onClick={() => {
                    A.remove(c.id)
                    setOpen(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-hover hover:text-destructive"
                >
                  🗑 Delete
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  )
}

// One comment thread. Compact until activated; the active card shows the full
// thread, a reply box, and resolve controls.
export function CommentCard({
  thread,
  active,
  hovered,
  present,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
}: {
  thread: Comment[]
  active: boolean
  hovered: boolean
  present?: boolean
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
}) {
  const [reply, setReply] = useState("")
  const [replyMentions, setReplyMentions] = useState<Mention[]>([])
  const root = thread[0]
  const sendReply = (resolved: Mention[]) => {
    if (!reply.trim()) return
    onReply(reply, root.thread_id, resolved)
    setReply("")
    setReplyMentions([])
  }
  const resolved = root.state === "resolved"
  const quote = anchorExact(root.anchor)
  const textPresent = present !== undefined ? present : root.anchored !== false
  const replies = thread.length - 1

  return (
    <div
      data-testid="comment-card"
      onMouseEnter={() => onHover(root.thread_id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => !active && onActivate(root.thread_id)}
      className={cn(
        "cmt-card overflow-hidden rounded-lg border bg-card transition-[box-shadow,border-color]",
        active
          ? "cursor-default border-primary shadow-[var(--shadow)]"
          : hovered
            ? "cursor-pointer border-primary/40 shadow-[0_4px_14px_-8px_rgba(0,0,0,0.45)]"
            : "cursor-pointer border-border",
        resolved && !active && "opacity-60",
      )}
    >
      {quote &&
        (textPresent && !resolved ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onJump(root.thread_id)
            }}
            title="Jump to the highlighted text"
            className="block w-full cursor-pointer truncate border-l-[3px] border-primary bg-accent px-2.5 py-1.5 text-left text-xs italic text-foreground"
          >
            “{quote}”
          </button>
        ) : (
          <div
            title="The text this comment was attached to was edited or removed in this version"
            className="block w-full truncate border-l-[3px] border-border bg-secondary px-2.5 py-1.5 text-left text-xs italic text-muted-foreground"
          >
            “{quote}”
          </div>
        ))}

      {!active ? (
        <>
          <CommentRow c={root} compact />
          {replies > 0 && (
            <div className="px-3 pb-2.5 font-mono text-2xs font-bold text-primary">
              {replies} repl{replies === 1 ? "y" : "ies"}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="max-h-[360px] overflow-auto">
            {thread.map((c) => (
              <CommentRow key={c.id} c={c} />
            ))}
          </div>
          <div className="flex gap-1.5 border-t border-border-soft px-3 py-2">
            <div className="flex-1" onClick={(e) => e.stopPropagation()}>
              <MentionField
                testId="comment-reply-input"
                value={reply}
                onChange={setReply}
                mentions={replyMentions}
                onMentions={setReplyMentions}
                onSubmit={sendReply}
                placeholder="Reply… (@ to mention)"
                autoFocus
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!reply.trim()}
              data-testid="comment-reply-send"
              onClick={(e) => {
                e.stopPropagation()
                sendReply(replyMentions.filter((m) => reply.includes(`@${m.name}`)))
              }}
            >
              Reply
            </Button>
          </div>
          <div className="flex items-center gap-1.5 bg-secondary px-3 py-1.5">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-2xs font-bold",
                resolved ? "bg-success/15 text-success" : "bg-accent text-primary",
              )}
            >
              {resolved ? "resolved" : "open"}
            </span>
            {quote && !textPresent && !resolved && (
              <span
                title="The text this comment was attached to was edited or removed in this version"
                className="rounded-full bg-accent px-2 py-0.5 font-mono text-2xs font-bold text-primary"
              >
                text changed
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              data-testid="comment-resolve"
              onClick={(e) => {
                e.stopPropagation()
                onResolve(root)
              }}
            >
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export function ResolvedSection({
  threads,
  activeThread,
  hoverThread,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
}: {
  threads: Comment[][]
  activeThread: string | null
  hoverThread: string | null
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="resolved-section-toggle"
        className="flex w-full items-center gap-1.5 px-0.5 py-1.5 font-mono text-2xs font-bold uppercase tracking-[0.06em] text-muted-foreground"
      >
        <span className={cn("transition-transform", open && "rotate-90")}>▸</span>
        Resolved ({threads.length})
      </button>
      {open &&
        threads.map((t) => (
          <div key={t[0].thread_id} className="mb-2.5">
            <CommentCard
              thread={t}
              active={activeThread === t[0].thread_id}
              hovered={hoverThread === t[0].thread_id}
              onActivate={onActivate}
              onHover={onHover}
              onResolve={onResolve}
              onReply={onReply}
              onJump={onJump}
            />
          </div>
        ))}
    </div>
  )
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
    if (m) setMenu({ at: caret - m[1].length - 1, end: caret, q: m[1] })
    else setMenu(null)
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
        choose(results[active])
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
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

// Collapsed rail: a thin column of dots, each beside its comment's text.
