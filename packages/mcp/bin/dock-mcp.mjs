#!/usr/bin/env node
// `npx @dock/mcp`: start the Dock MCP stdio server. Dock ships TypeScript with no
// build step, so register tsx's loader and import the TS entry. The server talks
// to a Dock instance over HTTP (DOCK_SERVER) with an optional bearer (DOCK_TOKEN).
import { register } from "tsx/esm/api"

register()
await import(new URL("../src/index.ts", import.meta.url).href)
