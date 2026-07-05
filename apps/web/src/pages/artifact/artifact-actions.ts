import type { QueryClient } from "@tanstack/react-query"
import type { Dispatch, SetStateAction } from "react"
import { api, type Comment, type Mention } from "@/api"
import { toast } from "@/components/ui/sonner"
import { commentsQuery } from "@/lib/queries"
import type { CommentActions } from "./comment-actions"
import { toggleReaction } from "./lib/reactions"
import type { AgentTarget, ComposerState, Sel, Selection } from "./types"

type Me = { name?: string | null; email?: string | null } | null

/**
 * Every mutating action the artifact page drives: editing (publish a version /
 * submit a proposal), the comment loop (add / reply / resolve / react / edit /
 * delete / copy-link), thread activation + the comment-on-selection composer, and
 * version restore. Lifted out of the page so it holds the wiring; `nav` is
 * decoupled as `onRestoredJump` so the hook stays router-type-free.
 */
export function artifactActions(p: {
  shortId: string
  art: { title?: string | null; short_id: string; current_version: number }
  qc: QueryClient
  me: Me
  src: string
  title: string
  proposeMsg: string
  message: string
  format: "md" | "html"
  composer: ComposerState
  sel: Selection
  post: (msg: Record<string, unknown>) => void
  load: () => void
  refetchComments: () => void
  onRestoredJump: () => void
  /** Open the review overlay (from an agent-request card whose revision is ready). */
  onOpenReview: () => void
  setEditing: Dispatch<SetStateAction<boolean>>
  setSrc: Dispatch<SetStateAction<string>>
  setTitle: Dispatch<SetStateAction<string>>
  setProposeMsg: Dispatch<SetStateAction<string>>
  setComposer: Dispatch<SetStateAction<ComposerState>>
  setSel: Dispatch<SetStateAction<Selection>>
  setActiveThread: Dispatch<SetStateAction<string | null>>
  setRestoring: Dispatch<SetStateAction<boolean>>
}) {
  const { shortId, art, qc, me, post, load, refetchComments } = p

  const startEdit = async () => {
    p.setEditing(true)
    p.setTitle(art.title ?? "")
    p.setSrc(await api.getContent(shortId))
  }
  const publishEdit = async () => {
    try {
      // Keep the artifact's format: editing an HTML artifact must stay .html
      // (publishing it as .md would flip its type and re-render it as markdown).
      // The title rides along, so editing the name renames the artifact.
      const a = await api.publishText(
        shortId,
        p.src,
        `${art.short_id}.${p.format === "md" ? "md" : "html"}`,
        p.message.trim() || "Edited in browser",
        p.title,
      )
      toast.success(`Published v${a.current_version}`)
      p.setEditing(false)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  // A commenter can't publish; their edit becomes a proposal for review. The
  // message is the "why" the reviewer reads, so we ask for it before sending.
  const proposeEdit = async () => {
    try {
      await api.propose(
        shortId,
        p.src,
        `${art.short_id}.${p.format === "md" ? "md" : "html"}`,
        p.proposeMsg.trim() || "Proposed change",
      )
      toast.success("Proposed — sent for review")
      p.setEditing(false)
      p.setProposeMsg("")
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const addComment = async (
    text: string,
    opts?: {
      threadId?: string
      anchor?: Sel | null
      mentions?: Mention[]
    },
  ) => {
    if (!text.trim()) return
    const key = commentsQuery(shortId).queryKey
    // Optimistic: the comment appears the instant you hit send, so there is never a
    // dead gap wondering whether it posted. A `temp-` id marks it as in-flight; the
    // server's row swaps in on success, a refetch reconciles ordering + anchored
    // flags, and a failure rolls the temp back out with a toast.
    const tempId = `temp-${crypto.randomUUID()}`
    const optimistic: Comment = {
      id: tempId,
      thread_id: opts?.threadId ?? tempId,
      base_version: p.art.current_version,
      path: null,
      anchor: opts?.anchor ? JSON.stringify(opts.anchor) : null,
      body_md: text,
      author: me?.name ?? me?.email ?? "You",
      state: "open",
      created_at: new Date().toISOString(),
      reactions: {},
      mentions: opts?.mentions,
    }
    qc.setQueryData<Comment[]>(key, (old) => [...(old ?? []), optimistic])
    try {
      const real = await api.comment(shortId, {
        body_md: text,
        thread_id: opts?.threadId,
        anchor: opts?.threadId ? undefined : (opts?.anchor ?? undefined),
        mentions: opts?.mentions?.length ? opts.mentions : undefined,
      })
      qc.setQueryData<Comment[]>(key, (old) =>
        (old ?? []).map((cmt) => (cmt.id === tempId ? real : cmt)),
      )
      refetchComments()
    } catch (e) {
      qc.setQueryData<Comment[]>(key, (old) => (old ?? []).filter((cmt) => cmt.id !== tempId))
      toast.error((e as Error).message)
    }
  }
  const reply = (text: string, threadId: string, mentions: Mention[] = []) =>
    addComment(text, { threadId, mentions })
  const submitNew = async (text: string, mentions: Mention[] = []) => {
    // Close the composer immediately (capturing its anchor first) rather than
    // after the round-trip: the send feels instant, and the just-typed text never
    // lingers on screen next to the comment it became.
    const anchor = p.composer?.anchor ?? null
    p.setComposer(null)
    p.setSel(null)
    await addComment(text, {
      anchor,
      mentions,
    })
  }
  const toggleResolve = async (root: Comment) => {
    // Resolve anything not already resolved (open or outdated); reopen a resolved thread.
    const next = root.state === "resolved" ? "open" : "resolved"
    // Optimistic: flip the thread's state in the cache NOW so the click feels instant,
    // snapshotting to roll back if the server rejects it (mirrors `react` below).
    const key = commentsQuery(shortId).queryKey
    const prev = qc.getQueryData(key)
    qc.setQueryData<Comment[]>(key, (cs) =>
      (cs ?? []).map((c) => (c.thread_id === root.id ? { ...c, state: next } : c)),
    )
    try {
      await api.resolve(shortId, root.id, next)
      refetchComments()
    } catch {
      qc.setQueryData(key, prev)
    }
  }
  const activate = (id: string) => {
    p.setActiveThread((cur) => (cur === id ? cur : id))
    post({ type: "emphasize", id })
  }
  const startSelComment = () => {
    if (!p.sel) return
    p.setComposer({ anchor: p.sel.selector, top: p.sel.top })
    p.setActiveThread(null)
  }
  // Open the composer as a revision REQUEST addressed to `agent` (the "ask an agent to
  // revise this selection" flow) — same anchored composer, pre-seeded with the mention
  // so the posted note lands in the agent's MCP pull inbox.
  const startSelAgent = (agent: AgentTarget) => {
    if (!p.sel) return
    p.setComposer({ anchor: p.sel.selector, top: p.sel.top, agent })
    p.setActiveThread(null)
  }
  const actions: CommentActions = {
    meName: me?.name ?? me?.email ?? "",
    react: (commentId, emoji) => {
      // Optimistic: reflect the toggle immediately, snapshot to roll back on failure.
      // A plain refetch can't undo the toggle when the server is unreachable, so the
      // catch restores the pre-toggle cache instead.
      const key = commentsQuery(shortId).queryKey
      const prev = qc.getQueryData(key)
      qc.setQueryData(key, (cs) =>
        (cs ?? []).map((c) =>
          c.id === commentId ? toggleReaction(c, emoji, me?.name ?? me?.email ?? "anonymous") : c,
        ),
      )
      api
        .react(shortId, commentId, emoji)
        .then(refetchComments)
        .catch(() => qc.setQueryData(key, prev))
    },
    edit: async (commentId, body) => {
      await api
        .editComment(shortId, commentId, body)
        .catch((e) => toast.error((e as Error).message))
      refetchComments()
    },
    remove: (commentId) => {
      api
        .deleteComment(shortId, commentId)
        .then(refetchComments)
        .catch((e) => toast.error((e as Error).message))
    },
    copyLink: (threadId) => {
      const url = `${window.location.origin}${window.location.pathname}?comment=${threadId}`
      navigator.clipboard
        ?.writeText(url)
        .then(() => toast.success("Link copied"))
        .catch(() => toast(url))
    },
    openReview: p.onOpenReview,
  }
  const restore = async (n: number) => {
    p.setRestoring(true)
    try {
      const a = await api.restore(shortId, n)
      toast.success(`Restored as v${a.current_version}`)
      p.onRestoredJump() // jump to the new current
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      p.setRestoring(false)
    }
  }

  return {
    startEdit,
    publishEdit,
    proposeEdit,
    reply,
    submitNew,
    toggleResolve,
    activate,
    startSelComment,
    startSelAgent,
    actions,
    restore,
  }
}
