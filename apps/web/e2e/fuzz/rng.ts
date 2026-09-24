/** Seeded PRNG (mulberry32): the whole session plan and every random pick come from
 *  one seed, so a failing seed replays the same gestures on the same fixture. */
export class Rng {
  private state: number
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error("pick from an empty list")
    return items[Math.floor(this.next() * items.length)] as T
  }
  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as [T, number][]
    const total = entries.reduce((sum, [, w]) => sum + w, 0)
    let roll = this.next() * total
    for (const [key, w] of entries) {
      roll -= w
      if (roll < 0) return key
    }
    return (entries[entries.length - 1] as [T, number])[0]
  }
}
