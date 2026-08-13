import { useQuery } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PasswordGate } from "@/components/shared/password-gate"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { useDocumentTitle } from "@/lib/use-document-title"
import { ArtifactCard } from "./artifact-card"
import { ShareCollectionDialog } from "./share-collection-dialog"

/** The canonical collection link. It is intentionally a thin projection over the
 *  same collection record, artifact-list endpoint, cards, share dialog, and password
 *  gate used elsewhere—no public-only collection model to drift. */
export function PublicCollection() {
  const { id } = useParams({ from: "/collections/$id" })
  const nav = useNavigate()
  const [sharing, setSharing] = useState(false)
  const collection = useQuery({
    queryKey: ["collection", id],
    queryFn: () => api.getCollection(id),
    retry: false,
  })
  const locked = collection.error instanceof ApiError && collection.error.status === 401
  const artifacts = useQuery({
    queryKey: ["artifacts", "collection-link", id],
    queryFn: () => api.listArtifacts({ collection: id, limit: 100 }).then((r) => r.artifacts),
    enabled: !!collection.data,
  })
  useDocumentTitle(collection.data?.title ?? null)

  if (locked)
    return (
      <PasswordGate
        subject="collection"
        unlock={(password) => api.unlockCollection(id, password)}
        onUnlocked={() => collection.refetch()}
      />
    )
  if (collection.isError)
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-4">
        <EmptyState icon={<Icon name="collection" />} title="Collection not found">
          This link is unavailable or you don't have access.
        </EmptyState>
      </div>
    )
  if (!collection.data)
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Spinner />
      </div>
    )

  const col = collection.data
  // Effective role may come solely from an editor world link. That can edit
  // contents, but it cannot bootstrap re-sharing; the API's standing decision
  // is authoritative for whether this control exists.
  const canShare = col.can_share === true
  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
        <header className="flex flex-wrap items-end gap-4 border-b border-border-soft pb-6">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="collection" /> Collection
            </div>
            <h1 className="font-serif text-3xl font-medium tracking-tight text-foreground">
              {col.title}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {col.count} {col.count === 1 ? "artifact" : "artifacts"}
            </p>
          </div>
          {canShare && (
            <Button
              data-testid="collection-public-share"
              size="sm"
              onClick={() => setSharing(true)}
            >
              <Icon name="share" /> Share
            </Button>
          )}
        </header>

        {artifacts.isPending ? (
          <div className="grid min-h-48 place-items-center">
            <Spinner />
          </div>
        ) : artifacts.data?.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {artifacts.data.map((artifact) => (
              <ArtifactCard
                key={artifact.short_id}
                artifact={artifact}
                onOpen={() => nav({ to: "/artifacts/$ref", params: { ref: artifact.short_id } })}
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={<Icon name="collection" />} title="This collection is empty">
            Artifacts added here will appear through this same link.
          </EmptyState>
        )}
      </div>

      {sharing && (
        <ShareCollectionDialog
          collection={col}
          onChanged={() => {
            collection.refetch()
            artifacts.refetch()
          }}
          onClose={() => setSharing(false)}
        />
      )}
    </main>
  )
}
