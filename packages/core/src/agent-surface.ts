/**
 * THE AGENT CODE SURFACE — what model-written code sees, wherever it runs.
 *
 * Derive executes model-written code in three different places, and they must look like one
 * product from inside the code:
 *
 *   1. CONTAINER — the CLI executor writes `derive-tools.mjs` into the run's working directory
 *      and the agent runs `node derive-tools.mjs -e '<code>'`.
 *   2. MCP — the `derive_code` tool runs code in a sandbox (a Node worker thread today, a
 *      Cloudflare dynamic isolate next), calling the same MCP tools the session already has.
 *   3. WORKER (next) — the in-Worker agent loop, when it gains a code tool.
 *
 * The transports differ completely: a shell process posting HTTP to the run's tool endpoint, a
 * worker thread posting messages to its host, an isolate whose only route out is `globalOutbound`.
 * NONE of that is visible to the code, and none of it may leak into the names.
 *
 * THE SURFACE, and it is short on purpose:
 *
 *   tools["<name>"](args)  → call one tool. Keys are exact tool names, which contain dots, so
 *                            index rather than destructure.
 *   call_tool(name, args)  → the same thing by dynamic name, for a name computed at runtime.
 *   console.log(...)       → captured and returned alongside the result, in order.
 *   return value           → the result. An object is JSON-stringified; a string is returned
 *                            as-is, because the common case is a summary line.
 *
 * WHY THIS FILE EXISTS. These names were `sources` and `call` on the container path and `tools`
 * and `call_tool` in the sandbox — one concept, two vocabularies, so an agent that learned one
 * had to relearn the other. Worse, the container wrote `derive-source.mjs` and
 * `derive-sources.mjs`, filenames one character apart. Naming drift is the cheapest kind of
 * instability to introduce and the most annoying to live with, so the canonical names live here
 * and every implementation is measured against them.
 *
 * The CLI cannot import this module at runtime (it is a dependency-free published package), so
 * it carries a hand-copy, exactly as it does for decideWrite and the run contract.
 * packages/cli/test/code-mode.test.js holds that copy to these names.
 */

/** The names bound in scope for model-written code. Changing one is a breaking change to every
 *  execution path at once, which is the point of listing them in a single place. */
export const AGENT_SURFACE = {
  /** Map of tool name → (args) => Promise<result>. */
  tools: "tools",
  /** Dynamic-name escape hatch: (name, args) => Promise<result>. */
  callTool: "call_tool",
  /** Captured, returned with the result, in order. */
  console: "console",
} as const

/** The file the container executor writes, and the command that runs it. Deliberately NOT one
 *  character from `derive-source.mjs`, the single-call CLI beside it. */
export const AGENT_TOOLS_MODULE = "derive-tools.mjs"
export const AGENT_TOOLS_EVAL = `node ${AGENT_TOOLS_MODULE} -e '<code>'`

/**
 * How to describe the surface to a model. One sentence per affordance, shared by the container's
 * run prompt and the `derive_code` tool description so the two cannot drift into describing
 * different products.
 */
export const AGENT_SURFACE_HELP =
  `\`tools["<name>"]({ ...args })\` calls a tool (names contain dots, so index rather than ` +
  `destructure); \`call_tool(name, args)\` does the same for a name computed at runtime; ` +
  `\`console.log\` is captured; whatever you \`return\` is the result. Loop, filter and join here ` +
  `and return only the answer — intermediate data should stay in the code rather than passing ` +
  `through your reply.`
