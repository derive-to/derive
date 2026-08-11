import { useState } from "react"
import { Icon } from "@/components/icons"
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
  onUse: (shortId: string) => void
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const submit = () => {
    const shortId = artifactIdFromInput(value)
    if (!shortId) {
      setError("Paste a Derive artifact link or short id.")
      return
    }
    setError("")
    onUse(shortId)
  }
  return (
    <form
      className="grid gap-4 rounded-xl border bg-secondary p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon name="derive" className="text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">Create from any artifact</p>
        </div>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          Paste a Derive link. Its current source opens as a new, independent draft; the original
          stays untouched.
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
          aria-invalid={!!error}
          aria-describedby={error ? "derive-source-error" : undefined}
          data-testid="template-source-input"
        />
        {error && (
          <p id="derive-source-error" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" variant="outline" data-testid="template-source-submit">
        Open as draft <Icon name="arrow" />
      </Button>
    </form>
  )
}
