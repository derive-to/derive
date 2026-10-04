import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { AskPanel } from "../pages/artifact/ask-panel"

export const Route = createFileRoute("/chat")({
  beforeLoad: requireOnboarded,
  component: WorkspaceChat,
})

function WorkspaceChat() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border px-6 py-5">
        <h1 className="text-lg font-medium">Luna</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find what matters. Work with the artifacts in your workspace.
        </p>
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <AskPanel currentVersion={0} onGoToVersion={() => {}} />
      </div>
    </div>
  )
}
