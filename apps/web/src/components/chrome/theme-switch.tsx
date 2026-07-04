import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { THEMES, useTheme } from "@/ctx"
import { cn } from "@/lib/utils"

// Segmented theme control: Light | Dark. Built on the shadcn Tabs primitive
// (radix-backed, so roles + keyboard nav come for free) at the compact `sm`
// list size — no per-call-site size surgery. Lives in the account pod.
// Keeps the `theme-option-<id>` test-ids the e2e net expects.
export function ThemeSwitch({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  return (
    <Tabs value={theme} onValueChange={setTheme}>
      <TabsList size="sm" aria-label="Theme" className={cn("w-full", className)}>
        {THEMES.map((t) => (
          <TabsTrigger key={t.id} value={t.id} data-testid={`theme-option-${t.id}`}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
