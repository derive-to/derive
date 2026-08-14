import { useQuery } from "@tanstack/react-query"
import { useDeferredValue, useState } from "react"
import { type Artifact, api } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { SearchField } from "@/components/shared/search-field"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

export function ArtifactSourcePicker({
  value,
  onChange,
  onSelect,
}: {
  value: string
  onChange: (value: string) => void
  onSelect: (artifact: Artifact) => void
}) {
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const artifacts = useQuery({
    queryKey: ["template-library-source-picker", deferredQuery] as const,
    queryFn: () => api.listArtifacts({ q: deferredQuery.trim() || undefined, limit: 8 }),
  })
  const items = artifacts.data?.artifacts ?? []
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium text-foreground">Choose an artifact</legend>
      <p className="text-xs text-muted-foreground">
        Search readable work in this workspace. The current version is captured when you publish the
        starter.
      </p>
      <SearchField
        value={query}
        onValueChange={setQuery}
        loading={artifacts.isFetching}
        placeholder="Search recent artifacts"
        aria-label="Search recent artifacts"
        testId="template-library-source-search"
      />
      {artifacts.isError ? (
        <LoadError
          title="Couldn’t load workspace artifacts"
          description="You can retry the search or paste a Derive link below."
          testId="template-library-source-retry"
          onRetry={() => artifacts.refetch()}
          layout="inline"
        />
      ) : items.length > 0 ? (
        <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border bg-background p-1.5">
          {items.map((artifact) => {
            const selected = value === artifact.short_id
            return (
              <button
                key={artifact.short_id}
                type="button"
                onClick={() => onSelect(artifact)}
                className={`flex min-w-0 items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  selected ? "bg-secondary" : "hover:bg-secondary/70"
                }`}
                data-testid={`template-library-source-select-${artifact.short_id}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {artifact.title || "Untitled artifact"}
                  </span>
                  <span className="font-mono text-2xs text-muted-foreground">
                    {artifact.short_id} · v{artifact.current_version}
                  </span>
                </span>
                <Badge variant="outline" shape="pill">
                  {artifact.current_content_type === "text/x-derive-deck"
                    ? "Deck"
                    : artifact.current_content_type === "text/markdown"
                      ? "Markdown"
                      : "HTML"}
                </Badge>
              </button>
            )
          })}
        </div>
      ) : null}
      {artifacts.isSuccess && items.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          No readable artifacts match this search. You can still paste a Derive link below.
        </p>
      )}
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        Or paste a Derive link or short ID
        <Input
          data-testid="template-library-source-paste"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="decision-memo-ab12cd34@v4"
          aria-label="Paste a Derive link or short ID"
        />
      </label>
    </fieldset>
  )
}
