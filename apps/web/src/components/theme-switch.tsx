import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { THEMES, useTheme } from "@/ctx"
import { cn } from "@/lib/utils"

// Segmented theme control: Light | Dark. Built on the shadcn Tabs primitive
// (radix-backed, so roles + keyboard nav come for free). Lives in the account pod.
// Keeps the `theme-option-<id>` test-ids the e2e net expects.
export function ThemeSwitch({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  return (
    <Tabs value={theme} onValueChange={setTheme}>
      <TabsList className={cn("h-8 w-full gap-0.5 p-0.5", className)}>
        {THEMES.map((t) => (
          <TabsTrigger
            key={t.id}
            value={t.id}
            data-testid={`theme-option-${t.id}`}
            className="flex-1 px-2 py-1 text-xs"
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
