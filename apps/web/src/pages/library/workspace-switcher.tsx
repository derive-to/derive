import { Check, ChevronDown, Plus, Settings } from "lucide-react"
import { useState } from "react"
import type { Workspaces } from "@/api"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const ROW =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-hover"

// Sidebar workspace control. Single-workspace mode (self-host default): a shortcut
// to settings. Multi-workspace mode (hosted): a popover to switch workspaces or
// create one. Popover (not a menu) so the inline "new workspace" input behaves.
export function WorkspaceSwitcher({
  label,
  workspaces,
  onSwitch,
  onCreate,
  onSettings,
}: {
  label: string
  workspaces: Workspaces | null
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")

  if (!workspaces?.multi)
    return (
      <button
        type="button"
        onClick={onSettings}
        title="Workspace settings"
        data-testid="workspace-switcher"
        className="flex w-full items-center gap-2.5 whitespace-nowrap rounded-[9px] px-2.5 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-hover"
      >
        <span className="w-[18px] shrink-0 text-center">◆</span>
        <span className="truncate">{label}</span>
      </button>
    )

  const submit = () => {
    const t = name.trim()
    if (t) onCreate(t)
    setName("")
    setAdding(false)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setAdding(false)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Switch workspace"
          data-testid="workspace-switcher"
          className="flex w-full items-center gap-2.5 whitespace-nowrap rounded-[9px] px-2.5 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-hover"
        >
          <span className="w-[18px] shrink-0 text-center">◆</span>
          <span className="flex-1 truncate">{label}</span>
          <ChevronDown className="size-3.5 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5" data-testid="workspace-menu">
        {workspaces.workspaces.map((w) => (
          <button
            key={w.id}
            type="button"
            data-testid={`workspace-${w.id}`}
            onClick={() => {
              onSwitch(w.id)
              setOpen(false)
            }}
            className={cn(ROW, "font-medium", w.id === workspaces.active && "text-primary")}
          >
            {w.id === workspaces.active ? (
              <Check className="size-3.5 shrink-0" />
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{w.name}</span>
          </button>
        ))}
        <div className="my-1 h-px bg-border-soft" />
        {adding ? (
          <Input
            autoFocus
            placeholder="Workspace name"
            aria-label="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
              if (e.key === "Escape") setAdding(false)
            }}
            data-testid="workspace-new-input"
            className="h-8"
          />
        ) : (
          <button
            type="button"
            data-testid="workspace-new"
            onClick={() => setAdding(true)}
            className={cn(ROW, "font-medium")}
          >
            <Plus className="size-3.5 shrink-0" /> New workspace
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onSettings()
          }}
          className={cn(ROW, "font-medium")}
        >
          <Settings className="size-3.5 shrink-0" /> Workspace settings
        </button>
      </PopoverContent>
    </Popover>
  )
}
