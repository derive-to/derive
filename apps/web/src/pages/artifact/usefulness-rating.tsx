import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ThumbsDown, ThumbsUp } from "lucide-react"
import { useState } from "react"
import {
  type ArtifactRatingReason,
  type ArtifactRatingResponse,
  type ArtifactRatingValue,
  api,
} from "@/api"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover"
import { artifactRatingQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

const positiveReasons = [
  ["clear", "Clear"],
  ["current", "Current"],
  ["reusable", "Reusable"],
  ["saved_time", "Saved time"],
] as const satisfies readonly (readonly [ArtifactRatingReason, string])[]

const negativeReasons = [
  ["outdated", "Outdated"],
  ["wrong_scope", "Wrong scope"],
  ["unclear", "Unclear"],
  ["duplicate", "Duplicate"],
] as const satisfies readonly (readonly [ArtifactRatingReason, string])[]

export function UsefulnessRating({ shortId, version }: { shortId: string; version: number }) {
  const query = artifactRatingQuery(shortId, version)
  const { data, isError } = useQuery(query)
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"positive" | "negative">("positive")

  const mutation = useMutation({
    mutationFn: (
      next: { value: ArtifactRatingValue; reason: ArtifactRatingReason | null } | null,
    ) =>
      next
        ? api.setArtifactRating(shortId, version, next.value, next.reason)
        : api.clearArtifactRating(shortId, version),
    onSuccess: (next: ArtifactRatingResponse) => client.setQueryData(query.queryKey, next),
  })

  if (isError) return null
  if (!data?.eligible) return null

  const selected = data.rating?.value
  const choose = async (value: ArtifactRatingValue, nextMode: "positive" | "negative") => {
    setMode(nextMode)
    if (
      (value === "not_useful" && selected === "not_useful") ||
      (value === "useful" && (selected === "useful" || selected === "essential"))
    ) {
      setOpen(false)
      await mutation.mutateAsync(null).catch(() => undefined)
      return
    }
    const saved = await mutation.mutateAsync({ value, reason: null }).catch(() => null)
    if (!saved) return
    setOpen(true)
  }

  const refine = (value: ArtifactRatingValue, reason: ArtifactRatingReason | null) =>
    mutation.mutate({ value, reason })

  const reasons = mode === "positive" ? positiveReasons : negativeReasons
  const aggregate = data.aggregate

  return (
    <div className="flex shrink-0 items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <fieldset className="flex items-center gap-0.5">
            <legend className="sr-only">Rate this artifact version</legend>
            <Button
              type="button"
              size="icon-sm"
              variant={selected === "not_useful" ? "secondary" : "ghost"}
              aria-label="Not useful"
              title="Not useful"
              aria-pressed={selected === "not_useful"}
              data-testid="artifact-rating-not-useful"
              loading={mutation.isPending && mode === "negative"}
              onClick={() => void choose("not_useful", "negative")}
            >
              <ThumbsDown className="size-4" aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant={selected === "useful" || selected === "essential" ? "secondary" : "ghost"}
              aria-label={selected === "essential" ? "Essential" : "Useful"}
              title={selected === "essential" ? "Essential" : "Useful"}
              aria-pressed={selected === "useful" || selected === "essential"}
              data-testid="artifact-rating-useful"
              loading={mutation.isPending && mode === "positive"}
              onClick={() => void choose("useful", "positive")}
            >
              <ThumbsUp className="size-4" aria-hidden />
            </Button>
          </fieldset>
        </PopoverAnchor>
        <PopoverContent side="top" align="center" className="w-80">
          <PopoverHeader>
            <PopoverTitle>
              {mode === "positive" ? "What made it useful?" : "What should improve?"}
            </PopoverTitle>
            <PopoverDescription>Your note improves future search results.</PopoverDescription>
          </PopoverHeader>

          {mode === "positive" && (
            <Button
              type="button"
              size="sm"
              variant={selected === "essential" ? "secondary" : "outline"}
              aria-pressed={selected === "essential"}
              data-testid="artifact-rating-essential"
              onClick={() => refine("essential", data.rating?.reason ?? null)}
            >
              <span className="flex -space-x-1" aria-hidden>
                <ThumbsUp className="size-3.5" />
                <ThumbsUp className="size-3.5" />
              </span>
              Essential
            </Button>
          )}

          <div className="flex flex-wrap gap-1.5">
            {reasons.map(([reason, label]) => {
              const active = data.rating?.reason === reason
              return (
                <Button
                  key={reason}
                  type="button"
                  size="xs"
                  variant={active ? "secondary" : "outline"}
                  aria-pressed={active}
                  data-testid={`artifact-rating-reason-${reason}`}
                  onClick={() =>
                    refine(
                      mode === "positive"
                        ? selected === "essential"
                          ? "essential"
                          : "useful"
                        : "not_useful",
                      active ? null : reason,
                    )
                  }
                >
                  {label}
                </Button>
              )
            })}
          </div>

          {aggregate && (
            <p className={cn("text-xs text-muted-foreground", mutation.isPending && "opacity-60")}>
              {aggregate.helpful_percent}% useful from {aggregate.total} ratings
              {aggregate.essential > 0 ? ` · ${aggregate.essential} essential` : ""}
            </p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
