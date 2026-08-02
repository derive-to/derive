import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { ChatPage } from "../pages/chat"

// THE WORKSPACE CHAT: /chat — ask about the workspace, not one document.
//
// The full-width surface for the same conversation the assistant dock holds (chrome/
// assistant-panel): reached from the dock's Expand, from the rail on a phone (where there is no
// dock), and by direct link.
//
// `session` deep-links a conversation, which is what makes an answer that outgrows another
// surface portable — the same transcript, opened here. `model` is the person's pick, in the
// URL so a reload keeps answering with what they chose. `ask` is a question handed over by
// another surface, sent once on arrival and then stripped (see pages/chat).
export const Route = createFileRoute("/chat")({
  beforeLoad: requireOnboarded,
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search.session === "string" ? search.session : undefined,
    model: typeof search.model === "string" ? search.model : undefined,
    ask: typeof search.ask === "string" && search.ask.trim() ? search.ask : undefined,
  }),
  component: ChatPage,
})
