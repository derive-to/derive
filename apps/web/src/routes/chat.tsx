import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { useDocumentTitle } from "../lib/use-document-title"
import { AskPanel } from "../pages/artifact/ask-panel"

export const Route = createFileRoute("/chat")({
  beforeLoad: requireOnboarded,
  component: WorkspaceChat,
})

function WorkspaceChat() {
  useDocumentTitle("Chat")
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <AskPanel currentVersion={0} onGoToVersion={() => {}} />
    </div>
  )
}
