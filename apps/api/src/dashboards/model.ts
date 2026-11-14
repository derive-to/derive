import { defineModel } from "derive-dashboards/core"

/**
 * What the workspace's dashboards can count: artifacts, and the versions published to them.
 *
 * A workspace is the tenant. VISIBILITY is never re-expressed here: the viewer carries the ids
 * of the artifacts this person may read (lib/visibility.ts, the one gate for surfaces that
 * reach artifacts other than by id), and the artifact source admits only those. A version reaches its tenant and
 * its rule through its artifact, so a private artifact's versions never count in anyone
 * else's numbers.
 */
export const dashboardsModel = defineModel({
  version: 1,
  tenant: { keys: ["org"] },
  policies: {
    visible: { rules: [{ allow: { column: "id", op: "in", viewer: "attributes.artifacts" } }] },
  },
  sources: {
    artifact: {
      table: "artifact",
      in: "main",
      key: ["id"],
      time: "createdAt",
      label: "Artifacts",
      tenant: { columns: { org: "org_id" } },
      policy: "visible",
      measures: { count: { kind: "count", merge: "sum", label: "Artifacts" } },
      dimensions: {
        title: { kind: "string", column: "title", collation: "ci", label: "Title" },
        kind: { kind: "string", column: "kind", collation: "binary", label: "Kind" },
        createdAt: {
          kind: "time",
          column: "created_at",
          storage: "text_parseable",
          label: "Created",
        },
      },
    },
    version: {
      table: "version",
      in: "main",
      key: ["id"],
      time: "createdAt",
      label: "Versions",
      tenant: { via: "artifact" },
      policy: { via: "artifact" },
      joins: {
        artifact: { to: "artifact", on: [["artifact_id", "id"]], relationship: "many_to_one" },
      },
      measures: {
        count: { kind: "count", merge: "sum", label: "Versions" },
        publishers: {
          kind: "count",
          distinct: "author",
          merge: "none",
          label: "People publishing",
        },
      },
      dimensions: {
        author: { kind: "string", column: "author", collation: "binary", label: "Person" },
        number: { kind: "number", column: "n", label: "Version number" },
        source: { kind: "string", column: "source", collation: "binary", label: "Source" },
        agent: { kind: "string", column: "agent_name", collation: "binary", label: "Agent" },
        madeBy: {
          kind: "expr",
          type: "string",
          label: "Made by",
          expr: {
            case: [
              {
                when: { left: { col: "agent_id" }, op: "set", values: [] },
                // biome-ignore lint/suspicious/noThenProperty: a CASE branch in derive-dashboards' model expression, not a thenable.
                then: { lit: "Agent" },
              },
            ],
            else: { lit: "Person" },
          },
        },
        createdAt: {
          kind: "time",
          column: "created_at",
          storage: "text_parseable",
          label: "Published",
        },
      },
      records: {
        order: [["createdAt", "desc"]],
        columns: ["author", "madeBy", "source", "createdAt"],
      },
    },
  },
})
