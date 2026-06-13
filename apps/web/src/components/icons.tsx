// One icon vocabulary for the whole app: bright, filled Phosphor glyphs with a
// per-icon color so the chrome reads playful instead of flat-gray emoji. Every
// surface imports <Icon name="…" /> rather than reaching for a raw glyph, so the
// look stays consistent and a color is changed in exactly one place.
import {
  Bell,
  Buildings,
  ChartBar,
  ChatCircle,
  Check,
  ClockCounterClockwise,
  Code,
  DotsThree,
  FolderSimple,
  Folders,
  Gear,
  GitPullRequest,
  House,
  type Icon as PhIcon,
  type IconWeight,
  MagnifyingGlass,
  Plus,
  PushPin,
  ShareNetwork,
  SidebarSimple,
  SignOut,
  SquaresFour,
  Stack,
  Star,
  Tag,
  X,
} from "@phosphor-icons/react"

// A small, deliberately bright palette. These mid-saturation tones pop on both
// the cream "paper" theme and the near-black "dark"/"dusk" themes.
const C = {
  amber: "#f5a623",
  violet: "#7c6cf0",
  blue: "#3b9ed8",
  teal: "#16b3a7",
  orange: "#f0883a",
  sky: "#46b1f0",
  green: "#52a544",
  slate: "#8a8fa3",
} as const

// name → [component, default color]. Color is overridable per-usage via the
// `color` prop (e.g. an inactive star renders muted, an active one amber).
const REG = {
  // nav
  home: [House, C.violet],
  all: [Stack, C.violet],
  favorites: [Star, C.amber],
  collections: [Folders, C.orange],
  collection: [FolderSimple, C.orange],
  tag: [Tag, C.teal],
  search: [MagnifyingGlass, C.slate],
  settings: [Gear, C.slate],
  // pod / workspace
  workspace: [Buildings, C.violet],
  check: [Check, C.violet],
  plus: [Plus, C.violet],
  signout: [SignOut, C.slate],
  // chrome
  sidebar: [SidebarSimple, C.slate],
  bell: [Bell, C.violet],
  more: [DotsThree, C.slate],
  close: [X, C.slate],
  // artifact toolbar
  star: [Star, C.amber],
  share: [ShareNetwork, C.violet],
  comments: [ChatCircle, C.blue],
  insights: [ChartBar, C.sky],
  history: [ClockCounterClockwise, C.slate],
  edit: [Code, C.slate],
  review: [GitPullRequest, C.green],
  pin: [PushPin, C.amber],
} as const satisfies Record<string, readonly [PhIcon, string]>

export type IconName = keyof typeof REG

export function Icon({
  name,
  size = 18,
  weight = "fill",
  color,
  className,
}: {
  name: IconName
  size?: number
  weight?: IconWeight
  /** Override the registry color (e.g. "currentColor" to inherit, or muted). */
  color?: string
  className?: string
}) {
  const [Glyph, def] = REG[name]
  return <Glyph size={size} weight={weight} color={color ?? def} className={className} />
}
