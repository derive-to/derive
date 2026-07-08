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
      name: "clients-no-core-at-runtime",
      severity: "error",
      comment:
        "web/cli/mcp/runner are HTTP clients — no runtime import of @derive/core (type-only is fine).",
      from: { path: "^(apps/web|packages/(cli|mcp|runner))/src" },
      to: { path: "^packages/core/src", dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    // A resolution-only tsconfig with @derive/* path aliases (see the file) — so a
    // forbidden cross-package import resolves and the rules below can actually fire,
    // even though pnpm wouldn't symlink the package where it isn't a declared dep.
    tsConfig: { fileName: ".dependency-cruiser.tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    // Source only: skip build output, generated route tree, and .d.ts — their
    // cycles are bundler/codegen artifacts, not something a contributor can fix.
    exclude: { path: "(^|/)(dist|build|coverage|node_modules)/|\\.gen\\.(ts|tsx)$|\\.d\\.ts$" },
    includeOnly: "^(packages|apps)/[^/]+/src/",
  },
}
