import { type QueryClient, useQueryClient } from "@tanstack/react-query"
import { useBlocker, useNavigate, useSearch } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { type Artifact, api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { toast } from "@/components/ui/sonner"
import { artifactQuery, collectionsQuery, summaryQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { refFor } from "./artifact/parse-ref"
import { SourceEditor } from "./artifact/source-editor"

// Guess Markdown vs HTML from the content, so paste just works (the editor drives
// highlighting + live preview off it). An opening structural tag or any closing
// tag reads as HTML; everything else is Markdown.
const detectFormat = (t: string): "md" | "html" => {
  const s = t.trim()
  if (!s) return "md"
  if (
    /^<(?:!doctype|html|body|head|div|section|article|main|header|footer|nav|h[1-6]|p|ul|ol|li|table|span|a|img|svg|style|script)\b/i.test(
      s,
    )
  )
    return "html"
  if (/<\/[a-z][\w-]*>/i.test(s)) return "html"
  return "md"
}

/** Paint a newly published artifact immediately, but never let the lean publish
 * response masquerade as authoritative detail. Native content chrome is resolved
 * by GET /artifacts/:id, so the seed must be invalidated before the workbench mounts. */
export const seedPublishedArtifact = (qc: QueryClient, artifact: Artifact): Promise<void> => {
  const detail = artifactQuery(artifact.short_id)
  qc.setQueryData(detail.queryKey, { ...artifact, my_role: "owner" })
  return qc.invalidateQueries({ queryKey: detail.queryKey, exact: true })
}

// Create a new artifact using the exact same editor as edit mode (SourceEditor):
// paste or write Markdown/HTML on the left, live preview on the right, editable
// title. Publishing creates the artifact (private by default; widen
// access from its Share menu) and opens it.
export function NewArtifact() {
  useDocumentTitle("New artifact")
  const nav = useNavigate()
  const search = useSearch({ from: "/new" })
  const [src, setSrc] = useState("")
  const [title, setTitle] = useState("")
  const [message, setMessage] = useState("")
  const format = detectFormat(src)

  // A draft is dirty once anything's been typed. Publishing must bypass the guard for its
  // own nav to the artifact — via a REF, not state: publish() sets it and calls nav() in the
  // same tick, so a batched state update wouldn't be reflected in the blocker's closure yet
  // (the nav would fire the discard dialog on the very success path it's meant to allow).
  // A ref updates synchronously, so shouldBlockFn sees the bypass immediately.
  const publishing = useRef(false)
  const qc = useQueryClient()
  const dirty = !!(src.trim() || title.trim() || message.trim())

  // Guard leaving with an unsaved draft — BOTH in-app navigation (rail click, Cancel) and
  // a browser close/refresh (enableBeforeUnload). withResolver gives us proceed/reset to
  // drive the shared ConfirmDialog instead of the browser's native prompt for in-app navs.
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !publishing.current,
    enableBeforeUnload: () => dirty && !publishing.current,
    withResolver: true,
  })

  const publishMut = useApiMutation({
    mutationFn: () => {
      const name = title.trim() || "Untitled"
      const ext = format === "md" ? "md" : "html"
      const type = format === "md" ? "text/markdown" : "text/html"
      const fields: Record<string, string> = { title: name }
      if (message.trim()) fields.message = message.trim()
      return api.publish(new File([src], `inline.${ext}`, { type }), fields)
    },
    // Freshen the library so the new artifact + bumped total are correct on return.
    invalidate: [summaryQuery().queryKey, collectionsQuery().queryKey, ["artifacts"]],
    onSuccess: (a) => {
      // The response IS the record the artifact page is about to fetch — seed it, so
      // the workbench header paints on arrival instead of after a second round trip,
      // and start the raw-content fetch now so the iframe finds a warm HTTP cache.
      // Publish is the moment a person is most likely to be watching the screen.
      // The publish response is deliberately lean and has no viewer-specific role.
      // We do know one fact locally: the person who just created this artifact owns it.
      // Preserve that while the authoritative detail warms, otherwise the first
      // artifact paint briefly hides every editor-only affordance (including Inspect).
      // The helper also invalidates the lean seed so native content-type chrome does
      // not remain incomplete until a manual reload.
      void seedPublishedArtifact(qc, a)
      // Drop the unsaved guard before navigating to the artifact (this nav IS the save,
      // not an abandon), so the blocker doesn't intercept it. Ref, so it's in effect the
      // instant nav() runs — see the note on `publishing` above.
      publishing.current = true
      if (search.next === "context") {
        nav({
          to: "/agents",
          search: {
            manifest: a.short_id,
            name: search.contextName,
            origin: search.contextName,
          },
        })
      } else {
        nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })
      }
    },
  })
  const publish = () => {
    if (!src.trim()) {
      toast.error("Add some content first.")
      return
    }
    publishMut.mutate()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SourceEditor
        title={title}
        onTitle={setTitle}
        format={format}
        src={src}
        message={message}
        onSrc={setSrc}
        onMessage={setMessage}
        onCancel={() => nav({ to: "/" })}
        onPublish={publish}
        publishing={publishMut.isPending}
        placeholder="Write or paste Markdown or HTML. The preview updates as you type."
      />
      {/* The unsaved-draft confirm: fires for any blocked departure (Cancel, a rail click,
          back). Discarding proceeds; keeping resets you to the editor with the draft intact. */}
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.status === "blocked") blocker.reset()
        }}
        title="Discard this draft?"
        description="You have unpublished changes. Leaving now will discard them, and you cannot undo this."
        confirmLabel="Discard"
        confirmTestId="new-discard-confirm"
        onConfirm={() => {
          if (blocker.status === "blocked") blocker.proceed()
        }}
      />
    </div>
  )
}
