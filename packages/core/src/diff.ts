export type DiffOp = { t: "ctx" | "add" | "del"; line: string }

/** Line-level diff via LCS. O(n*m) — fine for artifact-sized text. */
export function diffLines(a: string, b: string): DiffOp[] {
  const A = a.split("\n")
  const B = b.split("\n")
  const n = A.length
  const m = B.length
  // dp[i][j] = length of LCS of A[i:] and B[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    // rows always exist by construction; the `?? []` / `?? 0` only satisfy the
    // index-access checker, they never fire for an in-bounds index.
    const row = dp[i] ?? []
    const below = dp[i + 1] ?? []
    for (let j = m - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const ai = A[i] ?? ""
    const bj = B[j] ?? ""
    if (ai === bj) {
      out.push({ t: "ctx", line: ai })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ t: "del", line: ai })
      i++
    } else {
      out.push({ t: "add", line: bj })
      j++
    }
  }
  while (i < n) {
    out.push({ t: "del", line: A[i] ?? "" })
    i++
  }
  while (j < m) {
    out.push({ t: "add", line: B[j] ?? "" })
    j++
  }
  return out
}

/** Render ops as a simple unified-style text diff (`  ctx`, `+ add`, `- del`). */
export function formatDiff(ops: DiffOp[]): string {
  return ops.map((o) => `${o.t === "add" ? "+" : o.t === "del" ? "-" : " "} ${o.line}`).join("\n")
}
