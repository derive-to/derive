import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Deferred Slack work must not reach for `c.executionCtx`.
//
// The Worker entry invokes Hono as `ready.fetch(req)` — ONE argument — and stashes the real
// ExecutionContext in an AsyncLocalStorage instead (worker.ts, `edgeCtx.run(ctx, …)`). Hono
// therefore never receives a ctx, and `c.executionCtx` throws on Workers, not merely on Node.
//
// That is not a theoretical mismatch. `runAfterAck` used to try it and swallow the throw into
// fire-and-forget, so every deferred Slack path — link previews, review send-backs, the
// interactivity repaint, the deferred /derive search — returned its response and was torn down at
// the promise's FIRST await. Silently: no log and no exception, because everything worth logging
// happens after that await. Link previews were dead in production for a day, with `link_shared`
// arriving correctly the whole time and every downstream log absent.
//
// Asserted against the source because there is no way to observe it from a test: under vitest
// there is no ExecutionContext at all, so both the broken and the fixed version behave the same.
// That is exactly why it survived a green suite.
const src = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8")

describe("Slack deferred work uses the context the worker actually provides", () => {
  // Comments about executionCtx are wanted — the explanation is the point. What must not exist
  // is a READ of it, so strip comments before asserting.
  const code = (p: string) =>
    src(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")

  it("routes/slack.ts never reads c.executionCtx", () => {
    expect(code("routes/slack.ts")).not.toMatch(/\bexecutionCtx\b/)
  })

  it("defers through ctx.background, which reads the worker's AsyncLocalStorage", () => {
    const body = code("routes/slack.ts").match(/const runAfterAck[\s\S]*?\n {2}\}/)?.[0] ?? ""
    expect(body).toContain("background(")
  })

  // The premise the above depends on. If the worker ever starts passing env+ctx to Hono,
  // c.executionCtx becomes valid and this comment (and the reasoning) needs revisiting — better
  // to be told than to leave a stale explanation in place.
  it("the worker still calls Hono without an ExecutionContext", () => {
    const w = src("worker.ts")
    expect(w).toContain("edgeCtx.run(ctx, () => ready.fetch(req))")
  })
})

// The two runtimes must wire the slack_ingest sender the same way.
//
// They did not. `makeSlackIngestSender` takes an optional `answerDeriveMention`, which is what
// answers an @Derive mention typed INSIDE a mirrored Slack thread. node.ts passed it; the
// Durable Object that drains the outbox on the hosted tier did not — so that answer worked on
// self-host and silently did nothing in production. Nothing failed, nothing logged: the comment
// was ingested and the mention simply went unanswered.
//
// Asserted against the source because there is no seam to observe it through. Both call sites
// construct their deps from their own runtime's bindings, and a test that stubbed those would be
// asserting the stub. What can be checked is that neither entry point drops the argument.
describe("both runtimes wire the Slack ingest sender the same", () => {
  it("the edge Durable Object passes a mention answerer", () => {
    const s = src("webhook-do.ts")
    expect(s).toMatch(/slack_ingest:\s*makeSlackIngestSender\([\s\S]{0,400}mentionAnswerer/)
  })

  it("the Node worker passes one too", () => {
    expect(src("node.ts")).toMatch(
      /slack_ingest:\s*makeSlackIngestSender\([\s\S]{0,400}answerDeriveMention/,
    )
  })

  // The answerer needs a model, a blob store and a base URL. A deploy missing any of them must
  // pass NOTHING rather than a half-built one — "nothing answers" is honest; a turn that throws
  // inside the outbox is a dead-lettered delivery.
  it("the edge degrades to undefined when the deploy has no model", () => {
    const s = src("webhook-do.ts")
    expect(s).toMatch(/if \(!models \|\| !env\.BUCKET \|\| !env\.BASE_URL\) return undefined/)
  })
})
