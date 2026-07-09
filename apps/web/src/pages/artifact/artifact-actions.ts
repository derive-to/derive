import { useQueryClient } from "@tanstack/react-query"
import type { Dispatch, SetStateAction } from "react"
import { type Artifact, api, type Comment, type Mention } from "@/api"
import { toast } from "@/components/ui/sonner"
import { commentsQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import type { CommentActions } from "./comment-actions"
import { toggleReaction } from "./lib/reactions"
import type { AgentTarget, ComposerState, Sel, Selection } from "./types"

type Me = { name?: string | null; email?: string | null } | null

// The format (md vs html) rides with the artifact's current version; publishing must
// keep it (editing an .md artifact stays markdown). Derived here so the hook doesn't
// depend on the page's computed `format` — which is what lets it sit ABOVE the page's
// load guards (see below).
const formatOf = (art: Artifact): "md" | "html" =>
  art.versions.find((v) => v.n === art.current_version)?.content_type === "text/markdown"
    ? "md"
    : "html"

/**
 * Every mutating action the artifact page drives: editing (publish a version / submit a
 * proposal), the comment loop (add / reply / resolve / react / edit / delete / copy-link),
 * thread activation + the comment-on-selection composer, and version restore. A hook, so
 * each write runs through the one governed mutation primitive (`useApiMutation`): uniform
 * pending (surfaced as `publishing` / `restoring`), optimistic rollback, and the error
 * toast — none of which can drift per action.
 *
 * It takes the artifact as possibly-undefined — like `useArtifactRoute` and
 * `useVersionDiff` do — so the page can call it ABOVE its load/404/removed guards (a hook
 * can never sit below the early returns those guards make). The returned handlers only
 * ever fire from the loaded workbench, where the artifact is present.
 */
export function useArtifactActions(p: {
  shortId: string
  art: Artifact | undefined
  me: Me
  src: string
  title: string
  proposeMsg: string
  message: string
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
}) {
  const { shortId, me, post, load, refetchComments } = p
  const qc = useQueryClient()
  const commentsKey = commentsQuery(shortId).queryKey

  const startEdit = async () => {
    // Load the source BEFORE opening the editor: if the fetch fails, opening an empty editor
    // over existing content lets Publish overwrite it with blank. Load first, open on success.
    try {
      const src = await api.getContent(shortId)
      p.setTitle(p.art?.title ?? "")
      p.setSrc(src)
      p.setEditing(true)
    } catch {
      toast.error("Couldn't load the source to edit. Try again.")
    }
  }

  // Keep the artifact's format: editing an HTML artifact must stay .html (publishing it
  // as .md would flip its type). The title rides along, so editing the name renames it.
  const publish = useApiMutation({
    mutationFn: () => {
      // Only ever invoked from the loaded workbench, so `art` is present — the guard
      // encodes that invariant for the type system (mirrors useArtifactRoute's `!art`).
      if (!p.art) throw new Error("publish fired before the artifact loaded")
      return api.publishText(
        shortId,
        p.src,
        `${p.art.short_id}.${formatOf(p.art)}`,
        p.message.trim() || "Edited in browser",
        p.title,
      )
    },
    success: (a) => `Published v${a.current_version}`,
    onSuccess: () => {
      p.setEditing(false)
      load()
    },
  })
  // A commenter can't publish; their edit becomes a proposal for review. The message is
  // the "why" the reviewer reads, so we ask for it before sending.
  const propose = useApiMutation({
    mutationFn: () => {
      if (!p.art) throw new Error("propose fired before the artifact loaded")
      return api.propose(
        shortId,
        p.src,
        `${p.art.short_id}.${formatOf(p.art)}`,
        p.proposeMsg.trim() || "Proposed change",
      )
    },
    success: "Proposed — sent for review",
    onSuccess: () => {
      p.setEditing(false)
      p.setProposeMsg("")
      load()
    },
  })

  // Add / reply: optimistic temp row so the comment appears the instant you hit send. A
  // `temp-` id marks it in-flight; the server's row swaps in on success and a refetch
  // reconciles ordering + anchored flags. On failure the rollback removes ONLY the temp
  // (a surgical filter, not a whole-cache snapshot) so a concurrent SSE update survives.
  const comment = useApiMutation({
    mutationFn: ({
      text,
      opts,
    }: {
      text: string
      opts?: { threadId?: string; anchor?: Sel | null; mentions?: Mention[] }
      optimistic: Comment
    }) =>
      api.comment(shortId, {
        body_md: text,
        thread_id: opts?.threadId,
        anchor: opts?.threadId ? undefined : (opts?.anchor ?? undefined),
        mentions: opts?.mentions?.length ? opts.mentions : undefined,
      }),
    optimistic: ({ optimistic }, client) => {
      client.setQueryData<Comment[]>(commentsKey, (old) => [...(old ?? []), optimistic])
      return () =>
        client.setQueryData<Comment[]>(commentsKey, (old) =>
          (old ?? []).filter((cmt) => cmt.id !== optimistic.id),
        )
    },
    onSuccess: (real, { optimistic }) => {
      qc.setQueryData<Comment[]>(commentsKey, (old) =>
        (old ?? []).map((cmt) => (cmt.id === optimistic.id ? real : cmt)),
      )
      refetchComments()
    },
  })
  const addComment = (
    text: string,
    opts?: { threadId?: string; anchor?: Sel | null; mentions?: Mention[] },
  ) => {
    if (!text.trim() || !p.art) return
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
    comment.mutate({ text, opts, optimistic })
  }
  const reply = (text: string, threadId: string, mentions: Mention[] = []) =>
    addComment(text, { threadId, mentions })
  const submitNew = (text: string, mentions: Mention[] = []) => {
    // Close the composer immediately (capturing its anchor first) rather than after the
    // round-trip: the send feels instant, and the just-typed text never lingers on screen
    // next to the comment it became.
    const anchor = p.composer?.anchor ?? null
    p.setComposer(null)
    p.setSel(null)
    addComment(text, { anchor, mentions })
  }

  // Resolve/reopen: optimistically flip the thread's state so the click feels instant;
  // the primitive rolls the cache back + toasts if the server rejects it.
  const resolve = useApiMutation({
    mutationFn: ({ root, next }: { root: Comment; next: "open" | "resolved" }) =>
      api.resolve(shortId, root.id, next),
    optimistic: ({ root, next }, client) => {
      const rollback = snapshot(client, commentsKey)
      client.setQueryData<Comment[]>(commentsKey, (cs) =>
        (cs ?? []).map((c) => (c.thread_id === root.id ? { ...c, state: next } : c)),
      )
      return rollback
    },
    // Reconcile on settle (success OR failure). On failure the snapshot rollback runs first,
    // then this refetch restores any concurrent SSE comment a whole-key rollback would drop.
    invalidate: [commentsKey],
  })
  const toggleResolve = (root: Comment) =>
    resolve.mutate({ root, next: root.state === "resolved" ? "open" : "resolved" })

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
  // revise this selection" flow) — same anchored composer, pre-seeded with the mention so
  // the posted note lands in the agent's MCP pull inbox.
  const startSelAgent = (agent: AgentTarget) => {
    if (!p.sel) return
    p.setComposer({ anchor: p.sel.selector, top: p.sel.top, agent })
    p.setActiveThread(null)
  }

  // Reaction: optimistic toggle, rolled back on failure, then reconciled on settle. Edit is
  // likewise optimistic (below); delete refetches on success. All surface a failure via the
  // global safety net rather than the silent catch these once had.
  const react = useApiMutation({
    mutationFn: ({ commentId, emoji }: { commentId: string; emoji: string }) =>
      api.react(shortId, commentId, emoji),
    optimistic: ({ commentId, emoji }, client) => {
      const rollback = snapshot(client, commentsKey)
      client.setQueryData<Comment[]>(commentsKey, (cs) =>
        (cs ?? []).map((c) =>
          c.id === commentId ? toggleReaction(c, emoji, me?.name ?? me?.email ?? "anonymous") : c,
        ),
      )
      return rollback
    },
    // Reconcile on settle (see resolve) so a concurrent SSE comment isn't lost on a failed react.
    invalidate: [commentsKey],
  })
  const editComment = useApiMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) =>
      api.editComment(shortId, commentId, body),
    // Optimistic so the edited text shows the instant Save closes the box — not the pre-edit
    // body until the refetch lands. Rolls back on failure; invalidate then reconciles.
    optimistic: ({ commentId, body }, client) => {
      const rollback = snapshot(client, commentsKey)
      client.setQueryData<Comment[]>(commentsKey, (cs) =>
        (cs ?? []).map((c) => (c.id === commentId ? { ...c, body_md: body } : c)),
      )
      return rollback
    },
    invalidate: [commentsKey],
  })
  const removeComment = useApiMutation({
    mutationFn: (commentId: string) => api.deleteComment(shortId, commentId),
    onSuccess: () => refetchComments(),
  })
  const actions: CommentActions = {
    meName: me?.name ?? me?.email ?? "",
    react: (commentId, emoji) => react.mutate({ commentId, emoji }),
    edit: (commentId, body) => editComment.mutate({ commentId, body }),
    remove: (commentId) => removeComment.mutate(commentId),
    copyLink: (threadId) => {
      const url = `${window.location.origin}${window.location.pathname}?comment=${threadId}`
      navigator.clipboard
        ?.writeText(url)
        .then(() => toast.success("Link copied"))
        .catch(() => toast(url))
    },
    openReview: p.onOpenReview,
  }

  const restore = useApiMutation({
    mutationFn: (n: number) => api.restore(shortId, n),
    success: (a) => `Restored as v${a.current_version}`,
    onSuccess: () => {
      p.onRestoredJump() // jump to the new current
      load()
    },
  })

  return {
    startEdit,
    publishEdit: () => publish.mutate(),
    proposeEdit: () => propose.mutate(),
    reply,
    submitNew,
    toggleResolve,
    activate,
    startSelComment,
    startSelAgent,
    actions,
    restore: (n: number) => restore.mutate(n),
    // Pending flags the page threads into the editor toolbar + version rail, replacing the
    // hand-rolled `restoring` state and the editor's local double-click guard.
    publishing: publish.isPending || propose.isPending,
    restoring: restore.isPending,
  }
}
