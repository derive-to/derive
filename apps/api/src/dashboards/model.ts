import { DERIVE_AGENT_ID } from "@derive/core"
import { defineModel } from "derive-dashboards/core"

/** Every source below that hangs off an artifact reaches its workspace and its rule through it. */
const throughArtifact = {
  tenant: { via: "artifact" },
  policy: { via: "artifact" },
  joins: {
    artifact: { to: "artifact", on: [["artifact_id", "id"]], relationship: "many_to_one" },
  },
} as const

/** Whole days, counted in SQL. */
const WHOLE = { scale: 0, stored: "decimal" } as const

/** A text field whose column values read as labels: a SQL CASE, the rest `otherwise`. */
const labelled = (
  column: string,
  cases: readonly (readonly [values: readonly string[], label: string])[],
  otherwise: string,
  label: string,
) =>
  ({
    kind: "expr",
    type: "string",
    label,
    expr: {
      case: cases.map(([values, lit]) => ({
        when: { left: { col: column }, op: "in", values },
        // biome-ignore lint/suspicious/noThenProperty: a CASE branch in derive-dashboards' model expression, not a thenable.
        then: { lit },
      })),
      else: { lit: otherwise },
    },
  }) as const

const published = (label: string) =>
  ({ kind: "time", column: "created_at", storage: "text_parseable", label }) as const
const text = (column: string, label: string) =>
  ({ kind: "string", column, collation: "binary", label }) as const

/**
 * What the workspace's dashboards can count: artifacts, the versions published to them, who
 * read them, what agents ran, the comment threads on them, and the workspace's members.
 *
 * A workspace is the tenant. VISIBILITY is never re-expressed here: the viewer carries the ids
 * of the artifacts this person may read (lib/visibility.ts, the one gate for surfaces that
 * reach artifacts other than by id), and the artifact source admits only those. Versions,
 * views, threads and activity reach their tenant and that rule through their artifact, so a
 * private artifact counts in nobody else's numbers. Agent runs follow the runs page's own rule:
 * every member sees an agent's runs, except the built-in Derive agent's, which only the person
 * who asked sees. Reader names are sensitive: only a seat that may publish sees who read what.
 */
