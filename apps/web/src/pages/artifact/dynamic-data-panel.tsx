import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type DynamicSlot } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { dynamicHistoryQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"

/**
 * The Data rail: the dynamic tables and figures this version binds, who last changed
 * each, and its retained revisions. Read-mostly on purpose: cells are written by the
 * agents and scripts that track an experiment (the REST route, see
 * derive://skills/dynamic-data), and a person's one-click need is replacing a figure's
 * image. Everything else stays a matter of reading the numbers in the document.
 */
export function DynamicDataPanel({
  shortId,
  version,
  slots,
  error,
  canPublish,
}: {
  shortId: string
  version: number
  slots: DynamicSlot[]
  error: boolean
  canPublish: boolean
}) {
  return (
    <section
      aria-label="Dynamic tables and figures"
      className="flex min-h-0 flex-1 flex-col overflow-auto p-4"
      data-testid="dynamic-data-panel"
    >
      <div className="min-w-0">
        <SectionTitle as="h2">Data</SectionTitle>
        <p className="text-2xs text-muted-foreground">
          Tables and figures updated without a new version. Showing v{version}.
        </p>
      </div>
      {error && (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="dynamic-data-error">
          The data could not be loaded. Reload to try again.
        </p>
      )}
      <ul className="mt-4 space-y-3">
        {slots.map((slot) => (
          <DynamicSlotRow key={slot.name} shortId={shortId} slot={slot} canPublish={canPublish} />
        ))}
      </ul>
    </section>
  )
}

const ACCEPTED_IMAGES = "image/png,image/jpeg,image/gif,image/webp"

function DynamicSlotRow({
  shortId,
  slot,
  canPublish,
}: {
  shortId: string
  slot: DynamicSlot
  canPublish: boolean
}) {
  const [open, setOpen] = useState(false)
  const history = useQuery({
    ...dynamicHistoryQuery(shortId, slot.name, slot.version),
    enabled: open,
  })
  // Replace a figure's image: upload the file as an asset, then point the slot at it.
  // No version is minted; the served page and every open viewer swap the image.
  const replace = useApiMutation<DynamicSlot, File>({
    mutationFn: async (file) => {
      const asset = await api.uploadAsset(file)
      return api.patchDynamicSlot(shortId, slot.name, {
        kind: "figure",
        figure: { url: asset.url },
      })
    },
    invalidate: [["artifact", shortId, "dynamic"]],
    success: "Figure replaced.",
  })
  const pickImage = () => {
    const input = document.createElement("input")
    input.type = "file"
    // What the asset route actually accepts (it sniffs magic bytes, and refuses SVG).
    input.accept = ACCEPTED_IMAGES
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) replace.mutate(file)
    }
    input.click()
  }
  const rows = slot.value.kind === "table" ? slot.value.table.rows.length : null
  return (
    <li
      className="rounded-lg border border-border bg-secondary/20 p-3"
      data-testid={`dynamic-data-slot-${slot.name}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm text-foreground">{slot.name}</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {slot.kind === "table" ? `Table, ${rows} row${rows === 1 ? "" : "s"}` : "Figure"}
            <span className="font-mono"> · rev {slot.revision}</span>
            {" · "}
            {slot.updated_by.name}, {ago(slot.updated_at)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {slot.kind === "figure" && canPublish && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={replace.isPending}
              onClick={pickImage}
              data-testid={`dynamic-figure-replace-${slot.name}`}
            >
              Replace image
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            data-testid={`dynamic-data-history-${slot.name}`}
          >
            History
          </Button>
        </div>
      </div>
      {open && (
        <div className="mt-3 border-t border-border pt-3">
          <Eyebrow as="div">Revisions</Eyebrow>
          {history.isError ? (
            <p className="mt-1 text-xs text-muted-foreground">The history could not be loaded.</p>
          ) : (
            <ol className="mt-1 space-y-1 font-mono text-3xs text-muted-foreground">
              {(history.data?.revisions ?? []).map((r) => (
                <li key={r.revision} className="flex flex-wrap gap-x-2">
                  <span className="text-foreground">rev {r.revision}</span>
                  <span>{r.actor.name}</span>
                  <span>{ago(r.at)}</span>
                  {r.note && <span className="basis-full">{r.note}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  )
}
