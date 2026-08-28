// Shared copy for Context creation and the status surfaces that follow it. Keep storage and
// runner terms out of the guided path; they describe implementation, not the Context's purpose.
export const BUILDER_COPY = {
  pageTitle: "New context",
  intro: "Describe the instructions, knowledge, and access an agent should have.",
  composerPlaceholder: "What should an agent know or be allowed to use?",
  agentDoorTitle: "Prefer your own agent to build it?",
  agentDoorBody:
    "Copy this prompt into Claude Code or any connected agent, and it will interview you and set the Context up here.",
  agentDoorPrompt: [
    "I want to create a new Context in our Derive workspace.",
    "Interview me briefly about what an agent using it should know or do, who should be able",
    "to use it, and which existing documents it should include.",
    "Then use the Derive MCP tools to create it: publish an instructions",
    'document from what I told you, then automate {action: "create_context"}',
    "with its short id. When you're done, give me the link to the new Context.",
  ].join(" "),
  expertDoor: "I already have a manifest",
  wsErrorTitle: "Couldn't load your workspace",
  wsErrorBody: "Derive needs to know which workspace this Context belongs to.",
  retryButton: "Try again",
  copyButton: "Copy",
  // The card's own headings. Here rather than inline in context-card.tsx for the reason the
  // rest of this file exists: a heading is copy a person reads, so it has to face the same
  // sweep — inline JSX text is exactly where the vocabulary this flow bans would slip back in.
  cardKnows: "What an agent gets",
  cardAnswers: "How an agent should respond",
  cardWont: "Limits",
  kindKnowledge: "Your team's agents can consult this as soon as it's created.",
  kindWorker:
    "An agent can also use this Context for tasks. Use it from your own agent session, or connect a dedicated runner later.",
  createdPrefix: "Ready. Open",
  degradedNotice:
    "This workspace doesn't have built-in chat turned on, so Derive can't interview you here. Your agent can still build it:",
  statusOnline: "Online. An agent is connected and can use this Context now.",
  statusOffline:
    "Offline. New work will wait until the runner is back. You can still read the Context.",
  statusNever: "No runner yet. Teammates' agents can still read the Context.",
} as const
