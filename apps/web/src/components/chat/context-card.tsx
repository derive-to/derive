import { Link } from "@tanstack/react-router"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { BUILDER_COPY } from "@/pages/context/builder-copy"
import type { BuilderCardMeta } from "./builder-card"

// THE CARD THE BUILDER CONVERSATION PRODUCES. The guided flow never shows the raw
// manifest it is assembling — that document is jargon a first-timer has no reason to
// read — so this is the one thing standing in for it: a live, human-facing preview of
// the draft that updates turn over turn, rendered straight into the transcript so
// answering a few questions visibly becomes a context rather than vanishing into a
// tool call. Mirrors BuilderCard server-side (lib/context-builder-tools.ts); the
// server deliberately never sends manifest_md down, so this only ever has the
// human-facing scope fields to draw from. Matches the console rail card chrome
// (`rounded-xl border bg-card p-3.5`) so it reads as the same object once the context
// exists and the reader lands on its actual console.
export function ContextCard({ card }: { card: BuilderCardMeta }) {
  const { draft, created } = card
  const kindLine = draft.kind === "knowledge" ? BUILDER_COPY.kindKnowledge : BUILDER_COPY.kindWorker

  return (
    <div
      className="mt-1 flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-3.5"
      data-testid="builder-context-card"
    >
      <div>
        <p className="text-sm font-medium text-foreground">{draft.name || "Untitled context"}</p>
        {draft.description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{draft.description}</p>
        )}
      </div>

      {/* Empty knows/sources on an early turn (the interview has not covered scope yet) —
          the section simply doesn't render rather than showing a heading over nothing. */}
      {(draft.knows.length > 0 || draft.source_short_ids.length > 0) && (
        <div className="flex flex-col gap-1.5">
          <Eyebrow>What it knows</Eyebrow>
          {draft.knows.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm text-foreground">
              {draft.knows.map((k) => (
                <li key={k} className="flex gap-1.5">
                  <span className="text-muted-foreground" aria-hidden>
                    •
                  </span>
                  {k}
                </li>
              ))}
            </ul>
          )}
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
        </div>
      )}

      {draft.answers && (
        <div className="flex flex-col gap-1.5">
          <Eyebrow>How it answers</Eyebrow>
          <p className="text-sm text-foreground">{draft.answers}</p>
        </div>
      )}

      {draft.wont.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Eyebrow>What it won&rsquo;t do</Eyebrow>
          <ul className="flex flex-col gap-1 text-sm text-foreground">
            {draft.wont.map((w) => (
              <li key={w} className="flex gap-1.5">
                <span className="text-muted-foreground" aria-hidden>
                  •
                </span>
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{kindLine}</p>

      {/* Only the created state gets a footer — a still-drafting card has nowhere to
          send anyone yet, so it simply ends at the kind line above. */}
      {created && (
        <Link
          to="/contexts/$id"
          params={{ id: created.context_id }}
          data-testid="builder-context-card-open"
          className="flex items-center gap-1 border-t border-border-soft pt-2.5 text-sm text-foreground hover:underline"
        >
          {BUILDER_COPY.createdPrefix} <span className="font-medium">{created.name}</span>
        </Link>
      )}
    </div>
  )
}
