import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { ActivityPage } from "../pages/activity"

// The workspace Activity feed: /activity — everything recorded across every
// artifact (publishes, comments, resolved threads, shares, proposal decisions,
// first reads), day-grouped. A fixed named feed like /favorites and /following;
// it earns its own route rather than a library scope (it isn't artifact cards,
// it's an event log).
export const Route = createFileRoute("/activity")({
  beforeLoad: requireOnboarded,
  component: ActivityPage,
})
