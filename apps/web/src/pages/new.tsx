import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "@/api"
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
// title. Publishing creates the artifact (Workspace visibility by default; widen
// access from its Share menu) and opens it.
export function NewArtifact() {
  const nav = useNavigate()
  const [src, setSrc] = useState("")
  const [title, setTitle] = useState("")
  const [message, setMessage] = useState("")
  const format = detectFormat(src)

  const publish = async () => {
    if (!src.trim()) {
      toast.error("Add some content first.")
      return
    }
    try {
      const name = title.trim() || "Untitled"
      const ext = format === "md" ? "md" : "html"
      const type = format === "md" ? "text/markdown" : "text/html"
      const fields: Record<string, string> = { title: name, visibility: "org" }
      if (message.trim()) fields.message = message.trim()
      const a = await api.publish(new File([src], `inline.${ext}`, { type }), fields)
      nav({ to: "/a/$ref", params: { ref: refFor(a) } })
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
      />
    </div>
  )
}
