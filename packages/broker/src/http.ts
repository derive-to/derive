/**
 * Call a fetch implementation as a PLAIN FUNCTION, never as a method.
 *
 * `private readonly fetchImpl: typeof fetch = fetch` stores the runtime's global fetch on the
 * instance, and `this.fetchImpl(url, …)` then invokes it with the broker as its `this`. Node's
 * undici does not care. workerd rejects it outright:
 *
 *     TypeError: Illegal invocation: function called with incorrect `this` reference.
 *
 * So every brokered HTTP call throws the moment it runs in a deployed Worker, while every test
 * in Node passes — and because `connect` reports an unreachable server as `pending`, the symptom
 * is the honest-looking "that MCP server did not answer" about a server that is answering fine.
 *
 * Bind once at construction and no call site can get it wrong again.
 */
export const unbound =
  (f: typeof fetch = fetch): typeof fetch =>
  (input, init) =>
    f(input, init)
