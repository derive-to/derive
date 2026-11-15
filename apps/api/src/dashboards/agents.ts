import { againstBefore, ask, dashboard, measure, number, over, share, top, where } from "./parts"

const runs = measure("m_n", "job.count")

/** A list of runs in one state, each a link to its run page. */
const runList = (title: string, status: string, empty: string, inRange: boolean) => ({
  kind: "list",
  title,
  queries: {
    main: ask("job", {
      measures: [runs],
      dimensions: [
        { id: "a", member: "job.agent" },
        { id: "b", member: "job.askedBy" },
        { id: "i", member: "job.id" },
      ],
      filters: where("f", "job.status", status),
      ...(inRange ? { time: over("job") } : {}),
      ...top("m_n", 6),
    }),
  },
  display: { title: "a", subtitle: ["b"], avatar: "a", meta: "-", href: "/tasks/{i}", empty },
})

/**
 * What agents ran for the workspace, how it went, and what is waiting on a person. A run's
 * instructions never appear: tiles read the agent, its status, who asked and when.
 */
export const AGENTS = dashboard(
  "agents",
  "Agents",
  "What agents did for the workspace, and what is waiting on a person.",
  [
    {
      height: 2,
      tiles: [
        [
          "runs",
          3,
          number("Agent runs", ask("job", { measures: [runs], time: againstBefore("job") })),
        ],
        [
          "succeeded",
          3,
          number(
            "Succeeded",
            ask("job", {
              measures: [measure("m_part", "job.succeeded"), measure("m_whole", "job.finished")],
              ...share("Succeeded"),
              time: over("job"),
            }),
          ),
        ],
        [
          "waiting",
          3,
          number("Waiting on someone", ask("job", { measures: [measure("m_w", "job.waiting")] })),
        ],
        [
          "typical",
          3,
          number(
            "Typical run",
            ask("job", {
              measures: [measure("m_t", "job.typical")],
              calc: [
                { id: "c_t", formula: { ref: "m_t" }, format: "duration", label: "Typical run" },
              ],
              time: over("job"),
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
            title: "Runs per day",
            queries: {
              main: ask("job", {
                measures: [runs],
                dimensions: [{ id: "s", member: "job.status" }],
                time: { ...over("job"), grain: "day" },
                fill: "zero",
              }),
            },
            display: {
              colors: {
                Succeeded: "var(--dd-state-good)",
                Failed: "var(--dd-state-critical)",
                "Waiting on someone": "var(--dd-state-warning)",
                Cancelled: "var(--dd-other)",
              },
            },
          },
        ],
        [
          "byAgent",
          4,
          {
            kind: "bar",
            title: "Runs by agent",
            queries: {
              main: ask("job", {
                measures: [runs],
                dimensions: [{ id: "a", member: "job.agent" }],
                time: over("job"),
                ...top("m_n", 5),
                other: true,
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
          "waitingList",
          6,
          runList(
            "Waiting on someone",
            "Waiting on someone",
            "Nothing is waiting on anyone.",
            false,
          ),
        ],
        ["failed", 6, runList("Recent failures", "Failed", "No failed runs in this range.", true)],
      ],
    },
  ],
)
