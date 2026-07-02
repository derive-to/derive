// The shared nav-rail row look, in a dependency-free module so the rail AND the
// chips that sit in its foot (NotificationBell, SyncChip, the Settings link) can
// all read from one source — without the circular import that would come from
// pulling these off nav-rail.tsx (which imports those chips).
//
// Rows rest muted; hover brightens the text (not just the background) over a faint
// neutral fill. Active is a stronger fill (foreground/10 > hover's /5) at full text
// strength plus a warm left-edge bar — so the current item outranks a hovered one.

export const ROW_BASE =
  "relative flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"

// Active rows carry a persistent warm left-edge bar (the app's one warm accent) on
// top of the stronger fill — so the current item reads unmistakably, in the rail too.
export const ROW_ACTIVE =
  "bg-foreground/10 text-foreground hover:bg-foreground/10 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-primary before:content-['']"

export const ROW_RAIL = "justify-center px-0 py-2.5"
