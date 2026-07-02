// The shared nav-rail row look, in a dependency-free module so the chips that
// sit in the rail's foot (NotificationBell, the collapsed rail rows) can match
// the SidebarItem primitive (./sidebar.tsx) exactly — without the circular
// import that would come from pulling React components off nav-rail.tsx (which
// imports those chips).
//
// Row grammar (mirrors SidebarItem): the rest label is FULL-STRENGTH ink —
// only icons carry the muted register — and hover adds the faint neutral wash
// (bg-hover) while brightening the icon; color changes are instant, no
// transition. Active matches the hover wash (Nemonic: state is carried by ink
// + the amber edge tick, not a heavier fill) with no font-weight change.

export const ROW_BASE =
  "relative flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-2 py-2.5 text-left text-base font-medium text-foreground outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:py-2 sm:text-sm [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4.5 hover:[&_svg]:text-foreground"

// Active rows carry the persistent warm edge tick — active nav is on the
// amber-reserved list. Nemonic register: a hairline 2px rounded-full bar at
// the SIDEBAR'S absolute edge (not hugging the row pill), vertically inset.
// The -left offset reaches into the gutter that the sidebar regions carry
// (SidebarBody p-4) — overflow clips at the padding-box edge, so the tick
// renders in the gutter without being cut off. Keep the offset equal to the
// region's padding: expanded p-4 → -left-4; collapsed rail p-2 → ROW_RAIL.
export const ROW_ACTIVE =
  "bg-hover before:absolute before:inset-y-2 before:-left-4 before:w-0.5 before:rounded-full before:bg-primary before:content-[''] [&_svg]:text-foreground"

export const ROW_RAIL = "justify-center px-0 py-2.5 sm:py-2.5 before:-left-2"
