import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useCursorPref } from "@/ctx"
import { CURSOR_COLORS, CURSOR_EMOJI, type CursorKind } from "@/lib/cursors"
import { cn } from "@/lib/utils"
import { CursorGlyph, NameTag } from "./glyph"

// Pick your live cursor: a color, arrow-or-emoji, and (for emoji) the glyph.
// Opened from the artifact bar's cursor button, so anonymous viewers can
// customize too. Swatch colors are identity data, not theme tokens.
export function CursorSwitch({ className }: { className?: string }) {
  const { pref, setPref } = useCursorPref()
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Live preview of your own cursor. */}
      <div className="flex items-center gap-2 rounded-md bg-secondary px-2.5 py-2">
        <CursorGlyph color={pref.color} kind={pref.kind} emoji={pref.emoji} size={20} />
        <NameTag color={pref.color}>You</NameTag>
      </div>

      {/* Color. */}
      <div className="flex flex-wrap gap-1.5">
        {CURSOR_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            data-testid={`cursor-color-${i}`}
            aria-label={`Cursor color ${i + 1}`}
            aria-pressed={pref.color === c}
            onClick={() => setPref({ ...pref, color: c })}
            className={cn(
              "size-5 rounded-full ring-offset-1 ring-offset-card transition-transform hover:scale-110",
              pref.color === c && "ring-2 ring-foreground",
            )}
            style={{ background: c }}
          />
        ))}
      </div>

      {/* Style. */}
      <Tabs value={pref.kind} onValueChange={(k) => setPref({ ...pref, kind: k as CursorKind })}>
        <TabsList size="sm" className="w-full">
          <TabsTrigger value="arrow" data-testid="cursor-kind-arrow">
            Arrow
          </TabsTrigger>
          <TabsTrigger value="emoji" data-testid="cursor-kind-emoji">
            Emoji
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {pref.kind === "emoji" && (
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          aria-label="Cursor emoji"
          value={pref.emoji}
          // Re-clicking the current pick emits "" (Radix deselect) — a cursor
          // always has an emoji, so ignore it (the library view-toggle idiom).
          onValueChange={(e) => e && setPref({ ...pref, kind: "emoji", emoji: e })}
          className="grid w-full grid-cols-5"
        >
          {CURSOR_EMOJI.map((e, i) => (
            <ToggleGroupItem
              key={e}
              value={e}
              data-testid={`cursor-emoji-${i}`}
              aria-label={`Emoji ${e}`}
              className="text-base"
            >
              {e}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      {/* Opt out of the live layer entirely: you stop seeing peers' cursors and
          stop broadcasting your own. Persisted per browser like the rest. A real
          Switch, not a hand-rolled On/Off pill; clicking the label row toggles it. */}
      <label className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2">
        <span className="flex flex-col text-sm">
          <span className="font-medium">Hide cursors</span>
          <span className="text-muted-foreground">Don't show others, or share yours</span>
        </span>
        <Switch
          size="sm"
          data-testid="cursor-hide"
          // aria-pressed mirrors aria-checked for the e2e contract (asserted in
          // cursor-hide.deep.spec.ts); the switch role still announces correctly.
          aria-pressed={pref.hidden}
          checked={pref.hidden}
          onCheckedChange={(hidden) => setPref({ ...pref, hidden })}
          aria-label="Hide cursors"
        />
      </label>
    </div>
  )
}
