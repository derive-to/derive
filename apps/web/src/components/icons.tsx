// One icon vocabulary for the whole app: lucide, the house set (see
// docs/design-system.md) — precise, monochrome-leaning strokes, size-4 in app UI.
// Icons inherit `currentColor` so a glyph always matches the text next to it —
// inside a button it takes the button's ink, in a nav row the row's ink, etc.
// Pass a `text-*` token className only to override for a specific spot (e.g. a
// muted, unfavourited star); pass weight="fill" for a filled state (favorited
// star, pinned pin) — it fills the glyph with the current ink.
import {
  Ban,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  Code,
  Ellipsis,
  Eye,
  Flag,
  Folder,
  Folders,
  GitPullRequest,
  History,
  House,
  Layers,
  LayoutGrid,
  Link,
  Lock,
  LockOpen,
  LogOut,
  type LucideIcon,
  Maximize,
  MessageCircle,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Share2,
  Smile,
  Star,
  Tag,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"

// name → glyph. Color comes from `currentColor`; override per-usage by passing a
// `text-*` token className (tailwind-merge wins) — e.g. an inactive star renders
// <Icon name="star" className="text-muted-foreground" />.
const REG = {
  // nav
  home: House,
  all: Layers,
  favorites: Star,
  // The activity feed of followed authors + repo paths.
  following: Users,
  collections: Folders,
  collection: Folder,
  tag: Tag,
  search: Search,
  settings: Settings,
  // pod / workspace
  user: User,
  workspace: Building2,
  squares: LayoutGrid,
  check: Check,
  plus: Plus,
  signout: LogOut,
  // chrome
  sidebar: PanelLeft,
  bell: Bell,
  more: Ellipsis,
  close: X,
  // artifact toolbar
  star: Star,
  share: Share2,
  comments: MessageCircle,
  insights: BarChart3,
  history: History,
  report: Flag,
  caret: ChevronDown,
  edit: Code,
  review: GitPullRequest,
  pin: Pin,
  views: Eye,
  reader: BookOpen,
  removed: Ban,
  present: Maximize,
  lock: Lock,
  unlock: LockOpen,
  // comment toolbar / menu
  react: Smile,
  pencil: Pencil,
  link: Link,
  delete: Trash2,
} as const satisfies Record<string, LucideIcon>

export type IconName = keyof typeof REG
export type IconWeight = "regular" | "fill"

export function Icon({
  name,
  size = 18,
  weight = "regular",
  strokeWidth = 2,
  className,
}: {
  name: IconName
  size?: number
  /** "fill" paints the glyph solid with the current ink (favorited star, pinned pin). */
  weight?: IconWeight
  /** 1.75 for editorial/empty-state icons; default elsewhere. */
  strokeWidth?: number
  /** A `text-*` token class to recolor (e.g. "text-muted-foreground"). */
  className?: string
}) {
  const Glyph = REG[name]
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      fill={weight === "fill" ? "currentColor" : "none"}
      className={cn("shrink-0", className)}
    />
  )
}
