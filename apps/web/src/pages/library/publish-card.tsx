import { useNavigate } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// General access (visibility) options for a new artifact, decreasing reach.
const VISIBILITIES = [
  { value: "public", label: "Public" },
  { value: "link", label: "Anyone with link" },
  { value: "org", label: "Workspace" },
  { value: "password", label: "Password" },
]

type Format = "md" | "html"

// Guess whether pasted text is HTML or Markdown so "Write" mode just works: an
// opening structural tag or any closing tag reads as HTML, everything else as
// Markdown. The author can override with the format toggle.
const detectFormat = (t: string): Format => {
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

const SEG = "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50"

// The home-page composer: publish a new artifact by dropping/picking a file
// (Upload) or by pasting Markdown or HTML straight in (Write). Both paths share
// the visibility control and route to the new artifact on success.
export function PublishCard() {
  const nav = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<"upload" | "write">("upload")
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [vis, setVis] = useState("link")
  const [pw, setPw] = useState("")
  // Write mode.
  const [text, setText] = useState("")
  const [title, setTitle] = useState("")
  const [override, setOverride] = useState<Format | null>(null)
  const format = override ?? detectFormat(text)

  // One publish tail shared by every entry point: gate password visibility, send,
  // then open the new artifact. Returns to an editable state on failure.
  const finish = async (file: File, titleField: string) => {
    if (vis === "password" && !pw.trim()) {
      toast.error("Enter a password for password-protected visibility.")
      return
    }
    setBusy(true)
    try {
      const fields: Record<string, string> = { title: titleField, visibility: vis }
      if (vis === "password") fields.password = pw.trim()
      const a = await api.publish(file, fields)
      nav({ to: "/a/$ref", params: { ref: a.short_id } })
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  const publishFile = (f: File) => finish(f, f.name.replace(/\.[^.]+$/, ""))
  const publishText = () => {
    const body = text.trim()
    if (!body) return
    const name = title.trim() || "Untitled"
    const ext = format === "html" ? "html" : "md"
    const type = format === "html" ? "text/html" : "text/markdown"
    finish(new File([body], `inline.${ext}`, { type }), name)
  }

  return (
    <Card
      className={cn(
        "mb-5.5 flex flex-col gap-3.5 border-dashed p-4 transition-colors",
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
      <div className="flex flex-wrap items-center gap-3.5">
        <div className="min-w-[200px] flex-1">
          <div className="font-display text-lg font-semibold">Publish an artifact</div>
          <div className="text-sm text-muted-foreground">
            {mode === "upload" ? (
              <>
                Drop an HTML or Markdown file here, or run{" "}
                <code className="rounded bg-muted px-1.5 py-px font-mono text-[0.86em]">
                  dock publish
                </code>
                .
              </>
            ) : (
              "Paste or write Markdown or HTML and publish it straight away."
            )}
          </div>
        </div>
        {/* Upload vs Write toggle. */}
        <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
          <button
            type="button"
            data-testid="library-mode-upload"
            onClick={() => setMode("upload")}
            className={cn(
              SEG,
              mode === "upload"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Upload
          </button>
          <button
            type="button"
            data-testid="library-mode-write"
            onClick={() => setMode("write")}
            className={cn(
              SEG,
              mode === "write"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Write
          </button>
        </div>
      </div>

      {mode === "write" && (
        <div className="flex flex-col gap-2.5">
          <Input
            data-testid="library-compose-title"
            placeholder="Title (optional)"
            aria-label="Artifact title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            data-testid="library-compose-input"
            aria-label="Markdown or HTML content"
            placeholder={"# Paste Markdown\n\nor <h1>HTML</h1> and hit Publish."}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-[160px] font-mono text-sm"
          />
          {/* Detected format, with a one-tap override. */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Format</span>
            <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
              <button
                type="button"
                data-testid="library-format-md"
                onClick={() => setOverride("md")}
                className={cn(
                  SEG,
                  format === "md" ? "bg-accent text-accent-foreground" : "hover:text-foreground",
                )}
              >
                Markdown
              </button>
              <button
                type="button"
                data-testid="library-format-html"
                onClick={() => setOverride("html")}
                className={cn(
                  SEG,
                  format === "html" ? "bg-accent text-accent-foreground" : "hover:text-foreground",
                )}
              >
                HTML
              </button>
            </div>
            {override === null && text.trim() !== "" && <span>· auto-detected</span>}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3.5">
        <input
          ref={fileInput}
          type="file"
          data-testid="library-file-input"
          accept=".html,.htm,.md,.markdown,.zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) publishFile(f)
          }}
        />
        <select
          aria-label="Visibility"
          data-testid="library-visibility"
          value={vis}
          onChange={(e) => setVis(e.target.value)}
          className="rounded-md border border-input bg-card px-2 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
        >
          {VISIBILITIES.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
        {vis === "password" && (
          <Input
            type="password"
            data-testid="library-visibility-password"
            placeholder="Password"
            aria-label="Password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="w-[150px]"
          />
        )}
        <div className="ml-auto">
          {mode === "upload" ? (
            <Button
              variant="primary"
              data-testid="library-publish"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
            >
              {busy ? (
                "Publishing…"
              ) : (
                <>
                  <Plus /> Publish
                </>
              )}
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="library-compose-publish"
              onClick={publishText}
              disabled={busy || text.trim() === ""}
            >
              {busy ? (
                "Publishing…"
              ) : (
                <>
                  <Plus /> Publish
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}
