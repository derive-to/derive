import { useQuery } from "@tanstack/react-query"
import { api, type Verb } from "@/api"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { artifactVerbsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

// WO6 — the viewer action bar. Owner-authored verbs render as real buttons; a click invokes
// one and toasts the outcome. Lives in the artifact chrome, NEVER inside the sandboxed page —
// the page itself can't invoke, only these owner-authored verbs can.
export function VerbBar({ shortId }: { shortId: string }) {
  const { data: verbs, isError } = useQuery(artifactVerbsQuery(shortId))
  const invoke = useApiMutation({
    mutationFn: (v: Verb) => api.invokeVerb(v.id, {}),
    onSuccess: (_r, v) =>
      toast.success(v.gate === "direct" ? `${v.name} ran` : `${v.name} — proposed for review`),
  })
  if (isError || !verbs) return null
  const shown = verbs.filter((v) => v.enabled)
  if (shown.length === 0) return null
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-card px-4 py-2"
      data-testid="verb-bar"
    >
      {shown.map((v) => (
        <Button
          key={v.id}
          size="sm"
          variant={v.gate === "direct" ? "default" : "secondary"}
          disabled={invoke.isPending}
          data-testid={`verb-${v.name}`}
          onClick={() => invoke.mutate(v)}
        >
          {v.name}
          {v.gate === "propose" ? (
            <span className="ml-1.5 text-2xs text-muted-foreground">proposes</span>
          ) : null}
        </Button>
      ))}
    </div>
  )
}
