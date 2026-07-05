// One icon vocabulary for the whole app: lucide, the house set (see
// docs/design-system.md) — precise, monochrome-leaning strokes, size-4 in app UI.
// Icons inherit `currentColor` so a glyph always matches the text next to it —
// inside a button it takes the button's ink, in a nav row the row's ink, etc.
// Pass a `text-*` token className only to override for a specific spot (e.g. a
// muted, unfavourited star); pass weight="fill" for a filled state (favorited
// star, pinned pin) — it fills the glyph with the current ink.
import {
  AtSign,
  Ban,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  Ellipsis,
  Eye,
  Flag,
  Folder,
  Folders,
  GitPullRequest,
  Globe,
  History,
  Layers,
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
  all: Layers,
  favorites: Star,
  // The activity feed of followed authors + repo paths.
  following: Users,
  collections: Folders,
  collection: Folder,
  context: Bot,
  tag: Tag,
  search: Search,
  settings: Settings,
  // pod / workspace
  user: User,
  workspace: Building2,
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
  "caret-up": ChevronUp,
  edit: Code,
  review: GitPullRequest,
  pin: Pin,
  views: Eye,
  reader: BookOpen,
  removed: Ban,
  present: Maximize,
  lock: Lock,
  unlock: LockOpen,
  globe: Globe,
  // comment toolbar / menu
  react: Smile,
  pencil: Pencil,
  link: Link,
  delete: Trash2,
  // notifications
  at: AtSign,
} as const satisfies Record<string, LucideIcon>

// Icons stay monochrome: they inherit `currentColor`, so a glyph always matches
// the ink beside it. The chrome is deliberately neutral so the user's artifacts —
// which carry their own colour (charts, heroes, thumbnails) — are what pops; a
// tinted glyph next to that content would only compete with it. The categorical
// tint family (globals.css @theme) is reserved for data surfaces (charts) and any
// future, deliberate wayfinding, not a blanket icon default.
export type IconName = keyof typeof REG
export type IconWeight = "regular" | "fill"

export function Icon({
  name,
  size = 16,
  weight = "regular",
  strokeWidth = 2,
  className,
}: {
  name: IconName
  /** 16 (size-4) is the app register; 12 for mono meta rows; 24 editorial. */
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
      // Icons are always decorative in this app — the adjacent label or the
      // control's aria-label carries the meaning, never the glyph.
      aria-hidden="true"
      className={cn("shrink-0", className)}
    />
  )
}
