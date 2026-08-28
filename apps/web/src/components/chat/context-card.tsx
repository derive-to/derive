import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { BuilderCard } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { BUILDER_COPY } from "@/pages/context/builder-copy"

function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </div>
  )
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1 text-sm text-foreground">
      {[...new Set(items)].map((item) => (
        <li key={item} className="flex gap-1.5">
          <span className="text-muted-foreground" aria-hidden>
            •
          </span>
          {item}
        </li>
      ))}
    </ul>
  )
}

export function ContextCard({ card }: { card: BuilderCard }) {
  const { draft, created } = card
  const hasKnowledge = draft.knows.length > 0 || draft.source_short_ids.length > 0

  return (
    <div
      className="mt-1 flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-3.5"
      data-testid="builder-context-card"
    >
      <div>
        <p className="text-sm font-medium text-foreground">{draft.name}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{draft.description}</p>
      </div>

      {hasKnowledge && (
        <CardSection title={BUILDER_COPY.cardKnows}>
          {draft.knows.length > 0 && <BulletList items={draft.knows} />}
          {draft.source_short_ids.length > 0 && (
            <div className="flex flex-wrap gap-x-2.5 gap-y-1">
              {draft.source_short_ids.map((shortId) => (
                <Link
                  key={shortId}
                  to="/artifacts/$ref"
                  params={{ ref: shortId }}
                  className="font-mono text-2xs text-muted-foreground underline-offset-4 hover:underline"
                >
                  /{shortId}
                </Link>
              ))}
            </div>
          )}
        </CardSection>
      )}

      <CardSection title={BUILDER_COPY.cardAnswers}>
        <p className="text-sm text-foreground">{draft.answers}</p>
      </CardSection>

      {draft.wont.length > 0 && (
        <CardSection title={BUILDER_COPY.cardWont}>
          <BulletList items={draft.wont} />
        </CardSection>
      )}

      <p className="text-xs text-muted-foreground">
        {draft.kind === "knowledge" ? BUILDER_COPY.kindKnowledge : BUILDER_COPY.kindWorker}
      </p>

      {created && (
        <Link
          to="/contexts/$id"
          params={{ id: created.context_id }}
          data-testid="builder-context-card-open"
          className="flex items-center gap-1 text-sm text-foreground hover:underline"
        >
          {BUILDER_COPY.createdPrefix} <span className="font-medium">{created.name}</span>
        </Link>
      )}
    </div>
  )
}
