import type { Agent } from "@/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { TaskComposer } from "./task-composer"

/** The existing composer owns draft recovery, account setup and submission semantics. Where
 *  the ask is not the page's main act (a scheduled agent, a task page) it opens from a quiet
 *  verb instead of a filled button. */
export function NewTaskDialog({ agent, quiet = false }: { agent: Agent; quiet?: boolean }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={quiet ? "ghost" : "default"} size="sm" data-testid="agent-new-task">
          {quiet ? "Ask" : "New task"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogTitle>Ask {agent.name}</DialogTitle>
        <DialogDescription>
          Start a task. Follow-ups stay in the same conversation.
        </DialogDescription>
        <TaskComposer agent={agent} />
      </DialogContent>
    </Dialog>
  )
}
