// One icon vocabulary for the whole app: bright, filled Phosphor glyphs that
// retire the old emoji/unicode chrome. Each icon's color is a semantic token
// CLASS (defined in styles/globals.css), never a raw hex — the design-token
// guardrail (scripts/check-design-tokens.mjs) enforces that. Every surface
// imports <Icon name="…" /> so the look stays consistent and a color changes in
// exactly one place.
import {
  BellIcon,
  BuildingsIcon,
  CaretDownIcon,
  ChartBarIcon,
  ChatCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
  DotsThreeIcon,
  FlagIcon,
  FolderSimpleIcon,
  FoldersIcon,
  GearIcon,
  GitPullRequestIcon,
  HouseIcon,
  type IconWeight,
  MagnifyingGlassIcon,
  type Icon as PhIcon,
  PlusIcon,
  PushPinIcon,
  ShareNetworkIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SquaresFourIcon,
  StackIcon,
  StarIcon,
  TagIcon,
  XIcon,
} from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

// name → [glyph, default color-token class]. The color is a token utility
// (text-gold, text-share, …) so it themes correctly and passes the guardrail.
// Override per-usage by passing a `text-*` className (tailwind-merge wins) —
// e.g. an inactive star renders <Icon name="star" className="text-muted-foreground" />.
const REG = {
  // nav
  home: [HouseIcon, "text-primary"],
  all: [StackIcon, "text-primary"],
  favorites: [StarIcon, "text-gold"],
  collections: [FoldersIcon, "text-collection"],
  collection: [FolderSimpleIcon, "text-collection"],
  tag: [TagIcon, "text-tag"],
  search: [MagnifyingGlassIcon, "text-muted-foreground"],
  settings: [GearIcon, "text-muted-foreground"],
  // pod / workspace
  workspace: [BuildingsIcon, "text-primary"],
  squares: [SquaresFourIcon, "text-primary"],
  check: [CheckIcon, "text-primary"],
  plus: [PlusIcon, "text-primary"],
  signout: [SignOutIcon, "text-muted-foreground"],
  // chrome
  sidebar: [SidebarSimpleIcon, "text-muted-foreground"],
  bell: [BellIcon, "text-share"],
  more: [DotsThreeIcon, "text-muted-foreground"],
  close: [XIcon, "text-muted-foreground"],
  // artifact toolbar
  star: [StarIcon, "text-gold"],
  share: [ShareNetworkIcon, "text-share"],
  comments: [ChatCircleIcon, "text-comments"],
  insights: [ChartBarIcon, "text-insights"],
  history: [ClockCounterClockwiseIcon, "text-muted-foreground"],
  report: [FlagIcon, "text-muted-foreground"],
  caret: [CaretDownIcon, "text-muted-foreground"],
  edit: [CodeIcon, "text-muted-foreground"],
  review: [GitPullRequestIcon, "text-review"],
  pin: [PushPinIcon, "text-gold"],
} as const satisfies Record<string, readonly [PhIcon, string]>

export type IconName = keyof typeof REG

export function Icon({
  name,
  size = 18,
  weight = "fill",
  className,
}: {
  name: IconName
  size?: number
  weight?: IconWeight
  /** A `text-*` token class to recolor (e.g. "text-muted-foreground"). */
  className?: string
}) {
  const [Glyph, color] = REG[name]
  return <Glyph size={size} weight={weight} className={cn(color, className)} />
}
