/**
 * Small memory for hot paths: what was computed or read a moment ago, kept for the next
 * request in the same process. A save and its sync walk the same multi-megabyte document
 * several times; an editing session saves the same version over and over.
 */

/** A Map holding its `size` most recently used entries. */
export class Recent<K, V> {
  private readonly entries = new Map<K, V>()
  constructor(private readonly size: number) {}

  get(key: K): V | undefined {
    const hit = this.entries.get(key)
    if (hit !== undefined) this.set(key, hit)
    return hit
  }
  /** The entry, without counting it as used. */
  peek(key: K): V | undefined {
    return this.entries.get(key)
  }
  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value as K)
  }
  delete(key: K): void {
    this.entries.delete(key)
  }
}

/** A function of one large string, remembered for the last few strings it was given.
 *  Strings below `min` characters are cheaper to walk again than to key. What it returns
 *  is shared: callers treat it as read-only. */
export const lastOf = <T>(size: number, min: number, fn: (text: string) => T) => {
  const seen = new Recent<string, T>(size)
  const get = (text: string): T => {
    if (text.length < min) return fn(text)
    const hit = seen.get(text)
    if (hit !== undefined) return hit
    const value = fn(text)
    seen.set(text, value)
    return value
  }
  /** What is remembered for `text`, without computing it. */
  get.peek = (text: string): T | undefined => seen.peek(text)
  return get
}
