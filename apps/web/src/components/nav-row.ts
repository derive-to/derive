// The shared nav-rail row look, in a dependency-free module so the rail AND the
// chips that sit in its foot (NotificationBell, SyncChip, the Settings link) can
// all read from one source — without the circular import that would come from
// pulling these off nav-rail.tsx (which imports those chips).
//
// Row grammar: rest muted; hover brightens the ink over the faint neutral wash
// (bg-hover) — color changes are instant, no transition. Active matches the
// hover wash (Nemonic: the state is carried by full-strength ink + the amber
// edge tick, not a heavier fill) with no font-weight change.

export const ROW_BASE =
  "relative flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-sm font-medium text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

// Active rows carry the persistent warm edge tick — active nav is on the
// amber-reserved list. Nemonic register: a hairline 2px rounded-full bar,
// vertically inset by 8px so it starts exactly where the pill's rounded-lg
// corner curve ends (a chunky full-height bar reads as a detached block).
export const ROW_ACTIVE =
  "bg-hover text-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:content-['']"

export const ROW_RAIL = "justify-center px-0 py-2.5"
