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

const versions = measure("m_n", "version.count")

/**
 * What the workspace published, by whom, and how. Every tile reads versions, so a click on any
 * of them drills the same rows; a new artifact is its first version.
 */
export const PUBLISHING = dashboard(
  "publishing",
  "Publishing",
  "What the workspace published, by whom, and how.",
  [
    {
      height: 2,
      tiles: [
        [
          "versions",
          3,
          number(
            "Versions published",
            ask("version", { measures: [versions], time: againstBefore("version") }),
          ),
        ],
        [
          "newArtifacts",
          3,
          number(
            "New artifacts",
            ask("version", {
              measures: [{ ...versions, filter: where("first", "version.number", 1) }],
              time: againstBefore("version"),
            }),
          ),
        ],
        [
          "publishers",
          3,
          number(
            "People publishing",
            ask("version", {
              measures: [measure("m_p", "version.publishers")],
              time: againstBefore("version"),
            }),
          ),
        ],
        [
          "byAgents",
          3,
          number(
            "Published by agents",
            ask("version", {
              measures: [measure("m_share", "version.agentShare")],
              time: over("version"),
            }),
          ),
        ],
      ],
    },
    {
      height: 3,
      tiles: [
        [
          "perDay",
          12,
          {
            kind: "bar",
            title: "Versions per day",
            queries: {
              main: ask("version", {
                measures: [versions],
                dimensions: [{ id: "who", member: "version.madeBy" }],
                time: { ...againstBefore("version"), grain: "day" },
                fill: "zero",
              }),
            },
            display: {
              colors: {
                People: "var(--dd-publisher-people)",
                Agents: "var(--dd-publisher-agents)",
              },
            },
          },
        ],
      ],
    },
    {
      height: 4,
      tiles: [
        [
          "bySource",
          5,
          {
            kind: "bar",
            title: "By source",
            queries: {
              main: ask("version", {
                measures: [versions],
                dimensions: [{ id: "s", member: "version.source" }],
                time: over("version"),
                ...top("m_n", 5),
              }),
            },
          },
        ],
        [
          "mostRevised",
          7,
          {
            kind: "list",
            title: "Most revised",
            queries: {
              main: ask("version", {
                measures: [versions],
                dimensions: [
                  { id: "t", member: "version.artifact.title" },
                  { id: "k", member: "version.artifact.kind" },
                  { id: "s", member: "version.artifact.shortId" },
                ],
                time: over("version"),
                ...top("m_n", 6),
              }),
            },
            display: {
              title: "t",
              subtitle: ["k"],
              meta: "m_n",
              href: artifactHref("s"),
              empty: "Nothing published in this range.",
            },
          },
        ],
      ],
    },
    {
      height: 4,
      tiles: [
        [
          "byPerson",
          12,
          {
            kind: "bar",
            title: "Top publishers",
            queries: {
              main: ask("version", {
                measures: [versions],
                dimensions: [{ id: "who", member: "version.author" }],
                time: over("version"),
                ...top("m_n", 6),
                other: true,
              }),
            },
          },
        ],
      ],
    },
  ],
  [
    {
      id: "publisher",
      label: "Publisher type",
      kind: "filter",
      member: "version.madeBy",
      ops: ["equals"],
      values: ["Agents", "People"],
      multi: false,
    },
  ],
)
