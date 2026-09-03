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
import { skillsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { refFor } from "../artifact/parse-ref"
import { NEW_SKILL_PROMPT } from "./new-skill-prompt"

export const skillDisplayName = (title: string | null, name: string): string => {
  const authored = title?.trim()
  if (authored && authored !== name) return authored
  const readable = name.replaceAll("-", " ")
  return readable.charAt(0).toUpperCase() + readable.slice(1)
}

export function Skills() {
  useDocumentTitle("Skills")
  const { openAssistant } = useShell()
  const { copied, copy } = useCopy(2000)
  const [query, setQuery] = useState("")
  const { data, isPending, isError, refetch } = useQuery(skillsQuery(query))
  const skills = data?.skills ?? []
  const connected = skills.filter((skill) => skill.skill.runtime !== "single").length

  return (
    <PageShell width="wide" className="flex flex-col gap-5">
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
              onClick={() => openAssistant(NEW_SKILL_PROMPT)}
            >
              <Icon name="plus" /> New skill
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-md">
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
        {!isPending && !isError ? (
          <p
            className="shrink-0 font-mono text-2xs text-muted-foreground"
            data-testid="skills-counts"
          >
            {skills.length}
            {data?.has_more ? "+" : ""} {skills.length === 1 ? "skill" : "skills"}
            {connected > 0 ? ` · ${connected} connected` : ""}
          </p>
        ) : null}
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
        <div className="grid gap-3 lg:grid-cols-2" data-testid="skills-grid">
          {skills.map((skill) => (
            <Link
              key={skill.short_id}
              to="/artifacts/$ref"
              params={{ ref: refFor(skill) }}
              data-testid={`skill-card-${skill.short_id}`}
              className="flex min-h-40 flex-col rounded-xl border border-border bg-card px-5 py-4 outline-none transition-colors hover:border-foreground/25 hover:bg-secondary/30 focus-visible:ring-2 focus-visible:ring-ring sm:min-h-44 sm:px-6 sm:py-5"
            >
              <h2 className="font-serif text-xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
                {skillDisplayName(skill.title, skill.skill.name)}
              </h2>
              <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-muted-foreground sm:line-clamp-3">
                {skill.skill.description}
              </p>
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-5 text-2xs text-muted-foreground">
                {skill.skill.workflow_launcher ? (
                  <Badge variant="brand" shape="pill">
                    Workflow launcher
                  </Badge>
                ) : null}
                <span className="capitalize">{skill.skill.runtime}</span>
                <span aria-hidden>·</span>
                <span className="font-mono">v{skill.current_version}</span>
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

function SkillGridSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-2" role="status" aria-label="Loading skills">
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
      <Skeleton className="h-8 w-full max-w-md rounded-lg" />
      <SkillGridSkeleton />
    </PageShell>
  )
}
