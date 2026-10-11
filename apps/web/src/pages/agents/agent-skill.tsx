import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useBlocker } from "@tanstack/react-router"
import { lazy, Suspense, useState } from "react"
import { type AgentDetail, api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { artifactQuery } from "@/lib/queries"
import { skillPreviewSource } from "@/lib/skill-source"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AskPanel } from "@/pages/artifact/ask-panel"

const SourceEditor = lazy(() =>
  import("@/pages/artifact/source-editor").then((m) => ({ default: m.SourceEditor })),
)

/** Use the artifact editor and Chat. A skill has one owner and one version history. */
export function AgentSkill({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient()
  const id = agent.instructions_short_id
  const artifact = useQuery({ ...artifactQuery(id ?? ""), enabled: !!id, refetchInterval: 10_000 })
  const content = useQuery({
    queryKey: ["artifacts", id, "skill-preview", artifact.data?.current_version],
    queryFn: async () => {
      const source = await api.skillSource(id ?? "")
      return (
        await api.renderPreview(skillPreviewSource(source.source), artifact.data?.title ?? null)
      ).html
    },
    enabled: !!id && !!artifact.data,
  })
  const [chat, setChat] = useState(false)
  const [draft, setDraft] = useState<{ source: string; original: string; version: number } | null>(
    null,
  )
  const [cancelRequested, setCancelRequested] = useState(false)
  const [message, setMessage] = useState("")
  const edit = useApiMutation({
    mutationFn: () => api.skillSource(id ?? ""),
    onSuccess: (source) => {
      publish.reset()
      setDraft({ ...source, original: source.source })
    },
  })
  const publish = useApiMutation({
    errorToast: false,
    mutationFn: () =>
      api.publishSkillSource(id ?? "", {
        source: draft?.source ?? "",
        base_version: draft?.version ?? 0,
        message: message.trim(),
      }),
    invalidate: [artifactQuery(id ?? "").queryKey, ["artifacts", id], ["skills"]],
    onSuccess: (saved) => {
      qc.setQueryData(artifactQuery(id ?? "").queryKey, saved)
      setDraft(null)
      setMessage("")
      if (blocker.status === "blocked") blocker.proceed()
    },
  })
  const dirty = !!draft && (draft.source !== draft.original || message.trim() !== "")
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  })
  if (!id)
    return (
      <p className="text-base text-muted-foreground">
        Choose a skill in Settings to give this agent its instructions.
      </p>
    )
  if (artifact.isError || content.isError)
    return (
      <LoadError
        title="Couldn’t open this skill."
        testId="agent-skill-retry"
        onRetry={() => {
          void artifact.refetch()
          void content.refetch()
        }}
      />
    )
  if (!artifact.data || content.isPending) return <Skeleton className="h-96 w-full" />
  const canEdit = artifact.data.my_role === "owner" || artifact.data.my_role === "editor"
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base font-medium">{artifact.data.title ?? `${agent.name} skill`}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Version {artifact.data.current_version} · The next task uses the latest version.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" data-testid="agent-skill-open">
            <Link to="/artifacts/$ref" params={{ ref: id }}>
              Open skill
            </Link>
          </Button>
          {canEdit && !draft && (
            <Button
              variant="outline"
              size="sm"
              data-testid="agent-skill-edit"
              loading={edit.isPending}
              onClick={() => edit.mutate()}
            >
              Edit instructions
            </Button>
          )}
          {canEdit && !draft && (
            <Button size="sm" data-testid="agent-skill-ai" onClick={() => setChat(true)}>
              Write with AI
            </Button>
          )}
        </div>
      </div>
      {publish.error && draft && (
        <p role="alert" className="text-sm text-destructive">
          {publish.error.message} Your draft is still here.
        </p>
      )}
      <div className={chat ? "grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]" : ""}>
        <div className="min-h-96 overflow-hidden rounded-xl border border-border bg-card">
          {draft ? (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <SourceEditor
                title={artifact.data.title ?? "Skill"}
                format="md"
                src={draft.source}
                message={message}
                onSrc={(source) => setDraft({ ...draft, source })}
                onMessage={setMessage}
                onCancel={() => {
                  if (!publish.isPending) {
                    if (dirty) setCancelRequested(true)
                    else {
                      setDraft(null)
                      setMessage("")
                    }
                  }
                }}
                onPublish={() => {
                  if (!publish.isPending) publish.mutate()
                }}
                publishing={publish.isPending}
                shortId={id}
                stripFrontmatter
                publishLabel="Save skill"
              />
            </Suspense>
          ) : (
            <iframe
              title="Skill instructions"
              srcDoc={content.data}
              sandbox="allow-popups"
              className="h-[32rem] w-full border-0"
            />
          )}
        </div>
        {chat && (
          <aside
            aria-label="Write your skill"
            className="min-h-96 overflow-hidden rounded-xl border border-border"
          >
            <AskPanel
              shortId={id}
              currentVersion={artifact.data.current_version}
              onGoToVersion={() => {
                void artifact.refetch()
                void content.refetch()
              }}
              onClose={() => setChat(false)}
            />
          </aside>
        )}
      </div>
      <ConfirmDialog
        open={cancelRequested || (!publish.isPending && blocker.status === "blocked")}
        onOpenChange={(open) => {
          if (!open) {
            setCancelRequested(false)
            if (blocker.status === "blocked") blocker.reset()
          }
        }}
        title="Discard unsaved skill changes?"
        description="Your saved skill stays as it is. These draft changes will be lost."
        confirmLabel="Discard changes"
        confirmTestId="agent-skill-discard"
        onConfirm={() => {
          setDraft(null)
          setMessage("")
          setCancelRequested(false)
          if (blocker.status === "blocked") blocker.proceed()
        }}
      />
    </div>
  )
}
