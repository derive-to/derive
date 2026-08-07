// The copy a first-timer meets on their way to a context: the builder page itself (composer,
// empty state, the chat/agent/expert doors, the card the conversation produces) and the status
// lines the directory and console show them once it exists. Centralised because it carries a
// rule (builder-copy.test.ts): none of it may lean on the vocabulary a first-timer has no reason
// to know yet — "manifest", "short id", "runner token", "serve" — the words that describe HOW a
// context is built rather than what it does. That rule is enforced by grepping the values below,
// so a new key that slips a "manifest" past a lone reviewer still fails the suite.
export const BUILDER_COPY = {
  pageTitle: "New context",
  intro: "Tell Derive what this context should know or do — like briefing a new teammate.",
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
    "This one will also take on work itself. Answers come from whoever runs it — you can do that from your own agent session, or set up a dedicated helper later on the context's page.",
  createdPrefix: "Ready — open",
  degradedNotice:
    "This workspace doesn't have built-in chat turned on, so Derive can't interview you here. Your agent can still build it:",
  statusOnline: "Online — it can take on work right now.",
  statusOffline:
    "Offline — asking it to do work will wait until it's back. Reading what it knows always works.",
  statusNever: "Not serving yet — teammates' agents can still read what it knows.",
} as const
