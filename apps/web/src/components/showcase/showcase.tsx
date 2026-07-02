import type { ReactNode } from "react"
import { ThemeSwitch } from "@/components/theme-switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"

// The design-system reference: tokens + primitives on one page, so the visual
// language can be reviewed and evolved in isolation before it touches real
// surfaces. Lives outside pages/ + components/shared/ on purpose — it's a design
// canvas, not a product surface, so it sits out of the test-id guardrail. Every
// color here comes from a token utility (never a raw hex) so it doubles as the
// proof that the token system is complete. Reachable at /showcase.

/** A titled block with a small uppercase label, matching the app's section rhythm. */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-border-soft py-10">
      <div className="mb-6">
        <h2 className="font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        {hint ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

/** One color token: a filled chip over the app's surfaces, with its name + class. */
function Swatch({ name, cls }: { name: string; cls: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className={`h-16 rounded-md border border-border-soft ${cls}`} />
      <div className="leading-tight">
        <div className="text-xs text-foreground">{name}</div>
        <div className="font-mono text-2xs text-muted-foreground">{cls}</div>
      </div>
    </div>
  )
}

const SURFACES = [
  { name: "Background", cls: "bg-background" },
  { name: "Card", cls: "bg-card" },
  { name: "Secondary", cls: "bg-secondary" },
  { name: "Muted", cls: "bg-muted" },
  { name: "Hover", cls: "bg-hover" },
  { name: "Accent (soft)", cls: "bg-accent" },
  { name: "Primary", cls: "bg-primary" },
  { name: "Foreground", cls: "bg-foreground" },
]

const SEMANTIC = [
  { name: "Success", cls: "bg-success" },
  { name: "Destructive", cls: "bg-destructive" },
]

// Categorical wayfinding accents — fixed brights, the one place color survives
// the monochrome brand (feature icons only).
const CATEGORICAL = [
  { name: "Share", cls: "bg-share" },
  { name: "Comments", cls: "bg-comments" },
  { name: "Tag", cls: "bg-tag" },
  { name: "Collection", cls: "bg-collection" },
  { name: "Insights", cls: "bg-insights" },
  { name: "Review", cls: "bg-review" },
  { name: "Gold", cls: "bg-gold" },
]

const TYPE_SCALE = [
  { cls: "text-3xl", label: "text-3xl · 28px" },
  { cls: "text-2xl", label: "text-2xl · 22px" },
  { cls: "text-xl", label: "text-xl · 18px" },
  { cls: "text-lg", label: "text-lg · 16px" },
  { cls: "text-base", label: "text-base · 14px" },
  { cls: "text-sm", label: "text-sm · 12.5px" },
  { cls: "text-xs", label: "text-xs · 11px" },
  { cls: "text-2xs", label: "text-2xs · 10px" },
]

const WEIGHTS = [
  { cls: "font-light", label: "Light 300" },
  { cls: "font-normal", label: "Regular 400" },
  { cls: "font-medium", label: "Medium 500" },
  { cls: "font-semibold", label: "Semibold 600" },
  { cls: "font-bold", label: "Bold 700" },
]

const RADII = ["rounded-sm", "rounded-md", "rounded-lg", "rounded-xl"]

const BUTTON_VARIANTS = [
  "default",
  "primary",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
] as const

const BADGE_VARIANTS = ["default", "primary", "accent", "success", "outline"] as const

export function Showcase() {
  return (
    <div className="min-h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl px-6 py-12">
        <header className="flex flex-wrap items-end justify-between gap-4 pb-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Design System</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Tokens and primitives — the foundation for the facelift. Toggle the theme to review
              both.
            </p>
          </div>
          <ThemeSwitch className="w-40" />
        </header>

        <Section
          title="Surfaces & ink"
          hint="Every value is a semantic token — no raw hex anywhere."
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {SURFACES.map((s) => (
              <Swatch key={s.cls} {...s} />
            ))}
          </div>
        </Section>

        <Section title="Semantic & categorical">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[...SEMANTIC, ...CATEGORICAL].map((s) => (
              <Swatch key={s.cls} {...s} />
            ))}
          </div>
        </Section>

        <Section
          title="Type scale"
          hint="Inter, tracking pulled in a hair. Mono is Geist-free — ui-monospace."
        >
          <div className="space-y-3">
            {TYPE_SCALE.map((t) => (
              <div key={t.cls} className="flex items-baseline gap-6">
                <span className={`${t.cls} tracking-tight text-foreground`}>
                  The quick brown fox
                </span>
                <span className="font-mono text-2xs text-muted-foreground">{t.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap gap-6">
            {WEIGHTS.map((w) => (
              <div key={w.cls} className="leading-tight">
                <div className={`text-lg ${w.cls}`}>Aa</div>
                <div className="font-mono text-2xs text-muted-foreground">{w.label}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Radius & elevation">
          <div className="flex flex-wrap items-end gap-6">
            {RADII.map((r) => (
              <div key={r} className="flex flex-col gap-2">
                <div className={`h-16 w-16 border border-border bg-card ${r}`} />
                <span className="font-mono text-2xs text-muted-foreground">{r}</span>
              </div>
            ))}
            <div className="flex flex-col gap-2">
              <div
                className="h-16 w-24 rounded-lg border border-border-soft bg-card"
                style={{ boxShadow: "var(--shadow)" }}
              />
              <span className="font-mono text-2xs text-muted-foreground">shadow</span>
            </div>
          </div>
        </Section>

        <Section
          title="Buttons"
          hint="Current primitives. Weight and states get the Linear-grade pass next."
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {BUTTON_VARIANTS.map((v) => (
                <Button key={v} variant={v}>
                  {v}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">Small</Button>
              <Button size="default">Default</Button>
              <Button size="lg">Large</Button>
              <Button disabled>Disabled</Button>
            </div>
          </div>
        </Section>

        <Section title="Badges">
          <div className="flex flex-wrap items-center gap-3">
            {BADGE_VARIANTS.map((v) => (
              <Badge key={v} variant={v}>
                {v}
              </Badge>
            ))}
          </div>
        </Section>

        <Section title="Forms">
          <div className="grid max-w-md gap-4">
            <Input placeholder="Artifact title" />
            <Input placeholder="Disabled" disabled />
            <Textarea placeholder="A short description…" rows={3} />
          </div>
        </Section>

        <Section title="Card">
          <Card className="max-w-sm">
            <CardHeader>
              <CardTitle>Quarterly review</CardTitle>
              <CardDescription>Published 2 days ago · 3 versions</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <Button size="sm" variant="primary">
                Open
              </Button>
              <Button size="sm" variant="ghost">
                Share
              </Button>
            </CardContent>
          </Card>
        </Section>
      </div>
    </div>
  )
}
