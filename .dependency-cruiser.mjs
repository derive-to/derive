// dependency-cruiser: turn Derive's hexagonal dependency rule into a CI gate.
//
// The rule (ARCHITECTURE.md): `core` owns the ports and imports NOTHING in-repo;
// `db`/`storage` provide adapters and depend only on `core`; `apps/api` wires them;
// the clients (`web`/`cli`/`mcp`/`runner`) talk HTTP and never import `core` at
// runtime. These forbidden rules make a violation fail `pnpm run ci` instead of
// relying on discipline. Run standalone: `pnpm lint:boundaries`.

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "No import cycles — even a type-only cycle is a comprehension cost.",
      from: {},
      to: { circular: true },
    },
    {
      name: "core-is-a-leaf",
      severity: "error",
      comment: "@derive/core is the domain kernel: it must import no other in-repo package.",
      from: { path: "^packages/core/src" },
      to: {
        path: "^(packages/(db|storage|mcp|cli|runner)|apps)/",
        pathNot: "^packages/core/",
      },
    },
    {
      name: "adapters-import-core-only",
      severity: "error",
      comment: "db/storage adapters depend on core only — never each other, the app, or clients.",
      from: { path: "^packages/(db|storage)/src" },
      to: { path: "^(packages/(mcp|cli|runner)|apps)/" },
    },
    {
      name: "templates-is-a-leaf",
      severity: "error",
      comment:
        "@derive-to/templates is portable starter data and rendering only: no app, adapter, or client runtime imports.",
      from: { path: "^packages/templates/src" },
      to: { path: "^(packages|apps)/", pathNot: "^packages/templates/" },
    },
    {
      name: "clients-no-core-at-runtime",
      severity: "error",
      comment:
        "web/cli/mcp/runner are HTTP clients — no runtime import of @derive/core (type-only is fine).",
      from: { path: "^(apps/web|packages/(cli|mcp|runner))/src" },
      to: { path: "^packages/core/src", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "local-embedder-node-only",
      severity: "error",
      comment:
        "embedder-local pulls onnxruntime-node (a native module) — ONLY node.ts may import it, so it never reaches the Worker bundle. Load it lazily (dynamic import) from the Node entry.",
      from: { path: "^apps/api/src", pathNot: "^apps/api/src/node\\.ts$" },
      to: { path: "^apps/api/src/embedder-local\\.ts$" },
    },
  ],
  options: {
    // A resolution-only tsconfig with @derive/* path aliases (see the file) so a forbidden
    // cross-package import RESOLVES and the rules below fire — pnpm won't symlink a package
    // where it isn't a declared dep, so without this such an import is unresolvable and
    // dependency-cruiser silently drops it (a `not-to-unresolvable` rule can't help — there's
    // no recorded edge to match). Add a new workspace package's alias there too. If one is
    // missed, typecheck is the guaranteed backstop: a forbidden import to an unmapped package
    // is a hard "cannot find module" error, so it can never silently escape enforcement.
    tsConfig: { fileName: ".dependency-cruiser.tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    // Source only: skip build output, generated route tree, and .d.ts — their
    // cycles are bundler/codegen artifacts, not something a contributor can fix.
    exclude: { path: "(^|/)(dist|build|coverage|node_modules)/|\\.gen\\.(ts|tsx)$|\\.d\\.ts$" },
    includeOnly: "^(packages|apps)/[^/]+/src/",
  },
}
