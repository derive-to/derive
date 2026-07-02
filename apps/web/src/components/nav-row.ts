// The shared nav-rail row look, in a dependency-free module so the rail AND the
// chips that sit in its foot (NotificationBell, SyncChip, the Settings link) can
// all read from one source — without the circular import that would come from
// pulling these off nav-rail.tsx (which imports those chips).
//
// Row grammar: rest muted; hover brightens the ink over the faint neutral wash
// (bg-hover) — color changes are instant, no transition. Active is a soft
// foreground/5 wash at full ink strength plus the 3px amber left bar, so the
// current item outranks a hovered one without any font-weight change.

export const ROW_BASE =
  "relative flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-sm font-medium text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

// Active rows carry the persistent warm left-edge bar — active nav is on the
// amber-reserved list; the fill itself stays a neutral white wash.
export const ROW_ACTIVE =
  "bg-foreground/5 text-foreground hover:bg-foreground/5 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-primary before:content-['']"

export const ROW_RAIL = "justify-center px-0 py-2.5"
