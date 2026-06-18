import { useNavigate } from "@tanstack/react-router"
import { Plus, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { refFor } from "../artifact/parse-ref"

// The home launcher. "Write or paste" opens /new — the same editor as edit mode
// (paste/write Markdown or HTML with a live preview). Dropping or choosing a file
// publishes it directly. New artifacts default to Workspace (private) access.
export function PublishCard() {
  const nav = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)

  const publishFile = async (f: File) => {
    // Warn about local stylesheet references in HTML files before uploading.
    if (/\.html?$/i.test(f.name)) {
      const text = await f.text()
      const localLinks = [
        ...text.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi),
      ]
        .flatMap((m): string[] => (m[1] ? [m[1]] : []))
        .filter((h) => !/^(https?:\/\/|\/\/|data:)/i.test(h))
      if (localLinks.length > 0) {
        const names = localLinks.map((h) => h.split("/").pop()).join(", ")
        toast.warning(
          `This file links to ${localLinks.length === 1 ? "a local stylesheet" : "local stylesheets"} (${names}) that won't load here — it was probably on your computer. Try embedding styles inline before uploading.`,
          { duration: 8000 },
        )
      }
    }
    setBusy(true)
    try {
      const a = await api.publish(f, { title: f.name.replace(/\.[^.]+$/, ""), visibility: "org" })
      nav({ to: "/a/$ref", params: { ref: refFor(a) } })
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Card
      className={cn(
        "mb-5.5 flex flex-wrap items-center gap-3.5 border-dashed p-4 transition-colors",
        dragging && "border-primary bg-primary/5",
      )}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragging) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files?.[0]
        if (f) publishFile(f)
      }}
    >
      <div className="min-w-[200px] flex-1">
        <div className="font-display text-lg font-semibold">Publish an artifact</div>
        <div className="text-sm text-muted-foreground">
          Write or paste Markdown or HTML, or drop a file.
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        data-testid="library-file-input"
        accept=".html,.htm,.md,.markdown,.zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) publishFile(f)
        }}
      />
      <Button
        variant="outline"
        data-testid="library-upload"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
      >
        <Upload /> {busy ? "Publishing…" : "Upload a file"}
      </Button>
      <Button variant="primary" data-testid="library-new" onClick={() => nav({ to: "/new" })}>
        <Plus /> Write or paste
      </Button>
    </Card>
  )
}
