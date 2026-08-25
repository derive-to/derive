export const docsHome = {
  source: "apps/docs/content/index.mdx",
  slug: "index",
  title: "Keep, share, and improve agent-made work",
  description:
    "Publish agent-made artifacts to durable URLs, keep their history, and continue the work with people or agents.",
  stripHeading: false,
}

// Navigation membership and order live here. Astro derives the sidebar from the
// same sections that the content generator flattens into docsPages.
export const docsSections = [
  {
    label: "Start here",
    pages: [
      {
        source: "apps/docs/content/first-artifact.md",
        slug: "start/first-artifact",
        title: "Publish your first artifact",
        description: "Go from a local HTML or Markdown file to a durable artifact URL.",
        stripHeading: false,
      },
      {
        source: "apps/docs/content/review-loop.md",
        slug: "start/review-loop",
        title: "Collaborate on an artifact",
        description:
          "Share work, collect anchored feedback, revise it, and use formal review when needed.",
        stripHeading: false,
      },
      {
        source: "apps/docs/content/connect-agent.md",
        slug: "agents/connect",
        title: "Connect your coding agent",
        description: "Connect Claude Code, Codex, Cursor, or another MCP-compatible client.",
        stripHeading: false,
      },
    ],
  },
  {
    label: "Use Derive",
    pages: [
      {
        source: "packages/cli/README.md",
        slug: "agents/cli",
        title: "Derive CLI",
        description:
          "Publish, inspect feedback, revise artifacts, and manage Derive from a terminal.",
      },
      {
        source: "packages/mcp/README.md",
        slug: "agents/mcp",
        title: "Derive MCP server",
        description:
          "Give MCP-compatible agents Derive's find, publish, comment, and revision tools.",
      },
      {
        source: "apps/docs/content/access.md",
        slug: "concepts/access",
        title: "Access and sharing",
        description:
          "Understand workspace access, link roles, listing, passwords, and anonymous viewing.",
      },
      {
        source: "apps/docs/content/hosted-runs.md",
        slug: "concepts/hosted-runs",
        title: "Hosted runs",
        description: "How scheduled and interactive context runs execute safely.",
      },
    ],
  },
  {
    label: "Build artifacts",
    pages: [
      {
        source: "apps/docs/content/artifacts/authoring.md",
        slug: "artifacts/authoring",
        title: "Artifact authoring standard",
        description:
          "Author HTML, Markdown, bundles, and decks whose comments stay attached as they change.",
      },
      {
        source: "apps/docs/content/artifacts/shared-state.md",
        slug: "artifacts/shared-state",
        title: "Shared state for interactive artifacts",
        description:
          "Add persistent JSON collections, voting, and attributed interactions to an HTML artifact.",
        stripHeading: false,
      },
      {
        source: "examples/README.md",
        slug: "artifacts/examples",
        title: "Official artifact examples",
        description:
          "Publishable examples for a launch page, research brief, and living status report.",
      },
    ],
  },
  {
    label: "Self-host",
    pages: [
      {
        source: "apps/docs/content/self-hosting/quickstart.md",
        slug: "self-hosting/quickstart",
        title: "Self-hosting quickstart",
        description:
          "Run Derive in one container with secure bootstrap, readiness checks, and a backup.",
      },
      {
        source: "apps/docs/content/self-hosting/configuration.md",
        slug: "self-hosting/configuration",
        title: "Deployment and configuration",
        description: "Configure storage, databases, authentication, email, domains, and scaling.",
      },
      {
        source: "SECURITY.md",
        slug: "operations/security",
        title: "Security",
        description:
          "Supported versions, vulnerability reporting, hardening, and security invariants.",
      },
    ],
  },
  {
    label: "Reference",
    pages: [
      {
        source: "apps/docs/content/api.md",
        slug: "reference/api",
        title: "API and discovery endpoints",
        description: "OpenAPI, MCP, OAuth, agent discovery, and raw artifact endpoints.",
        stripHeading: false,
      },
      {
        source: "apps/docs/content/reference/architecture.md",
        slug: "reference/architecture",
        title: "Architecture",
        description: "Derive's ports-and-adapters structure and deployment topology.",
      },
      {
        source: "apps/docs/content/reference/licensing.md",
        slug: "reference/licensing",
        title: "Licensing",
        description: "Derive's Fair Source license and scheduled Apache-2.0 conversion.",
      },
    ],
  },
]

export const docsPages = [docsHome, ...docsSections.flatMap((section) => section.pages)]
