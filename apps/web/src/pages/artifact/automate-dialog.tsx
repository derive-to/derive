import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AutomationForm } from "../settings/automation-form"

// The per-artifact automate flow: create an automation scoped to THIS artifact (its short id
// rides along as a ref, and the instruction is seeded to "keep this current"). Same form as
// Settings → Automations, framed for one doc.
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="automate-dialog">
        <DialogHeader>
          <DialogTitle>Automate this artifact</DialogTitle>
          <DialogDescription>
            A standing job for {title ? `“${title}”` : "this document"}: an agent keeps it current
            on a schedule, on an event, or whenever you press Run now. Every run goes through the
            review loop.
          </DialogDescription>
        </DialogHeader>
        <AutomationForm
          refs={[shortId]}
          defaultInstruction="Keep this document current."
          onCreated={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
