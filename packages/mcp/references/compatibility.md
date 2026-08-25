# Remote and stdio compatibility

Prefer the remote Streamable HTTP MCP. It is the authoritative Derive agent surface.

| Job | Remote MCP | Stdio compatibility MCP |
|---|---|---|
| Find workspace artifacts | `find` | `list_artifacts` + `search` |
| Read content and versions | `read` | `read` |
| Catch up on review | `catch_up` | `catch_up` |
| Comment, reply, react, resolve | `comment` | `comment` |
| Publish a file or exact edits | `publish` | `publish` |
| Upload large docs or assets | `stage` | Not available |
| Tags, collections and archiving | `organize` | `organize` |
| Cross-workspace selection | `list_workspaces` + `workspace` | `list_workspaces` + per-tool `workspace` |
| Live workspace contexts | `find` + `use` | Not available |
| Resumable agent state | `checkpoint` | Not available |
| Graph/loop Context procedure | Root `use` envelope + `derive://skills/workflows` | `derive://guide/workflows` (guidance only) |
| Execute graph/loop Contexts | `use({context,instruction})`, then child `use` calls | Not available |

On stdio, read `derive://guide` before the first write. If the client cannot read MCP
resources, call `read` with `derive://guide` as the `short_id`.

Do not call a remote-only tool by guessing its name when only stdio is connected.
Explain the limitation and offer the remote OAuth setup when the requested job needs it.
For graph/loop execution, use the exact handoff in `derive://guide/workflows`: stdio can read and
publish the typed manifest, but it must not pretend to run Context nodes.
