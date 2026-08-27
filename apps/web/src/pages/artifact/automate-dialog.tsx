import { useQuery } from "@tanstack/react-query"
import { AdminNote } from "@/components/shared/admin-note"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { workspaceQuery } from "@/lib/queries"
import { AutomationForm } from "../workflows/automation-form"

// Creates a single-Agent workflow scoped to this artifact and seeds its instruction. The API
// requires a workspace Admin, so other artifact owners see the same permission boundary here.
export function AutomateDialog({
  shortId,
  title,
  open,
  onOpenChange,
}: {
  shortId: string
  title?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // On a failed role read, fall back to the non-Admin note — never a form whose
  // submit would 403.
  const { data: ws, isError } = useQuery(workspaceQuery())
  const isAdmin = !isError && ws?.role === "owner"
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="automate-dialog"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Automate this artifact</DialogTitle>
          <DialogDescription>
            Ask an agent to keep {title ? `“${title}”` : "this artifact"} current on a schedule,
            after an event, or on demand. Manage it later under Workflows.
          </DialogDescription>
        </DialogHeader>
        {isAdmin ? (
          <AutomationForm
            refs={[shortId]}
            defaultInstruction="Keep this artifact current."
            runOnCreate
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <AdminNote can="create workflows" />
        )}
      </DialogContent>
    </Dialog>
  )
}
