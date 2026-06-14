import type { QueryClient } from "@tanstack/react-query"
import type { Dispatch, SetStateAction } from "react"
import { toast } from "sonner"
import { api, type Comment, type Mention } from "@/api"
import { commentsQuery } from "@/lib/queries"
import type { CommentActions } from "./comment-actions"
import { toggleReaction } from "./lib/reactions"
import type { Sel } from "./types"

type Me = { name?: string | null; email?: string | null } | null
type Composer = { anchor: Sel | null; top: number | null } | null
// The page's full selection shape — the hook only reads selector + top, but the
// setSel setter is typed against the whole thing (so the types line up).
type Selection = {
  selector: Sel
  top: number
  vTop: number
  vBottom: number
  vLeft: number
  vRight: number
} | null

/**
 * Every mutating action the artifact page drives: editing (publish a version /
 * submit a proposal), the comment loop (add / reply / resolve / react / edit /
 * delete / copy-link), thread activation + the comment-on-selection composer, and
 * version restore. Lifted out of the page so it holds the wiring; `nav` is
 * decoupled as `onRestoredJump` so the hook stays router-type-free.
 */
export function artifactActions(p: {
  shortId: string
  art: { title?: string | null; short_id: string }
  qc: QueryClient
  me: Me
  src: string
  proposeMsg: string
  message: string
  format: "md" | "html"
  composer: Composer
  sel: Selection
  post: (msg: Record<string, unknown>) => void
  load: () => void
  refetchComments: () => void
  onRestoredJump: () => void
  setEditing: Dispatch<SetStateAction<boolean>>
  setSrc: Dispatch<SetStateAction<string>>
  setProposeMsg: Dispatch<SetStateAction<string>>
  setComposer: Dispatch<SetStateAction<Composer>>
  setSel: Dispatch<SetStateAction<Selection>>
  setActiveThread: Dispatch<SetStateAction<string | null>>
  setRestoring: Dispatch<SetStateAction<boolean>>
}) {
  const { shortId, art, qc, me, post, load, refetchComments } = p

  const startEdit = async () => {
    p.setEditing(true)
    p.setSrc(await api.getContent(shortId))
  }
  const publishEdit = async () => {
    try {
      // Keep the artifact's format: editing an HTML artifact must stay .html
      // (publishing it as .md would flip its type and re-render it as markdown).
      const a = await api.publishText(
        shortId,
        p.src,
        `${art.short_id}.${p.format === "md" ? "md" : "html"}`,
        p.message.trim() || "Edited in browser",
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
    opts?: { threadId?: string; anchor?: Sel | null; mentions?: Mention[] },
  ) => {
    if (!text.trim()) return
    await api
      .comment(shortId, {
        body_md: text,
        thread_id: opts?.threadId,
        anchor: opts?.threadId ? undefined : (opts?.anchor ?? undefined),
        mentions: opts?.mentions?.length ? opts.mentions : undefined,
      })
      .catch((e) => toast.error((e as Error).message))
    refetchComments()
  }
  const reply = (text: string, threadId: string, mentions: Mention[] = []) =>
    addComment(text, { threadId, mentions })
  const submitNew = async (text: string, mentions: Mention[] = []) => {
    await addComment(text, { anchor: p.composer?.anchor ?? null, mentions })
    p.setComposer(null)
    p.setSel(null)
  }
  const toggleResolve = async (root: Comment) => {
    await api.resolve(shortId, root.id, root.state === "open" ? "resolved" : "open")
    refetchComments()
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
  const actions: CommentActions = {
    meName: me?.name ?? me?.email ?? "",
    react: (commentId, emoji) => {
      // Optimistic: reflect the toggle in the cache immediately, reconcile on the response.
      qc.setQueryData(commentsQuery(shortId).queryKey, (cs) =>
        (cs ?? []).map((c) =>
          c.id === commentId ? toggleReaction(c, emoji, me?.name ?? me?.email ?? "anonymous") : c,
        ),
      )
      api.react(shortId, commentId, emoji).then(refetchComments).catch(refetchComments)
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
      const url = `${window.location.origin}${window.location.pathname}?c=${threadId}`
      navigator.clipboard
        ?.writeText(url)
        .then(() => toast.success("Link copied"))
        .catch(() => toast(url))
    },
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
    addComment,
    reply,
    submitNew,
    toggleResolve,
    activate,
    startSelComment,
    actions,
    restore,
  }
}
