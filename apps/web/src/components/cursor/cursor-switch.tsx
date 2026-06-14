import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCursorPref } from "@/ctx"
import { CURSOR_COLORS, CURSOR_EMOJI, type CursorKind } from "@/lib/cursors"
import { cn } from "@/lib/utils"
import { CursorGlyph, NameTag } from "./glyph"

// Pick your live cursor: a color, arrow-or-emoji, and (for emoji) the glyph.
// Used both in the account pod and on the artifact page, so anonymous viewers
// can customize too. Swatch colors are identity data, not theme tokens.
export function CursorSwitch({ className }: { className?: string }) {
  const { pref, setPref } = useCursorPref()
  return (
    <div className={cn("space-y-2", className)}>
      {/* Live preview of your own cursor. */}
      <div className="flex items-center gap-2 rounded-md bg-accent/40 px-2.5 py-2">
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
        <TabsList className="h-8 w-full gap-0.5 p-0.5">
          <TabsTrigger value="arrow" data-testid="cursor-kind-arrow" className="flex-1 text-xs">
            Arrow
          </TabsTrigger>
          <TabsTrigger value="emoji" data-testid="cursor-kind-emoji" className="flex-1 text-xs">
            Emoji
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {pref.kind === "emoji" && (
        <div className="grid grid-cols-5 gap-1">
          {CURSOR_EMOJI.map((e, i) => (
            <button
              key={e}
              type="button"
              data-testid={`cursor-emoji-${i}`}
              aria-label={`Emoji ${e}`}
              aria-pressed={pref.emoji === e}
              onClick={() => setPref({ ...pref, kind: "emoji", emoji: e })}
              className={cn(
                "grid h-7 place-items-center rounded-md text-base transition-colors hover:bg-hover",
                pref.emoji === e && "bg-accent ring-1 ring-foreground",
              )}
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {/* Opt out of the live layer entirely: you stop seeing peers' cursors and
          stop broadcasting your own. Persisted per browser like the rest. */}
      <button
        type="button"
        data-testid="cursor-hide"
        aria-pressed={pref.hidden}
        onClick={() => setPref({ ...pref, hidden: !pref.hidden })}
        className={cn(
          "mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-hover",
          pref.hidden && "border-transparent bg-accent",
        )}
      >
        <span className="flex flex-col">
          <span>Hide cursors</span>
          <span className="text-2xs font-normal text-muted-foreground">
            Don't show others, or share yours
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 font-mono text-2xs",
            pref.hidden ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {pref.hidden ? "On" : "Off"}
        </span>
      </button>
    </div>
  )
}
