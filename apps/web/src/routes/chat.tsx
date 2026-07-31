import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { ChatPage } from "../pages/chat"

// THE WORKSPACE CHAT: /chat — ask about the workspace, not one document.
//
// Deliberately NOT linked from the sidebar yet: reached by direct link (and by "continue in
// chat" from the surfaces that will point here) while it earns a permanent place in the nav.
//
// `session` deep-links a conversation, which is what makes an answer that outgrows another
// surface portable — the same transcript, opened here. `model` is the person's pick, in the
// URL so a reload keeps answering with what they chose.
export const Route = createFileRoute("/chat")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search.session === "string" ? search.session : undefined,
    model: typeof search.model === "string" ? search.model : undefined,
  }),
  component: ChatPage,
})
