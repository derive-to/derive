import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { api, type Job } from "@/api"
import { Icon } from "@/components/icons"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { useApiMutation } from "@/lib/use-api-mutation"
import { parseRef } from "../artifact/parse-ref"
import { agentArtifactsQuery } from "./agent-artifacts"

type Effect = NonNullable<Job["result"]["effects"]>[number]
export function TaskEffects({
  effects,
  id,
  agentId,
  canPin = false,
}: {
  effects: Effect[]
  id: string
  agentId: string
  canPin?: boolean
}) {
  const pins = useQuery({ ...agentArtifactsQuery(agentId), enabled: canPin })
  const pin = useApiMutation({
    mutationFn: (ref: string) => api.pinAgentArtifact(agentId, parseRef(ref).shortId, true),
    invalidate: [["agents", agentId, "artifacts"]],
  })
  if (!effects.length) return null
  return (
    <section className="flex flex-col gap-2" aria-label="Task artifacts">
      {canPin && pins.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t check artifact pins."
          testId={`task-pins-retry-${id}`}
          onRetry={() => void pins.refetch()}
        />
      )}
      {effects.map((effect, i) => {
        const parsed = effect.ref ? parseRef(effect.ref) : null
        const version = effect.version ?? parsed?.version
        const ref = parsed ? `${parsed.shortId}${version ? `@v${version}` : ""}` : null
        const pinned = pins.data?.artifacts.some((a) => a.short_id === parsed?.shortId)
        return (
          <div
            key={`${effect.kind}-${effect.ref ?? effect.url}-${effect.version}-${effect.label}`}
            className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm"
          >
            <Icon name="link" className="size-4 shrink-0 text-muted-foreground" />
            {effect.kind === "page" && ref ? (
              <Link
                to="/artifacts/$ref"
                params={{ ref }}
                data-testid={`job-effect-${id}-${i}`}
                className="min-w-0 flex-1 break-words font-medium hover:underline"
              >
                {effect.label}{" "}
                <span className="ml-2 font-normal text-muted-foreground">
                  {version ? `v${version}` : "Latest version"}
                </span>
              </Link>
            ) : effect.url && /^https?:\/\//i.test(effect.url) ? (
              <a
                href={effect.url}
                target="_blank"
                rel="noreferrer"
                data-testid={`job-effect-${id}-${i}`}
                className="min-w-0 flex-1 break-words hover:underline"
              >
                {effect.label}
              </a>
            ) : (
              <span className="min-w-0 flex-1 break-words">{effect.label}</span>
            )}
            {canPin && effect.kind === "page" && parsed && (
              <Button
                variant="ghost"
                size="xs"
                data-testid={`task-pin-${id}-${i}`}
                disabled={pinned || pin.isPending || !pins.isSuccess}
                onClick={() => pin.mutate(parsed.shortId)}
              >
                {pinned ? "Pinned" : "Pin to agent"}
              </Button>
            )}
          </div>
        )
      })}
    </section>
  )
}