export const dashboardsModel = defineModel({
  version: 1,
  tenant: { keys: ["org"] },
  policies: {
    visible: { rules: [{ allow: { column: "id", op: "in", viewer: "attributes.artifacts" } }] },
  },
  sources: {
    artifact: {
      in: "main",
      sql: `
        SELECT a.id, a.short_id, a.org_id, a.title, a.kind, a.created_at,
          a.archived_at IS NOT NULL AS archived,
          a.first_foreign_view_at IS NULL AS unread,
          EXISTS (SELECT 1 FROM collection_item ci WHERE ci.artifact_id = a.id) AS in_collection,
          lv.at AS last_version_at,
          coalesce(lv.at::timestamptz < now() - interval '90 days', false) AS quiet,
          floor(extract(epoch FROM now() - coalesce(lv.at, a.created_at)::timestamptz) / 86400) AS idle_days
        FROM artifact a
        LEFT JOIN LATERAL (SELECT max(v.created_at) AS at FROM version v WHERE v.artifact_id = a.id) lv ON true
        WHERE a.removed_at IS NULL`,
      key: ["id", "short_id"],
      time: "createdAt",
      tenant: { columns: { org: "org_id" } },
      policy: "visible",
      noun: { one: "artifact", other: "artifacts" },
      measures: {
        count: { kind: "count", merge: "sum", label: "Artifacts" },
        idle: {
          kind: "max",
          of: "idle_days",
          numeric: WHOLE,
          merge: "max",
          label: "Days since a version",
        },
      },
      dimensions: {
        title: { kind: "string", column: "title", collation: "ci", label: "Title" },
        shortId: { ...text("short_id", "Link"), drill: false },
        kind: text("kind", "Kind"),
        archived: { kind: "boolean", column: "archived", label: "Archived", drill: false },
        unread: {
          kind: "boolean",
          column: "unread",
          label: "Not read by anyone else",
          drill: false,
        },
        inCollection: {
          kind: "boolean",
          column: "in_collection",
          label: "In a collection",
          drill: false,
        },
        quiet: { kind: "boolean", column: "quiet", label: "No version in 90 days", drill: false },
        createdAt: published("Created"),
        lastVersionAt: {
          kind: "time",
          column: "last_version_at",
          storage: "text_parseable",
          label: "Last version",
        },
      },
      records: { order: [["createdAt", "desc"]], columns: ["title", "kind", "createdAt"] },
    },
    version: {
      in: "main",
      sql: `
        SELECT v.*, a.short_id AS artifact_short_id
        FROM version v JOIN artifact a ON a.id = v.artifact_id`,
      key: ["id", "artifact_short_id"],
      time: "createdAt",
      ...throughArtifact,
      noun: { one: "version", other: "versions" },
      measures: {
        count: { kind: "count", merge: "sum", label: "Versions" },
        publishers: {
          kind: "count",
          distinct: "author_id",
          merge: "none",
          label: "People publishing",
        },
      },
      dimensions: {
        author: text("author", "Person"),
        number: { kind: "number", column: "n", label: "Version number" },
        source: labelled(
          "source",
          [
            [["mcp"], "MCP"],
            [["web"], "Web editor"],
            [["api"], "API"],
            [["sync"], "Sync"],
          ],
          "Other",
          "Source",
        ),
        agent: text("agent_name", "Agent"),
        madeBy: {
          kind: "expr",
          type: "string",
          label: "Made by",
          expr: {
            case: [
              {
                when: { left: { col: "agent_id" }, op: "set", values: [] },
                // biome-ignore lint/suspicious/noThenProperty: a CASE branch in derive-dashboards' model expression, not a thenable.
                then: { lit: "Agents" },
              },
            ],
            else: { lit: "People" },
          },
        },
        createdAt: published("Published"),
      },
      records: {
        order: [["createdAt", "desc"]],
        columns: ["author", "madeBy", "source", "createdAt"],
      },
    },
    view: {
      table: "view",
      in: "main",
      key: ["id"],
      time: "createdAt",
      ...throughArtifact,
      noun: { one: "view", other: "views" },
      measures: { count: { kind: "count", merge: "sum", label: "Views" } },
      dimensions: {
        from: labelled("viewer_kind", [[["user"], "Members"]], "Shared links", "From"),
        createdAt: published("Viewed"),
      },
    },
    // One row per artifact and reader: when they first opened it, how often, and whether they
    // stayed long enough to read it (Derive's confirmed read).
    visit: {
      in: "main",
      sql: `
        SELECT v.artifact_id || ':' || v.viewer AS id, v.artifact_id, v.viewer, v.viewer_kind,
          min(v.created_at) AS created_at, count(*) AS views,
          bool_or(r.viewer IS NOT NULL) AS read_through,
          max(coalesce(u.name, 'Visitor')) AS reader, max(a.short_id) AS artifact_short_id
        FROM view v
        JOIN artifact a ON a.id = v.artifact_id
        LEFT JOIN view_read r ON r.artifact_id = v.artifact_id AND r.viewer = v.viewer
        LEFT JOIN "user" u ON v.viewer_kind = 'user' AND u.id = v.viewer
        GROUP BY v.artifact_id, v.viewer, v.viewer_kind`,
      key: ["id", "artifact_short_id"],
      time: "createdAt",
      ...throughArtifact,
      noun: { one: "reader", other: "readers" },
      measures: {
        readers: { kind: "count", merge: "sum", label: "Readers" },
        read: {
          kind: "count",
          where: { member: "visit.readThrough", op: "equals", values: [true] },
          merge: "sum",
          label: "Read through",
        },
        readRate: {
          kind: "ratio",
          numerator: "read",
          denominator: "readers",
          merge: "none",
          label: "Read through",
        },
      },
      dimensions: {
        reader: { ...text("reader", "Reader"), sensitive: true },
        readThrough: { kind: "boolean", column: "read_through", label: "Read through" },
        createdAt: published("First opened"),
      },
    },
    job: {
      in: "main",
      sql: `
        SELECT j.id, j.org_id, j.agent_id, j.asked_by, j.kind, j.status, j.created_at,
          coalesce(a.name, j.agent_id) AS agent,
          coalesce(u.name, 'Scheduled') AS asked_by_name,
          CASE WHEN j.finished_at IS NOT NULL AND j.started_at IS NOT NULL
            THEN extract(epoch FROM j.finished_at::timestamptz - j.started_at::timestamptz)
          END AS seconds
        FROM job j
        LEFT JOIN agent a ON a.id = j.agent_id
        LEFT JOIN "user" u ON u.id = j.asked_by
        WHERE j.parent_id IS NULL`,
      key: ["id"],
      time: "createdAt",
      tenant: { columns: { org: "org_id" } },
      policy: {
        rules: [
          {
            allow: {
              any: [
                { column: "agent_id", op: "notEquals", values: [DERIVE_AGENT_ID] },
                { column: "asked_by", op: "equals", viewer: "id" },
              ],
            },
          },
        ],
      },
      noun: { one: "run", other: "runs" },
      measures: {
        count: { kind: "count", merge: "sum", label: "Agent runs" },
        finished: {
          kind: "count",
          where: {
            member: "job.status",
            op: "in",
            values: ["Succeeded", "Failed", "Cancelled"],
          },
          merge: "sum",
          label: "Finished",
        },
        succeeded: {
          kind: "count",
          where: { member: "job.status", op: "equals", values: ["Succeeded"] },
          merge: "sum",
          label: "Succeeded",
        },
        successRate: {
          kind: "ratio",
          numerator: "succeeded",
          denominator: "finished",
          merge: "none",
          label: "Succeeded",
        },
        waiting: {
          kind: "count",
          where: { member: "job.status", op: "equals", values: ["Waiting on someone"] },
          merge: "sum",
          label: "Waiting on someone",
        },
        typical: {
          kind: "percentile",
          of: "seconds",
          p: 50,
          merge: "none",
          label: "Typical run (seconds)",
        },
      },
      dimensions: {
        agent: text("agent", "Agent"),
        status: labelled(
          "status",
          [
            [["succeeded"], "Succeeded"],
            [["needs_you"], "Waiting on someone"],
            [["failed", "lost"], "Failed"],
            [["cancelled"], "Cancelled"],
          ],
          "Running",
          "Status",
        ),
        askedBy: text("asked_by_name", "Asked by"),
        id: { ...text("id", "Run"), drill: false },
        createdAt: published("Started"),
      },
      records: {
        order: [["createdAt", "desc"]],
        columns: ["agent", "status", "askedBy", "createdAt"],
      },
    },
    // A thread is its first comment; its state is the thread's.
    thread: {
      in: "main",
      sql: `
        SELECT DISTINCT ON (c.thread_id) c.thread_id AS id, c.artifact_id, c.author, c.state,
          (SELECT a.short_id FROM artifact a WHERE a.id = c.artifact_id) AS artifact_short_id,
          c.created_at, left(regexp_replace(c.body_md, '\\s+', ' ', 'g'), 140) AS excerpt,
          floor(extract(epoch FROM now() - c.created_at::timestamptz) / 86400) AS age_days
        FROM comment c
        ORDER BY c.thread_id, c.created_at`,
      key: ["id", "artifact_short_id"],
      time: "createdAt",
      ...throughArtifact,
      noun: { one: "thread", other: "threads" },
      measures: {
        count: { kind: "count", merge: "sum", label: "Threads" },
        open: {
          kind: "count",
          where: { member: "thread.state", op: "equals", values: ["open"] },
          merge: "sum",
          label: "Open threads",
        },
        age: { kind: "max", of: "age_days", numeric: WHOLE, merge: "max", label: "Days open" },
      },
      dimensions: {
        state: text("state", "State"),
        author: text("author", "Started by"),
        excerpt: { ...text("excerpt", "Thread"), drill: false },
        createdAt: published("Started"),
      },
    },
    // Everything a person did on an artifact: published a version, commented, or opened it.
    activity: {
      in: "main",
      sql: `
        SELECT x.id, x.artifact_id, x.person_id, x.act, x.created_at, coalesce(u.name, 'Someone') AS person,
          a.short_id AS artifact_short_id
        FROM (
          SELECT 'v:' || id AS id, artifact_id, author_id AS person_id, 'Published' AS act, created_at
            FROM version WHERE author_id IS NOT NULL AND agent_id IS NULL
          UNION ALL
          SELECT 'c:' || id, artifact_id, author_id, 'Commented', created_at
            FROM comment WHERE author_id IS NOT NULL
          UNION ALL
          SELECT 'r:' || id, artifact_id, viewer, 'Read', created_at
            FROM view WHERE viewer_kind = 'user'
        ) x
        JOIN artifact a ON a.id = x.artifact_id
        LEFT JOIN "user" u ON u.id = x.person_id`,
      key: ["id", "artifact_short_id"],
      time: "createdAt",
      ...throughArtifact,
      measures: {
        people: { kind: "count", distinct: "person_id", merge: "none", label: "Active people" },
        count: { kind: "count", merge: "sum", label: "Actions" },
      },
      dimensions: {
        person: text("person", "Person"),
        act: text("act", "Did"),
        createdAt: published("When"),
      },
    },
    member: {
      table: "membership",
      in: "main",
      key: ["id"],
      time: "createdAt",
      tenant: { columns: { org: "org_id" } },
      policy: { rules: [{ allow: "all" }] },
      noun: { one: "member", other: "members" },
      measures: { count: { kind: "count", merge: "sum", label: "Members" } },
      dimensions: {
        role: text("role", "Seat"),
        createdAt: published("Joined"),
      },
    },
  },
})
