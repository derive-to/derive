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
import { when } from "./format"
import { Field, Sub, Verb } from "./rows"

export const agentArtifactsQuery = (id: string) => ({
  queryKey: ["agents", id, "artifacts"] as const,
  queryFn: () => api.agentArtifacts(id),
  refetchInterval: 30_000,
})

/** The pages an agent keeps (its log, its casebook), one line each under the page's title.
 *  Nothing at all when none are pinned: pinning lives in Settings. */
export function AgentPages({ agent }: { agent: AgentDetail }) {
  const pins = useQuery(agentArtifactsQuery(agent.id))
  if (!pins.data?.artifacts.length) return null
  return (
    <div data-testid="agent-pages" className="flex flex-col gap-1.5">
      {pins.data.artifacts.map((art) => (
        <div key={art.short_id} className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon name="page" size={15} strokeWidth={1.75} className="shrink-0" />
          <Link
            to="/artifacts/$ref"
            params={{ ref: art.short_id }}
            data-testid={`agent-pin-${art.short_id}`}
            className="truncate font-medium text-foreground hover:underline"
          >
            {art.title}
          </Link>
          <span className="shrink-0">
            · v{art.version} · updated {when(art.updated_at)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Settings › Pages: pin and unpin the pages an agent keeps. A pin opens the latest version;
 *  page permissions stay the page's own. */
export function PagesField({ agent }: { agent: AgentDetail }) {
  const pins = useQuery(agentArtifactsQuery(agent.id))
  const [open, setOpen] = useState(false)
  const [ref, setRef] = useState("")
  const invalidate = [["agents", agent.id, "artifacts"]]
  const pin = useApiMutation({
    mutationFn: () => {
      const path = ref.trim().split(/[?#]/)[0] ?? ""
      return api.pinAgentArtifact(
        agent.id,
        parseRef(path.split("/").filter(Boolean).at(-1) ?? "").shortId,
        true,
      )
    },
    invalidate,
    onSuccess: () => {
      setOpen(false)
      setRef("")
    },
  })
  const remove = useApiMutation({
    mutationFn: (id: string) => api.pinAgentArtifact(agent.id, id, false),
    invalidate,
  })
  const edit = agent.can_manage
  if (!edit && !pins.data?.artifacts.length) return null
  return (
    <Field
      label="Pages"
      action={
        edit && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Verb testId="agent-pin-add" onClick={() => setOpen(true)}>
                Add
              </Verb>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>Pin a page</DialogTitle>
              <DialogDescription>
                A page this agent keeps, shown under its name. Pins open the latest version. Page
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
                  aria-label="Page link or ID"
                  placeholder="Paste a page link or ID"
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
                  Pin page
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )
      }
    >
      {pins.isError ? (
        <LoadError
          layout="inline"
          title="Couldn’t load its pages."
          testId="agent-artifacts-retry"
          onRetry={() => void pins.refetch()}
        />
      ) : pins.data?.artifacts.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="agent-artifacts">
          {pins.data.artifacts.map((art) => (
            <li key={art.short_id} className="flex items-center gap-2">
              <Link
                to="/artifacts/$ref"
                params={{ ref: art.short_id }}
                data-testid={`agent-pin-row-${art.short_id}`}
                className="truncate text-foreground underline-offset-4 hover:underline"
              >
                {art.title}
              </Link>
              {edit && (
                <Verb
                  testId={`agent-unpin-${art.short_id}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(art.short_id)}
                >
                  Unpin
                </Verb>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-muted-foreground">None</span>
      )}
      <Sub>The pages it maintains, such as a log or a casebook.</Sub>
    </Field>
  )
}
