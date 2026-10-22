import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { type AgentDetail, api } from "@/api"
import { Icon } from "@/components/icons"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useApiMutation } from "@/lib/use-api-mutation"
import { parseRef } from "../artifact/parse-ref"

export const agentArtifactsQuery = (id: string) => ({
  queryKey: ["agents", id, "artifacts"] as const,
  queryFn: () => api.agentArtifacts(id),
  refetchInterval: 30_000,
})

export function AgentArtifacts({ agent }: { agent: AgentDetail }) {
  const pins = useQuery(agentArtifactsQuery(agent.id))
  const [open, setOpen] = useState(false)
  const [ref, setRef] = useState("")
  const pin = useApiMutation({
    mutationFn: () => {
      const path = ref.trim().split(/[?#]/)[0] ?? ""
      return api.pinAgentArtifact(
        agent.id,
        parseRef(path.split("/").filter(Boolean).at(-1) ?? "").shortId,
        true,
      )
    },
    invalidate: [["agents", agent.id, "artifacts"]],
    onSuccess: () => {
      setOpen(false)
      setRef("")
    },
  })
  const remove = useApiMutation({
    mutationFn: (id: string) => api.pinAgentArtifact(agent.id, id, false),
    invalidate: [["agents", agent.id, "artifacts"]],
  })
  if (pins.isError)
    return (
      <LoadError
        title="Couldn’t load pinned artifacts."
        testId="agent-artifacts-retry"
        onRetry={() => void pins.refetch()}
      />
    )
  if (!agent.can_manage && !pins.data?.artifacts.length) return null
  return (
    <section
      aria-label="Pinned artifacts"
      data-testid="agent-artifacts"
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-muted-foreground">Pinned artifacts</h2>
        {agent.can_manage && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="xs" data-testid="agent-pin-add">
                Pin artifact
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>Pin an artifact</DialogTitle>
              <DialogDescription>
                Keep a document this agent maintains here. Pins open its latest version. Document
                permissions stay the same.
              </DialogDescription>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (ref.trim() && !pin.isPending) pin.mutate()
                }}
              >
                <Input
                  aria-label="Artifact link or ID"
                  placeholder="Paste an artifact link or ID"
                  data-testid="agent-pin-ref"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
                <Button
                  type="submit"
                  data-testid="agent-pin-save"
                  disabled={!ref.trim()}
                  loading={pin.isPending}
                >
                  Pin artifact
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {pins.isPending ? (
        <p className="text-sm text-muted-foreground">Loading artifacts…</p>
      ) : pins.data.artifacts.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {pins.data.artifacts.map((art) => (
            <div
              key={art.short_id}
              className="flex min-w-0 items-center rounded-lg border border-border"
            >
              <Link
                to="/artifacts/$ref"
                params={{ ref: art.short_id }}
                data-testid={`agent-pin-${art.short_id}`}
                className="flex min-w-0 flex-1 items-center gap-3 p-3 hover:bg-secondary"
              >
                <Icon name="link" className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{art.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Latest version · v{art.version}
                  </p>
                </div>
              </Link>
              {agent.can_manage && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="mr-2"
                  aria-label={`Unpin ${art.title}`}
                  data-testid={`agent-unpin-${art.short_id}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(art.short_id)}
                >
                  <Icon name="close" />
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Pin the artifacts this agent maintains to keep them within reach.
        </p>
      )}
    </section>
  )
}
