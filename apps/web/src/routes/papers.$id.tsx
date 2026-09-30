import { createFileRoute } from "@tanstack/react-router"
import { paperQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { PaperPage, PaperPending } from "../pages/papers"

export const Route = createFileRoute("/papers/$id")({
  beforeLoad: requireOnboarded,
  loader: ({ context, params }) => context.queryClient.prefetchQuery(paperQuery(params.id)),
  pendingComponent: PaperPending,
  component: PaperPage,
})
