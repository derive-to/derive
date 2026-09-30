import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Icon } from "@/components/icons"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import { useCopy } from "@/lib/clipboard"
import { agentsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { cn } from "@/lib/utils"
import { firstLine, rosterOf } from "./format"

// Used only when the workspace has no agents with a description of their own.
const FALLBACK_EXAMPLES = [
  "Build a review companion page for a set of pull requests",
  "Answer data questions from the warehouse and publish charts",
  "Every weekday at 9:00, rewrite the metrics page with current figures",
]

const PLACEHOLDER = "<what it should do>"

/** The prompt a person pastes into Claude Code or Codex with Derive connected. Creation is
 *  MCP-only (skills/agents.md): the coding session publishes the instructions page, then
 *  calls `agents` create, and hands back anything that needs a browser. */
export const pastePrompt = (task: string) =>
  [
    `Make me a Derive agent that does this: ${task}`,
    "",
    "Read derive://skills/agents first. Publish its instructions as a Derive page, then create it with the Derive MCP agents tool (action: create), passing that page's short_id as instructions. Use machine: owner so it runs on this computer, and add a schedule if the work should run on its own.",
    "When it is created, give me the runner_command and any needs_browser links.",
  ].join("\n")

// New agent: a copy box, not a form. The agent is made by a coding session over MCP; this
// page hands that session the words to do it.
export function NewAgent() {
  useDocumentTitle("New agent")
  const agents = useQuery(agentsQuery())
  const [task, setTask] = useState<string | null>(null)
  const { copied, copy } = useCopy()

  const own = rosterOf(agents.data ?? [])
    .map((a) => (a.description ? firstLine(a.description) : ""))
    .filter((d, i, all) => d && all.indexOf(d) === i)
    .slice(0, 3)
  const examples = own.length ? own : FALLBACK_EXAMPLES
  const prompt = pastePrompt(task ?? PLACEHOLDER)

  return (
    <PageShell className="flex flex-col gap-7">
      <PageHeader title="New agent" />
      <div className="flex flex-col gap-2.5">
        <pre
          data-testid="new-agent-prompt"
          className="rounded-xl border border-border bg-secondary px-5 py-4 font-sans text-base leading-relaxed whitespace-pre-wrap text-foreground"
        >
          {prompt}
        </pre>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Paste it into Claude Code or Codex with Derive connected.
          </p>
          <Button
            type="button"
            size="sm"
            data-testid="new-agent-copy"
            onClick={() => void copy(prompt)}
          >
            <Icon name={copied ? "check" : "copy"} />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      {agents.isError ? (
        <LoadError
          layout="inline"
          title="Couldn’t load this workspace’s agents."
          testId="new-agent-retry"
          onRetry={() => void agents.refetch()}
        />
      ) : (
        !agents.isPending && (
          <div className="flex flex-col text-sm text-muted-foreground">
            {own.length ? "Things people here have made" : "For example"}
            <div className="mt-2 flex flex-col">
              {examples.map((e) => (
                <button
                  key={e}
                  type="button"
                  data-testid="new-agent-example"
                  onClick={() => setTask(e)}
                  className={cn(
                    "border-t border-border py-2 text-left text-base text-foreground hover:text-muted-foreground",
                    task === e && "font-medium",
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )
      )}
    </PageShell>
  )
}
