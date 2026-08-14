import { useState } from "react"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
import { fieldError } from "@/components/shared/field-error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { parseRef } from "@/pages/artifact/parse-ref"

export function artifactIdFromInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let ref = trimmed
  try {
    const url = new URL(trimmed)
    const parts = url.pathname.split("/").filter(Boolean)
    ref = parts.at(-1) ?? ""
  } catch {
    // A short id or readable artifact ref is expected more often than a URL.
  }
  const { shortId } = parseRef(ref)
  return /^[0-9a-z]{6,12}$/.test(shortId) ? shortId : null
}

export function DeriveSource({
  autoFocus,
  onUse,
}: {
  autoFocus?: boolean
  onUse: (artifact: Artifact) => void
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const errorState = fieldError("derive-source-error", error)
  const submit = async () => {
    const shortId = artifactIdFromInput(value)
    if (!shortId) {
      setError("Paste a Derive artifact link or short id.")
      return
    }
    setError("")
    setLoading(true)
    try {
      onUse(await api.getArtifact(shortId))
    } catch {
      setError(
        "Derive couldn’t open that artifact. Check the link and your access, then try again.",
      )
    } finally {
      setLoading(false)
    }
  }
  return (
    <form
      className="grid gap-4 rounded-xl border bg-secondary p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon name="derive" className="text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">Make any artifact yours</p>
        </div>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          Paste a Derive link, then tell the agent what you need. It will reuse the artifact’s
          strongest ideas and shape while leaving the original untouched.
        </p>
        <Input
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            if (error) setError("")
          }}
          placeholder="derive.to/artifacts/… or short id"
          aria-label="Artifact link or short id"
          {...errorState.aria}
          data-testid="template-source-input"
        />
        {errorState.node}
      </div>
      <Button
        type="submit"
        variant="outline"
        disabled={loading}
        data-testid="template-source-submit"
      >
        {loading ? "Opening…" : "Make it mine"} <Icon name="sparkles" />
      </Button>
    </form>
  )
}
