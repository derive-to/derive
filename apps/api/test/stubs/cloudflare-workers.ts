// A stub for the `cloudflare:workers` built-in, which only resolves inside workerd.
//
// The Workers entry statically exports its Durable Object classes (wrangler requires that), and
// one of them — RunContainer — extends `Container` from @cloudflare/containers, which imports
// this module. Node-side unit tests import `src/worker.ts` to assert the fail-closed secret gate,
// so without this alias the whole worker module fails to load on an import that has nothing to do
// with what's under test. The real classes only ever run under workerd; these are inert bases so
// the module graph resolves.
export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class RpcTarget {}

export const env = {}
