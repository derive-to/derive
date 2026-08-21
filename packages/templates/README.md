# @derive-to/templates

The portable built-in Templates catalog for [Derive](https://derive.to): each template's
prompt, sections, and starter renderer, shared by the remote server and the stdio MCP
package so both hand an agent the same starting point.

Standalone by design — no dependencies. The deck starter is generated in from the
canonical source in the main repository (`pnpm gen:deck-template`).

```ts
import { catalogResource, templateResource, renderTemplate } from "@derive-to/templates"
```

Part of the [derive-to/derive](https://github.com/derive-to/derive) monorepo; see the
repository for issues and contributions. Licensed FSL-1.1-ALv2 (converts to Apache-2.0
on the schedule in the repository's LICENSE).
