import { type Context, Hono } from "hono"
import { AGENT_SKILL_MD } from "../agent-skill.gen"
import type { AppContext } from "../context"

/**
 * Agent discovery: the machine-readable front door for agents that have NOT
 * connected the MCP yet. A coding agent with nothing but a shell can fetch
 * these, learn what Derive is, and connect — no human walkthrough required.
 *
 *   GET /skill.md                 the Derive agent skill, self-contained (the
 *                                 canonical packages/cli/skills/derive SKILL.md
 *                                 with its reference files appended — generated
 *                                 by scripts/sync-derive-agent-skill.mjs, so it
 *                                 can never drift from the installed copies)
 *   GET /.well-known/agent.json   a capability manifest: what this instance is,
 *                                 how to authenticate, where the docs live
 *
 * Both are public, read-only, and instance-relative: origins come from the live
 * request (like the OAuth well-knowns) so they're correct on derive.to, a
 * self-host, and workers.dev without configuration. Served by the API — not as
 * static web assets — because agent.json needs the request origin, skill.md has
 * a generated single source of truth, and the Node tier's static middleware
 * doesn't reach into dot-directories. Also declared in lib/serve-web API_EXACT
 * (+ wrangler.toml run_worker_first + the Vite dev proxy) so the SPA's
 * not-found handling never shadows them.
 */
export const agentDiscoveryRoutes = (_ctx: AppContext) => {
  const app = new Hono()

  // Short shared cache: content only changes on deploy, but a stale copy
  // self-heals in minutes — and the skill itself tells agents to trust the live
  // server over any cached text.
  const CACHE = "public, max-age=300"

  app.get("/skill.md", (c) =>
    c.body(AGENT_SKILL_MD, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": CACHE,
    }),
  )

  // The Agent Skills Discovery convention (vercel-labs/skills-handler): an index
  // naming each skill this domain serves, plus the skill files under
  // /.well-known/skills/<name>/. Hermes and other skill-source crawlers consume
  // exactly this shape; here.now serves the same. One skill, one file — the served
  // copy is self-contained, so `files` is just the SKILL.md.
  const SKILL_DESCRIPTION = (() => {
    const m = AGENT_SKILL_MD.match(/^description: ([\s\S]*?)\n(?=\w+:|---)/m)
    return (m?.[1] ?? "Publish and revise artifacts on Derive.").replace(/\n\s+/g, " ").trim()
  })()
  app.get("/.well-known/skills/index.json", (c) =>
    c.json(
      { skills: [{ name: "derive", description: SKILL_DESCRIPTION, files: ["SKILL.md"] }] },
      200,
      { "Cache-Control": CACHE },
    ),
  )
  app.get("/.well-known/skills/derive/SKILL.md", (c) =>
    c.body(AGENT_SKILL_MD, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": CACHE,
    }),
  )

  app.get("/.well-known/agent.json", (c: Context) => {
    const base = new URL(c.req.url).origin
    return c.json(
      {
        schema_version: "1.0",
        name: "Derive",
        description:
          "A workspace for agent-made artifacts — documents, plans, decks, and fully-styled " +
          "pages with durable URLs, version history, comments, editing, and optional review.",
        url: base,
        capabilities: [
          "Publish Markdown, HTML pages, and multi-page bundles as versioned artifacts with permanent URLs",
          "Revise in place with surgical edits; every version stays addressable",
          "Stage large documents and binary assets (images, fonts) out of band via short-lived upload URLs",
          "Text-anchored comment threads that survive rewrites; reply, react, resolve",
          "Optional proposals and formal review rounds for work that needs a named decision",
          "Search and browse workspace libraries; tags and collections",
          "Ask live workspace contexts (agents) for answers or delegated work",
          "Save resumable checkpoints of working state",
        ],
        auth: {
          mcp: "OAuth at the MCP endpoint — connect and complete the browser flow; no pasted secrets",
          http: "Authorization: Bearer <token> on /v1 — a static agent token from Settings → Agents",
        },
        protocols: { mcp: true, openapi: true, a2a: false },
        endpoints: {
          mcp: `${base}/mcp`,
          openapi: `${base}/openapi.json`,
          docs: `${base}/docs`,
          guides: "https://docs.derive.to/",
          examples: `${base}/examples`,
          skill: `${base}/skill.md`,
          llms_txt: `${base}/llms.txt`,
          llms_full_txt: `${base}/llms-full.txt`,
        },
        source: "https://github.com/derive-to/derive",
        not_for:
          "Server-side code execution, general-purpose data storage, secrets, or app backends — " +
          "Derive hosts artifacts, not compute.",
      },
      200,
      { "Cache-Control": CACHE },
    )
  })

  return app
}
