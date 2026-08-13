import { createFileRoute } from "@tanstack/react-router"
import { AcceptCollectionInvite } from "@/pages/accept-invite"

export const Route = createFileRoute("/invite/c/$token")({
  component: AcceptCollectionInvite,
})
