// One icon vocabulary for the whole app: lucide, the house set (see
// docs/design-system.md) — precise, monochrome-leaning strokes, size-4 in app UI.
// Icons inherit `currentColor` so a glyph always matches the text next to it —
// inside a button it takes the button's ink, in a nav row the row's ink, etc.
// Pass a `text-*` token className only to override for a specific spot (e.g. a
// muted, unfavourited star); pass weight="fill" for a filled state (favorited
// star, pinned pin) — it fills the glyph with the current ink.
import {
  Archive,
  ArrowRight,
  ArrowRightLeft,
  AtSign,
  Ban,
  BarChart3,
  Bell,
  Bold,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code,
  Copy,
  Ellipsis,
  Eye,
  Fingerprint,
  Flag,
  Folder,
  FolderGit2,
  FolderOpen,
  Folders,
  GitFork,
  GitPullRequest,
  Globe,
  History,
  Italic,
  Layers,
  LayoutTemplate,
  Link,
  Lock,
  LockOpen,
  LogOut,
  type LucideIcon,
  Mail,
  Maximize,
  MessageCircle,
  Minimize,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Redo2,
  Search,
  Settings,
  Share2,
  Smile,
  Sparkles,
  Star,
  Trash2,
  Undo2,
  User,
  Users,
  WandSparkles,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"

// name → glyph. Color comes from `currentColor`; override per-usage by passing a
// `text-*` token className (tailwind-merge wins) — e.g. an inactive star renders
// <Icon name="star" className="text-muted-foreground" />.
const REG = {
  // nav
  all: Layers,
  archive: Archive,
  favorites: Star,
  // The activity feed of followed people.
  following: Users,
  collections: Folders,
  collection: Folder,
  // The same folder, open: a folder chip whose card is showing.
  "collection-open": FolderOpen,
  repo: FolderGit2,
  context: Bot,
  workflow: GitFork,
  skill: WandSparkles,
  templates: LayoutTemplate,
  derive: GitFork,
  // Brandprint — the brand's fingerprint.
  brandprint: Fingerprint,
  search: Search,
  settings: Settings,
  // pod / workspace
  user: User,
  workspace: Building2,
  check: Check,
  copy: Copy,
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
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  edit: Code,
  review: GitPullRequest,
  // The agent-revision affordance (ask an agent to revise a selection).
  sparkles: Sparkles,
  pin: Pin,
  views: Eye,
  removed: Ban,
  present: Maximize,
  // The way back out of present mode — the same glyph mirrored, so the control
  // reads as one toggle rather than two unrelated buttons.
  "present-exit": Minimize,
  lock: Lock,
  mail: Mail,
  unlock: LockOpen,
  move: ArrowRightLeft,
  arrow: ArrowRight,
  globe: Globe,
  // the inline editor's own verbs — history, then the two emphases. `link` below is
  // shared with the comment toolbar; one glyph for one meaning across the app.
  undo: Undo2,
  redo: Redo2,
  bold: Bold,
  italic: Italic,
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
