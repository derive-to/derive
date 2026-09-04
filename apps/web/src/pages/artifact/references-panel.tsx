import { useState } from "react"
import { api, type BibEntry, type Bibliography, type BibOp } from "@/api"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { useApiMutation } from "@/lib/use-api-mutation"

/** What a new entry opens with: the shape, ready to fill. */
const TEMPLATE =
  "@article{key,\n  author  = {},\n  title   = {},\n  journal = {},\n  year    = {}\n}"

/**
 * The References rail of a paper bundle: every entry of its .bib, whether the paper
 * cites it, and the three ways of changing the file by hand (add, edit as BibTeX,
 * remove). Each save is a new version of the bundle, exactly like editing the source;
 * the rest of the file (comments, @string macros, untouched entries) survives as it was.
 * Agents cite these keys from `read`, so the list is also what they see.
 */
export function ReferencesPanel({
  shortId,
  bib,
  baseVersion,
  canPublish,
}: {
  shortId: string
  bib: Bibliography
  /** The artifact's current version: a save against an older one is refused (409). */
  baseVersion: number
  canPublish: boolean
}) {
  // `null` closed, `""` a new entry, else the key being edited.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const cited = new Set(bib.cited)
  const save = useApiMutation<Awaited<ReturnType<typeof api.putBib>>, BibOp[]>({
    mutationFn: (ops) => api.putBib(shortId, { base_version: baseVersion, ops }),
    invalidate: [["artifact", shortId]],
    success: (a) => `Saved v${a.current_version}`,
    onSuccess: () => {
      setEditing(null)
      setError(null)
    },
    errorToast: false,
    onError: (e) => setError(e instanceof Error ? e.message : "The reference could not be saved."),
  })
  const open = (key: string | null, raw: string) => {
    setEditing(key ?? "")
    setDraft(raw)
    setError(null)
  }
  const submit = () => {
    const raw = draft.trim()
    if (!raw) return
    save.mutate([editing ? { op: "set", key: editing, raw } : { op: "set", raw }])
  }
  const remove = (entry: BibEntry) => {
    if (!window.confirm(`Remove ${entry.key} from ${bib.path}?`)) return
    save.mutate([{ op: "delete", key: entry.key }])
  }
  const entries = [...bib.entries].sort((a, b) => a.key.localeCompare(b.key))
  return (
    <section
      aria-label="References"
      className="flex min-h-0 flex-1 flex-col overflow-auto p-4"
      data-testid="references-panel"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <SectionTitle as="h2">References</SectionTitle>
          <p className="text-2xs text-muted-foreground">
            {entries.length} {entries.length === 1 ? "entry" : "entries"} in{" "}
            <span className="font-mono">{bib.path}</span>, {cited.size} cited. Showing v
            {bib.version}.
          </p>
        </div>
        {canPublish && editing === null && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => open(null, TEMPLATE)}
            data-testid="references-add"
          >
            Add
          </Button>
        )}
      </div>
      {editing !== null && (
        <form
          className="mt-3 flex flex-col gap-2"
          data-testid="references-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            spellCheck={false}
            aria-label={editing ? `BibTeX for ${editing}` : "New BibTeX entry"}
            className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs leading-relaxed text-foreground"
            data-testid="references-editor"
          />
          {error && (
            <p className="text-xs text-destructive" data-testid="references-error">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={save.isPending || !draft.trim()}
              data-testid="references-save"
            >
              {save.isPending ? "Publishing…" : editing ? "Save" : "Add entry"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(null)}
              disabled={save.isPending}
              data-testid="references-cancel"
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {bib.diagnostics.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="references-diagnostics">
          {bib.diagnostics[0]?.message}
          {bib.diagnostics.length > 1 ? ` (+${bib.diagnostics.length - 1} more)` : ""}
        </p>
      )}
      <ul className="mt-4 space-y-2">
        {entries.map((entry) => (
          <li
            key={entry.key}
            className="rounded-lg border border-border bg-secondary/20 p-3"
            data-testid={`references-entry-${entry.key}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-foreground">
                  {entry.key}
                  {cited.has(entry.key) && (
                    <span className="ml-2 rounded-sm bg-muted px-1 py-0.5 font-sans text-2xs uppercase tracking-wide text-muted-foreground">
                      cited
                    </span>
                  )}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {[entry.fields.author, entry.fields.year, entry.fields.title]
                    .filter(Boolean)
                    .join(" · ") || entry.type}
                </p>
              </div>
              {canPublish && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => open(entry.key, entry.raw)}
                    data-testid={`references-edit-${entry.key}`}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={save.isPending}
                    onClick={() => remove(entry)}
                    data-testid={`references-remove-${entry.key}`}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-sm text-muted-foreground">
            No entries yet. Add one, and cite it with <span className="font-mono">\cite</span>.
          </li>
        )}
      </ul>
    </section>
  )
}
