import {
  againstBefore,
  artifactHref,
  ask,
  dashboard,
  measure,
  number,
  over,
  top,
  where,
} from "./parts"

/**
 * Who reads what the workspace publishes, and what nobody else has opened. Views are every
 * open; a reader is one person on one artifact; read through means they stayed to read it.
 */
export const READING = dashboard(
  "reading",
  "Reading",
  "See what people open and read. Each reader counts once per artifact.",
  [
    {
      height: 2,
      tiles: [
        [
          "views",
          3,
          number(
            "Views",
            ask("view", { measures: [measure("m_n", "view.count")], time: againstBefore("view") }),
          ),
        ],
        [
          "readers",
          3,
          number(
            "Readers",
            ask("visit", {
              measures: [measure("m_r", "visit.readers")],
              time: againstBefore("visit"),
            }),
          ),
        ],
        [
          "readThrough",
          3,
          number(
            "Read through",
            ask("visit", {
              measures: [measure("m_share", "visit.readRate")],
              time: over("visit"),
            }),
          ),
        ],
        [
          "unread",
          3,
          number(
            "New, not read yet",
            ask("artifact", {
              measures: [measure("m_n", "artifact.count")],
              filters: {
                id: "f",
                all: [where("u", "artifact.unread", true), where("a", "artifact.archived", false)],
              },
              time: over("artifact"),
            }),
          ),
        ],
      ],
    },
    {
      height: 4,
      tiles: [
        [
          "perDay",
          8,
          {
            kind: "line",
            title: "Views per day",
            queries: {
              main: ask("view", {
                measures: [measure("m_n", "view.count")],
                dimensions: [{ id: "from", member: "view.from" }],
                time: { ...over("view"), grain: "day" },
                fill: "zero",
              }),
            },
          },
        ],
        [
          "from",
          4,
          {
            kind: "bar",
            title: "Where views come from",
            queries: {
              main: ask("view", {
                measures: [measure("m_n", "view.count")],
                dimensions: [{ id: "from", member: "view.from" }],
                time: over("view"),
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
          "mostRead",
          6,
          {
            kind: "list",
            title: "Most read",
            queries: {
              main: ask("visit", {
                measures: [measure("m_r", "visit.readers")],
                dimensions: [
                  { id: "t", member: "visit.artifact.title" },
                  { id: "k", member: "visit.artifact.kind" },
                  { id: "s", member: "visit.artifact.shortId" },
                ],
                time: over("visit"),
                ...top("m_r", 6),
              }),
            },
            display: {
              title: "t",
              subtitle: ["k"],
              meta: "m_r",
              href: artifactHref("s"),
              empty: "Nothing was opened in this range.",
            },
          },
        ],
        [
          "notRead",
          6,
          {
            kind: "list",
            title: "Published, not read yet",
            queries: {
              main: ask("artifact", {
                measures: [measure("m_d", "artifact.idle")],
                dimensions: [
                  { id: "t", member: "artifact.title" },
                  { id: "k", member: "artifact.kind" },
                  { id: "s", member: "artifact.shortId" },
                ],
                filters: {
                  id: "f",
                  all: [
                    where("u", "artifact.unread", true),
                    where("a", "artifact.archived", false),
                  ],
                },
                time: over("artifact"),
                ...top("m_d", 6),
              }),
            },
            display: {
              title: "t",
              subtitle: ["k"],
              meta: "m_d",
              href: artifactHref("s"),
              empty: "Everything published in this range has a reader.",
            },
          },
        ],
      ],
    },
  ],
)
