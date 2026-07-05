import { useQueryClient } from "@tanstack/react-query"
import { useBlocker, useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { toast } from "@/components/ui/sonner"
import { collectionsQuery, summaryQuery } from "@/lib/queries"
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

// Create a new artifact using the exact same editor as edit mode (SourceEditor):
// paste or write Markdown/HTML on the left, live preview on the right, editable
// title. Publishing creates the artifact (private by default; widen
// access from its Share menu) and opens it.
export function NewArtifact() {
  const nav = useNavigate()
  const qc = useQueryClient()
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
  const dirty = !!(src.trim() || title.trim() || message.trim())

  // Guard leaving with an unsaved draft — BOTH in-app navigation (rail click, Cancel) and
  // a browser close/refresh (enableBeforeUnload). withResolver gives us proceed/reset to
  // drive the shared ConfirmDialog instead of the browser's native prompt for in-app navs.
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !publishing.current,
    enableBeforeUnload: () => dirty && !publishing.current,
    withResolver: true,
  })

  const publish = async () => {
    if (!src.trim()) {
      toast.error("Add some content first.")
      return
    }
    try {
      const name = title.trim() || "Untitled"
      const ext = format === "md" ? "md" : "html"
      const type = format === "md" ? "text/markdown" : "text/html"
      const fields: Record<string, string> = { title: name }
      if (message.trim()) fields.message = message.trim()
      const a = await api.publish(new File([src], `inline.${ext}`, { type }), fields)
      // Freshen the library so the new artifact + bumped total are correct on return,
      // instead of relying only on the app-shell's nav-change invalidation.
      qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
      qc.invalidateQueries({ queryKey: collectionsQuery().queryKey })
      qc.invalidateQueries({ queryKey: ["artifacts"] })
      // Drop the unsaved guard before navigating to the artifact (this nav is the save,
      // not an abandon), so the blocker doesn't intercept it. Ref, so it's in effect the
      // instant nav() runs — see the note on `publishing` above.
      publishing.current = true
      nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SourceEditor
        canPublish
        title={title}
        onTitle={setTitle}
        format={format}
        src={src}
        message={message}
        proposeMsg=""
        onSrc={setSrc}
        onMessage={setMessage}
        onProposeMsg={() => {}}
        onCancel={() => nav({ to: "/" })}
        onPublish={publish}
        onPropose={() => {}}
        placeholder="Write or paste Markdown or HTML — the preview updates as you type."
      />
      {/* The unsaved-draft confirm: fires for any blocked departure (Cancel, a rail click,
          back). Discarding proceeds; keeping resets you to the editor with the draft intact. */}
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.status === "blocked") blocker.reset()
        }}
        title="Discard this draft?"
        description="You have unpublished changes. Leaving now discards them — this can't be undone."
        confirmLabel="Discard"
        confirmTestId="new-discard-confirm"
        onConfirm={() => {
          if (blocker.status === "blocked") blocker.proceed()
        }}
      />
    </div>
  )
}
