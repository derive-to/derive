import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

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
const src = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8")

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

  // The bindings a Durable Object needs must be declared on its own env interface, even though
  // the runtime hands it the same script-wide set. Undeclared meant unused, which is the whole
  // bug: the capability was present and never reached for.
  it("declares the bindings the answerer needs", () => {
    const s = src("webhook-do.ts")
    for (const key of ["BUCKET?", "BASE_URL?", "DERIVE_MODEL_NAME?"]) expect(s).toContain(key)
  })
})
