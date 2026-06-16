import { useState } from "react"
import { toast } from "sonner"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/input"
import { useAuth } from "@/ctx"
import { selectClass } from "@/pages/settings/roles"

// The team roles offered in the picker, written casually with a plain-language
// blurb so people self-identify by what they actually do, not a job title. Stored
// as the `value` (free-form underneath: "Other" lets you type anything), so the
// list can grow without a migration. Ordered roughly startup-first.
export const PROFESSIONS: { value: string; hint: string }[] = [
  { value: "Founder", hint: "set the direction and do a bit of everything" },
  { value: "Builder", hint: "generalist: write code, build roadmaps and docs, design stuff" },
  { value: "Product", hint: "shape roadmaps, specs, and what to build next" },
  { value: "Engineering", hint: "write and ship the code" },
  { value: "Design", hint: "craft how it looks and feels" },
  { value: "Marketing", hint: "tell the story and grow the audience" },
  { value: "Other", hint: "something else: type your own" },
]

const OTHER = "Other"
const PRESET_VALUES = PROFESSIONS.map((p) => p.value)

// Map a stored profession onto the select: a preset matches itself; anything else
// (a custom "Other" value, or a legacy string) lands on "Other" with the text kept.
const presetFor = (p: string | null): string => {
  if (!p) return ""
  return PRESET_VALUES.includes(p) ? p : OTHER
}

// Role + "what you do" editor, shared by onboarding (ProfileSetupCard) and
// Settings → Profile. Self-contained: reads the current values off `me`, saves via
// POST /v1/me/profile, and pushes the result back into the auth context. Both
// fields are optional — saving with everything blank simply clears them.
export function ProfileFields({ onSaved }: { onSaved?: () => void }) {
  const { me, setMe } = useAuth()
  const [preset, setPreset] = useState<string>(presetFor(me?.profession ?? null))
  const [custom, setCustom] = useState<string>(
    me?.profession && presetFor(me.profession) === OTHER ? me.profession : "",
  )
  const [about, setAbout] = useState<string>(me?.about ?? "")
  const [saving, setSaving] = useState(false)
  if (!me) return null

  // The role we'll persist: the preset, except "Other" which uses the free text.
  const profession = preset === OTHER ? custom.trim() : preset === "" ? "" : preset
  const dirty = profession !== (me.profession ?? "") || about.trim() !== (me.about ?? "")
  const presetHint = PROFESSIONS.find((p) => p.value === preset)?.hint ?? ""

  const save = async () => {
    setSaving(true)
    try {
      const res = await api.setProfile({ profession, about: about.trim() })
      setMe({ ...me, profession: res.profession, about: res.about })
      toast.success("Profile saved")
      onSaved?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="profile-role" className="text-2xs font-medium text-muted-foreground">
            Your role
          </label>
          <select
            id="profile-role"
            data-testid="profile-role"
            aria-label="Your role"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className={`${selectClass} w-[150px]`}
          >
            <option value="">Not set</option>
            {PROFESSIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.value}
              </option>
            ))}
          </select>
        </div>
        {preset === OTHER && (
          <div className="flex min-w-[150px] flex-1 flex-col gap-1">
            <label
              htmlFor="profile-role-other"
              className="text-2xs font-medium text-muted-foreground"
            >
              Role name
            </label>
            <Input
              id="profile-role-other"
              data-testid="profile-role-other"
              value={custom}
              maxLength={40}
              placeholder="e.g. Data, Sales, Ops…"
              onChange={(e) => setCustom(e.target.value)}
            />
          </div>
        )}
      </div>
      {preset && preset !== OTHER && presetHint && (
        <p className="-mt-1 text-2xs text-muted-foreground">{presetHint}</p>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="profile-about" className="text-2xs font-medium text-muted-foreground">
          What you do
        </label>
        <Textarea
          id="profile-about"
          data-testid="profile-about"
          value={about}
          maxLength={280}
          rows={2}
          placeholder="A line about what you work on, so teammates and agents know who you are."
          onChange={(e) => setAbout(e.target.value)}
        />
      </div>
      <div>
        <Button
          variant="primary"
          size="sm"
          data-testid="profile-save"
          onClick={save}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </div>
  )
}
