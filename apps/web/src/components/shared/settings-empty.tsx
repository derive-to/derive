import type { ReactNode } from "react"

// "Nothing in this list yet", inside a settings section.
//
// NOT EmptyState: that one is a page-level moment — centered, p-10/py-14, a serif
// headline — which is right for an empty library and wrong under an add-form,
// where it strands a centered sentence in a lake of whitespace far below the
// control that fills it. This is the quiet version: one muted line, left-aligned,
// sitting directly under the form at row rhythm. Say what the list will hold, not
// "add one above" — the form is already above, and pointing at it is noise.
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <p className="py-3.5 text-sm text-muted-foreground">{children}</p>
}
