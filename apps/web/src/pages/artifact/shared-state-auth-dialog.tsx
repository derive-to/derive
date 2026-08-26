import { Link } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { signupSourceSearch } from "@/lib/signup-source"

/** One host-owned auth gate for every interactive shared-state artifact. Artifact
 * code only asks to mutate; it never needs to know Derive's auth routes or chrome. */
export function SharedStateAuthDialog({
  open,
  onOpenChange,
  returnTo,
  artifactId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  returnTo: string
  artifactId: string
}) {
  const source = signupSourceSearch("shared_state", artifactId, returnTo)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shared-state-auth-dialog">
        <DialogHeader>
          <DialogTitle>Join in on Derive</DialogTitle>
          <DialogDescription>
            Sign in or create a free account to interact with this artifact. You’ll come right back
            here.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button asChild variant="outline" data-testid="shared-state-sign-in">
            <Link to="/login" search={{ return_to: returnTo, ...source }}>
              Sign in
            </Link>
          </Button>
          <Button asChild data-testid="shared-state-sign-up">
            <Link to="/login" search={{ signup: true, return_to: returnTo, ...source }}>
              Create free account
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
