// Ambient declaration for the Cloudflare Workers virtual `cloudflare:email` module so
// the EmailMessage value-import in email-cf.ts resolves under BOTH tsconfigs (the Node
// project and the Workers project). The real module is provided by the Workers runtime;
// the Node build never executes that code path (the CF sender is only constructed on the
// edge), this just lets type-checking see it.
declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string)
    readonly from: string
    readonly to: string
    readonly raw: ReadableStream | string
  }
}
