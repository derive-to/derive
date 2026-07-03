import { useNavigate } from "@tanstack/react-router"
import { Upload } from "lucide-react"
import { useRef, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { toast } from "@/components/ui/sonner"
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
        // flex-row overrides the Card base's flex-col: this launcher is one
        // wrapping band, not a stacked card. Solid hairline at rest (the app's
        // one resting dashed surface retired for consistency); the ink drop
        // affordance lights up only while dragging — instant, no transition.
        "mb-6 flex flex-row flex-wrap items-center gap-3.5 p-4",
        dragging && "border-dashed border-primary bg-primary/5",
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
      <div className="min-w-50 flex-1">
        {/* A label, not a headline: the home's one voice headline is the greeting
            above it, so this launcher no longer stacks a second serif h2. On a
            filtered view (no greeting) it quietly anchors the launcher. */}
        <p className="text-sm font-medium text-foreground">Publish an artifact</p>
        <p className="text-sm text-pretty text-muted-foreground">
          Write or paste Markdown or HTML, or drop a file.
        </p>
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
      <Button variant="default" data-testid="library-new" onClick={() => nav({ to: "/new" })}>
        <Icon name="plus" /> Write or paste
      </Button>
    </Card>
  )
}
