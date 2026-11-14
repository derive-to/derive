import type { CodeDashboard, StoredQuery } from "derive-dashboards/core"

const last30 = { last: 30, unit: "day" as const, includeCurrent: true }
const versions = (more: Omit<StoredQuery, "kind" | "source">): StoredQuery => ({
  kind: "aggregate",
  source: "version",
  ...more,
})
const inRange = { dimension: "version.createdAt", range: last30 }
const count = { id: "n", measure: "version.count" }

/**
 * The dashboard every workspace starts with: what was published, by whom, and how. Every
 * tile reads versions, so every filter applies to every tile; a new artifact is its first
 * version.
 */
export const PUBLISHING: CodeDashboard = {
  key: "publishing",
  document: {
    specVersion: 1,
    meta: { title: "Publishing", description: "What the workspace published, by whom, and how." },
    tabs: [
      {
        id: "main",
        title: "Publishing",
        layout: [
          { widget: "versions", x: 0, y: 0, w: 3, h: 2 },
          { widget: "newArtifacts", x: 3, y: 0, w: 3, h: 2 },
          { widget: "publishers", x: 6, y: 0, w: 3, h: 2 },
          { widget: "byAgents", x: 9, y: 0, w: 3, h: 2 },
          { widget: "perDay", x: 0, y: 2, w: 8, h: 4 },
          { widget: "bySource", x: 8, y: 2, w: 4, h: 4 },
          { widget: "byPerson", x: 0, y: 6, w: 6, h: 5 },
          { widget: "mostRevised", x: 6, y: 6, w: 6, h: 5 },
        ],
      },
    ],
    widgets: {
      versions: {
        kind: "number",
        title: "Versions published",
        queries: {
          main: versions({ measures: [count], time: { ...inRange, compare: "previous_period" } }),
        },
      },
      newArtifacts: {
        kind: "number",
        title: "New artifacts",
        queries: {
          main: versions({
            measures: [
              {
                id: "n",
                measure: "version.count",
                filter: { id: "f", member: "version.number", op: "equals", values: [1] },
              },
            ],
            time: { ...inRange, compare: "previous_period" },
          }),
        },
      },
      publishers: {
        kind: "number",
        title: "People publishing",
        queries: {
          main: versions({ measures: [{ id: "p", measure: "version.publishers" }], time: inRange }),
        },
      },
      byAgents: {
        kind: "number",
        title: "Published by agents",
        queries: {
          main: versions({
            measures: [
              {
                id: "a",
                measure: "version.count",
                filter: { id: "f", member: "version.madeBy", op: "equals", values: ["Agent"] },
              },
              count,
            ],
            calc: [
              {
                id: "share",
                formula: { op: "/", args: [{ ref: "a" }, { ref: "n" }] },
                format: "percent",
                label: "Share by agents",
              },
            ],
            time: inRange,
          }),
        },
      },
      perDay: {
        kind: "bar",
        title: "Versions per day",
        queries: {
          main: versions({
            measures: [count],
            dimensions: [{ id: "who", member: "version.madeBy" }],
            time: { ...inRange, grain: "day" },
            fill: "zero",
          }),
        },
      },
      bySource: {
        kind: "bar",
        title: "By source",
        queries: {
          main: versions({
            measures: [count],
            dimensions: [{ id: "s", member: "version.source" }],
            time: inRange,
          }),
        },
      },
      byPerson: {
        kind: "bar",
        title: "By person",
        queries: {
          main: versions({
            measures: [count],
            dimensions: [{ id: "who", member: "version.author" }],
            time: inRange,
            order: [{ id: "o", by: "n", dir: "desc" }],
            limit: 6,
            other: true,
          }),
        },
      },
      mostRevised: {
        kind: "table",
        title: "Most revised artifacts",
        queries: {
          main: versions({
            measures: [count],
            dimensions: [
              { id: "t", member: "version.artifact.title" },
              { id: "k", member: "version.artifact.kind" },
            ],
            time: inRange,
            order: [{ id: "o", by: "n", dir: "desc" }],
            limit: 10,
          }),
        },
      },
    },
    controls: [
      {
        id: "range",
        label: "Range",
        kind: "date_range",
        presets: [
          { last: 7, unit: "day", includeCurrent: true },
          last30,
          { last: 90, unit: "day", includeCurrent: true },
        ],
      },
      {
        id: "person",
        label: "Person",
        kind: "filter",
        member: "version.author",
        ops: ["equals", "in"],
        values: "lookup",
        multi: true,
      },
      {
        id: "madeBy",
        label: "Made by",
        kind: "filter",
        member: "version.madeBy",
        ops: ["equals"],
        values: ["Person", "Agent"],
        multi: false,
      },
      {
        id: "kind",
        label: "Kind",
        kind: "filter",
        member: "version.artifact.kind",
        ops: ["equals", "in"],
        values: "lookup",
        multi: true,
      },
    ],
    scope: { bySource: {} },
  },
}
