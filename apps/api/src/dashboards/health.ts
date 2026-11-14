import {
  againstBefore,
  artifactHref,
  ask,
  dashboard,
  measure,
  number,
  share,
  top,
  where,
} from "./parts"

const live = where("live", "artifact.archived", false)

/**
 * Whether the workspace is used, kept tidy and answered: who was active, the threads still
 * open, and the artifacts nobody has organized or touched in a while. Today's state (threads,
 * collections, quiet artifacts) ignores the range; activity follows it.
 */
export const HEALTH = dashboard(
  "health",
  "Workspace health",
  "Whether the workspace is used, kept tidy, and answered.",
  [
    {
      height: 2,
      tiles: [
        [
          "active",
          3,
          number(
            "Active people",
            ask("activity", {
              measures: [measure("m_p", "activity.people")],
              time: againstBefore("activity"),
            }),
          ),
        ],
        [
          "members",
          2,
          number("Members", ask("member", { measures: [measure("m_m", "member.count")] })),
        ],
        [
          "openThreads",
          2,
          number("Open threads", ask("thread", { measures: [measure("m_o", "thread.open")] })),
        ],
        [
          "loose",
          3,
          number(
            "Not in a collection",
            ask("artifact", {
              measures: [
                {
                  ...measure("m_part", "artifact.count"),
                  filter: where("out", "artifact.inCollection", false),
                },
                measure("m_whole", "artifact.count"),
              ],
              filters: live,
              ...share("Not in a collection"),
            }),
          ),
        ],
        [
          "quiet",
          2,
          number(
            "Gone quiet",
            ask("artifact", {
              measures: [measure("m_q", "artifact.count")],
              filters: { id: "f", all: [live, where("isQuiet", "artifact.quiet", true)] },
            }),
          ),
        ],
      ],
    },
    {
      height: 4,
      tiles: [
        [
          "perWeek",
          8,
          {
            kind: "line",
            title: "Active people per week",
            queries: {
              main: ask("activity", {
                measures: [measure("m_p", "activity.people")],
                time: {
                  dimension: "activity.createdAt",
                  range: { last: 12, unit: "week", includeCurrent: true },
                  grain: "week",
                },
                fill: "zero",
              }),
            },
            display: { keepDateRange: true },
          },
        ],
        [
          "byKind",
          4,
          {
            kind: "bar",
            title: "New artifacts by kind",
            queries: {
              main: ask("artifact", {
                measures: [measure("m_n", "artifact.count")],
                dimensions: [{ id: "k", member: "artifact.kind" }],
                time: {
                  dimension: "artifact.createdAt",
                  range: { last: 30, unit: "day", includeCurrent: true },
                },
                ...top("m_n", 6),
              }),
            },
          },
        ],
      ],
    },
    {
      height: 5,
      tiles: [
        [
          "threads",
          6,
          {
            kind: "list",
            title: "Oldest open threads",
            queries: {
              main: ask("thread", {
                measures: [measure("m_d", "thread.age")],
                dimensions: [
                  { id: "e", member: "thread.excerpt" },
                  { id: "t", member: "thread.artifact.title" },
                  { id: "s", member: "thread.artifact.shortId" },
                  { id: "b", member: "thread.author" },
                ],
                filters: where("o", "thread.state", "open"),
                ...top("m_d", 6),
              }),
            },
            display: {
              title: "e",
              subtitle: ["t", "b"],
              avatar: "b",
              meta: "m_d",
              href: artifactHref("s"),
              empty: "Every thread is answered.",
            },
          },
        ],
        [
          "quietList",
          6,
          {
            kind: "list",
            title: "Gone quiet",
            queries: {
              main: ask("artifact", {
                measures: [measure("m_d", "artifact.idle")],
                dimensions: [
                  { id: "t", member: "artifact.title" },
                  { id: "k", member: "artifact.kind" },
                  { id: "s", member: "artifact.shortId" },
                ],
                filters: { id: "f", all: [live, where("isQuiet", "artifact.quiet", true)] },
                ...top("m_d", 6),
              }),
            },
            display: {
              title: "t",
              subtitle: ["k"],
              meta: "m_d",
              href: artifactHref("s"),
              empty: "Nothing has gone quiet.",
            },
          },
        ],
      ],
    },
  ],
)
