import {
  againstBefore,
  artifactHref,
  ask,
  dashboard,
  measure,
  number,
  over,
  share,
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
              measures: [
                {
                  ...measure("m_part", "version.count"),
                  filter: where("agents", "version.madeBy", "Agents"),
                },
                measure("m_whole", "version.count"),
              ],
              ...share("Share by agents"),
              time: over("version"),
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
            kind: "bar",
            title: "Versions per day",
            queries: {
              main: ask("version", {
                measures: [versions],
                dimensions: [{ id: "who", member: "version.madeBy" }],
                time: { ...over("version"), grain: "day" },
                fill: "zero",
              }),
            },
          },
        ],
        [
          "bySource",
          4,
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
      ],
    },
    {
      height: 5,
      tiles: [
        [
          "byPerson",
          5,
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
  ],
)
