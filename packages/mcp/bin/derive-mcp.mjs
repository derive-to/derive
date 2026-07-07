#!/usr/bin/env node
// `npx @derive-to/mcp`: start the Derive MCP stdio server. Derive ships TypeScript with no
// build step, so register tsx's loader and import the TS entry. The server talks
// to a Derive instance over HTTP (DERIVE_SERVER) with an optional bearer (DERIVE_TOKEN).
import { register } from "tsx/esm/api"

register()
await import(new URL("../src/index.ts", import.meta.url).href)
