import type { Comment } from "@/api"

// A text-anchor selection in the document (the structural quote a comment pins to).
export type Sel = { type?: string; exact: string; prefix?: string; suffix?: string }

// Comments UI mode: full panel, collapsed rail of dots, or hidden.
export type Panel = "open" | "rail" | "hidden"

// A thread positioned in the pinned margin beside its highlight.
export type PinItem = { thread: Comment[]; desiredY: number; located: boolean }
