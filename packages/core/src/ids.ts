import { customAlphabet } from "nanoid"

const base36 = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8)

export const newShortId = (): string => base36()
export const newId = (prefix: string): string => `${prefix}_${base36()}${base36()}`

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
