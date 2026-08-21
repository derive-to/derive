// The copy a first-timer meets on their way to a context: the builder page itself (composer,
// empty state, the chat/agent/expert doors, the card the conversation produces) and the status
// lines the directory and console show them once it exists. Centralised because it carries a
// rule: none of it may lean on the vocabulary a first-timer has no reason to know yet —
// "manifest", "short id", "runner token", "serve" — the words that describe HOW a context is
// built rather than what it does.
export const BUILDER_COPY = {
  pageTitle: "New context",
  intro: "Describe what this context should know or do, as if you were briefing a teammate.",
  composerPlaceholder: "What should this context know or do?",
  agentDoorTitle: "Prefer your own agent to build it?",
  agentDoorBody:
    "Copy this prompt into Claude Code or any connected agent, and it will interview you and set the context up here.",
  agentDoorPrompt: [
    "I want to create a new context in our Derive workspace.",
    "Interview me briefly about what it should know or do, who should be able",
    "to ask it questions, and which existing documents it should learn from.",
    "Then use the Derive MCP tools to create it: publish an instructions",
    'document from what I told you, then automate {action: "create_context"}',
    "with its short id. When you're done, give me the link to the new context.",
  ].join(" "),
  expertDoor: "I already have a manifest",
  wsErrorTitle: "Couldn't load your workspace",
  wsErrorBody: "Derive needs to know which workspace this context belongs to.",
  retryButton: "Try again",
  copyButton: "Copy",
  // The card's own headings. Here rather than inline in context-card.tsx for the reason the
  // rest of this file exists: a heading is copy a person reads, so it has to face the same
  // sweep — inline JSX text is exactly where the vocabulary this flow bans would slip back in.
  cardKnows: "What it knows",
  cardAnswers: "How it answers",
  cardWont: "What it won’t do",
  kindKnowledge: "Your team's agents can consult this as soon as it's created.",
  kindWorker:
    "This context can also take on work. Run it from your own agent session, or set up a dedicated runner later.",
  createdPrefix: "Ready. Open",
  degradedNotice:
    "This workspace doesn't have built-in chat turned on, so Derive can't interview you here. Your agent can still build it:",
  statusOnline: "Online. It can take on work now.",
  statusOffline:
    "Offline. New work will wait until the runner is back. You can still read what it knows.",
  statusNever: "No runner yet. Teammates' agents can still read what it knows.",
} as const
