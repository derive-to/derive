// Shared shapes for the library surface (page + sidebar + bars).

export type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "tag"; tag: string }
  | { kind: "collection"; id: string; title: string }

export type TagCount = { tag: string; count: number }

export type Summary = {
  total: number
  favorites: number
  tags: TagCount[]
  workspace: string
}
