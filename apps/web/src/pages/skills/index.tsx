import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useShell } from "@/components/chrome/shell-context"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useCopy } from "@/lib/clipboard"
import { REVEAL } from "@/lib/interaction"
import { skillsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { cn } from "@/lib/utils"
import { refFor } from "../artifact/parse-ref"

export function Skills() {
  useDocumentTitle("Skills")
  const { openAssistant } = useShell()
  const { copied, copy } = useCopy(2000)
  const [query, setQuery] = useState("")
  const { data, isPending, isError, refetch } = useQuery(skillsQuery(query))
  const skills = data?.skills ?? []
  const connected = skills.filter((skill) => skill.skill.runtime !== "single").length

  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Workspace"
        title="Skills"
        subtitle="Shared instructions that Claude and Codex can install as local skills. Link them into graphs, see what they create, and keep every version reviewable."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="skills-sync-all"
              title="Copies a command that updates every Skill pinned in this project"
              onClick={() =>
                void copy("derive skill sync --all", { success: "Sync command copied" })
              }
            >
              <Icon name={copied ? "check" : "copy"} />
              {copied ? "Copied" : "Sync installed"}
            </Button>
            <Button
              size="sm"
              data-testid="skills-new"
              onClick={() =>
                openAssistant(
                  "Help me create a reusable Skill. Start by clarifying when it should trigger, then publish a standards-compatible SKILL.md bundle.",
                )
              }
            >
              <Icon name="plus" /> New skill
            </Button>
          </div>
        }
      />

      <div className="grid gap-2 sm:grid-cols-3">
        <Summary value={skills.length} label="shared skills" />
        <Summary value={connected} label="graphs or loops" />
        <Summary value={Math.max(0, skills.length - connected)} label="single skills" />
      </div>

      <div className="relative max-w-md">
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search skills"
          aria-label="Search skills"
          data-testid="skills-search"
          className="pl-9"
        />
      </div>

      {isPending ? (
        <SkillGridSkeleton />
      ) : isError ? (
        <LoadError
          title="Couldn’t load skills"
          testId="skills-retry"
          layout="inline"
          onRetry={() => refetch()}
        />
      ) : skills.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="skills-grid">
          {skills.map((skill) => (
            <Link
              key={skill.short_id}
              to="/artifacts/$ref"
              params={{ ref: refFor(skill) }}
              className="group flex min-h-44 flex-col rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-secondary/20"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                  <Icon name="skill" />
                </span>
                <Badge variant="outline" shape="pill" className="capitalize">
                  {skill.skill.runtime}
                </Badge>
              </div>
              <h2 className="mt-4 font-serif text-lg font-medium tracking-tight">
                {skill.skill.name}
              </h2>
              <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
                {skill.skill.description}
              </p>
              <div className="mt-auto flex items-center justify-between pt-4 font-mono text-2xs text-muted-foreground">
                <span>v{skill.current_version}</span>
                <span className={cn("flex items-center gap-1 text-foreground", REVEAL)}>
                  Open <Icon name="arrow" size={12} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Icon name="skill" />}
          title={query ? "No matching skills" : "No shared skills yet"}
          description={
            query
              ? "Try another name or description."
              : "Publish a SKILL.md bundle once, then install it in Claude or Codex wherever you work."
          }
          action={
            query ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="skills-clear-search"
                onClick={() => setQuery("")}
              >
                Clear search
              </Button>
            ) : undefined
          }
        />
      )}
    </PageShell>
  )
}

function Summary({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-baseline gap-2 rounded-xl border bg-card px-4 py-3">
      <strong className="font-mono text-lg font-medium tabular-nums">{value}</strong>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

function SkillGridSkeleton() {
  return (
    <div
      className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
      role="status"
      aria-label="Loading skills"
    >
      {[0, 1, 2].map((item) => (
        <Skeleton key={item} className="h-44 rounded-xl" />
      ))}
    </div>
  )
}

export function SkillsPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <Skeleton className="h-20 w-full max-w-3xl" />
      <div className="grid gap-2 sm:grid-cols-3">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
      <SkillGridSkeleton />
    </PageShell>
  )
}
