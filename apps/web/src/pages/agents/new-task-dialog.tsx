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

/** The existing composer owns draft recovery, account setup and submission semantics. */
export function NewTaskDialog({ agent }: { agent: Agent }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="agent-new-task">
          New task
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
