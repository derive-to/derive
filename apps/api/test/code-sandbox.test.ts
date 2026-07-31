import { nodeSandbox } from "../src/lib/code-sandbox-node"
import { runSandboxContract } from "./sandbox-contract"

// The NODE sandbox, held to the shared contract. The Workers sandbox (a Cloudflare dynamic
// isolate) runs the SAME suite, so code written against one behaves identically on the other —
// otherwise `derive_code` would mean something different depending on where a workspace runs.
//
// Node's isolation mechanics are the more delicate of the two: `vm` is not a boundary by itself,
// so the worker thread (separate heap, empty env) is the real one and the in-context prelude
// closes the `constructor.constructor` escape. Workers disallows `eval` outright and so never had
// that hole. Those differences are invisible to the code being run, which is the point.
runSandboxContract("node sandbox", () => nodeSandbox())
