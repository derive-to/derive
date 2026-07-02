// One icon vocabulary for the whole app: light, regular-weight Phosphor glyphs —
// the precise, monochrome-leaning look (Linear/Resend), not heavy filled shapes.
// Icons inherit `currentColor` (the shadcn/lucide default) so a glyph always matches
// the text next to it — inside a button it takes the button's ink, in a nav row the
// row's ink, etc. Pass a `text-*` token className only to override for a specific
// spot (e.g. a muted, unfavourited star); pass weight="fill" for a filled state.
import {
  BellIcon,
  BookOpenIcon,
  BuildingsIcon,
  CaretDownIcon,
  ChartBarIcon,
  ChatCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
  CornersOutIcon,
  DotsThreeIcon,
  EyeIcon,
  FlagIcon,
  FolderSimpleIcon,
  FoldersIcon,
  GearIcon,
  GitPullRequestIcon,
  HouseIcon,
  type IconWeight,
  LinkIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  type Icon as PhIcon,
  PlusIcon,
  ProhibitIcon,
  PushPinIcon,
  ShareNetworkIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SmileyIcon,
  SquaresFourIcon,
  StackIcon,
  StarIcon,
  TagIcon,
  TrashIcon,
  UserIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

// name → [glyph, default color-token class]. The color is a token utility
// (text-foreground, text-muted-foreground, …) so it themes correctly and passes the guardrail.
// Override per-usage by passing a `text-*` className (tailwind-merge wins) —
// e.g. an inactive star renders <Icon name="star" className="text-muted-foreground" />.
const REG = {
  // nav
  home: HouseIcon,
  all: StackIcon,
  favorites: StarIcon,
  // The activity feed of followed authors + repo paths.
  following: UsersThreeIcon,
  collections: FoldersIcon,
  collection: FolderSimpleIcon,
  tag: TagIcon,
  search: MagnifyingGlassIcon,
  settings: GearIcon,
  // pod / workspace
  user: UserIcon,
  workspace: BuildingsIcon,
  squares: SquaresFourIcon,
  check: CheckIcon,
  plus: PlusIcon,
  signout: SignOutIcon,
  // chrome
  sidebar: SidebarSimpleIcon,
  bell: BellIcon,
  more: DotsThreeIcon,
  close: XIcon,
  // artifact toolbar
  star: StarIcon,
  share: ShareNetworkIcon,
  comments: ChatCircleIcon,
  insights: ChartBarIcon,
  history: ClockCounterClockwiseIcon,
  report: FlagIcon,
  caret: CaretDownIcon,
  edit: CodeIcon,
  review: GitPullRequestIcon,
  pin: PushPinIcon,
  views: EyeIcon,
  reader: BookOpenIcon,
  removed: ProhibitIcon,
  present: CornersOutIcon,
  lock: LockSimpleIcon,
  unlock: LockSimpleOpenIcon,
  // comment toolbar / menu
  react: SmileyIcon,
  pencil: PencilSimpleIcon,
  link: LinkIcon,
  delete: TrashIcon,
} as const satisfies Record<string, PhIcon>

export type IconName = keyof typeof REG

export function Icon({
  name,
  size = 18,
  weight = "regular",
  className,
}: {
  name: IconName
  size?: number
  weight?: IconWeight
  /** A `text-*` token class to recolor (e.g. "text-muted-foreground"). */
  className?: string
}) {
  const Glyph = REG[name]
  return <Glyph size={size} weight={weight} className={cn(className)} />
}
