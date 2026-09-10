#!/usr/bin/env node
// Guardrail: never call an INJECTED fetch as a method.
//
// `deps.fetch(url)` and `this.deps.fetch(url)` invoke the runtime's global with the
// holding object as `this`. Node's undici does not care. workerd rejects it:
//
//     TypeError: Illegal invocation: function called with incorrect `this` reference.
//
// So every request throws in a deployed Worker while every Node test passes, and the
// symptom is an honest-looking "the upstream did not answer" about an upstream that is
// answering fine. This has now shipped twice: once in the MCP broker, once in the arXiv
// paper import, where it cost a production deploy and a day of looking at the wrong
// system. The fix each time was `unbound` (packages/broker/src/http.ts): bind once, then
// call a plain function.
//
// Cloudflare BINDINGS are the deliberate exception — `env.ASSETS.fetch`, a Durable Object
// `stub.fetch`, a service `site.fetch` are real methods on real objects and must stay
// methods. They are recognised by their receiver, not by a comment.
//
// Escape hatch: a `fetch-invocation-ok` comment on the line.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOTS = ["apps/api/src", "packages"]
// Receivers that are genuine Cloudflare binding objects, not a stored global.
const BINDINGS = /^(env|this\.env|ctx\.env|stub|site|ready|worker|[A-Z_]+)$/

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full)
  }
  return out
}

const violations = []
for (const root of ROOTS) {
  for (const file of walk(join(process.cwd(), root))) {
    const src = readFileSync(file, "utf8")
    let inBlockComment = false
    src.split("\n").forEach((line, i) => {
      const trimmed = line.trim()
      // Prose explains this defect in several places; only code should trip the check.
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false
        return
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true
        return
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return
      if (line.includes("fetch-invocation-ok")) return
      const code = line.split("//")[0]
      // `<receiver>.fetch(` where the receiver is not a Cloudflare binding.
      for (const m of code.matchAll(/([\w.]+)\.fetch\s*\(/g)) {
        const receiver = m[1]
        if (BINDINGS.test(receiver)) continue
        if (/\.(ASSETS|KV|R2|DB|AI)$/.test(receiver)) continue
        violations.push(
          `${relative(process.cwd(), file)}:${i + 1}: \`${receiver}.fetch(...)\` — bind it with ` +
            "`unbound()` and call a plain function, or workerd throws Illegal invocation.",
        )
      }
    })
  }
}

if (violations.length > 0) {
  console.error("check-fetch-invocation: an injected fetch is being called as a method.\n")
  for (const v of violations) console.error(`  ${v}`)
  console.error("\n  See packages/broker/src/http.ts (`unbound`).")
  process.exit(1)
}
console.log(`check-fetch-invocation: ok`)
