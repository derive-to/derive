import { useState } from "react"
import { api } from "@/api"
import { FormField } from "@/components/shared/form-field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"

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

// Role + "what you do" editor used in Settings → Profile (onboarding has its own
// unified form). Self-contained: reads the current values off `me`, saves via
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <FormField
          label="Your role"
          htmlFor="profile-role"
          hint={preset && preset !== OTHER && presetHint ? presetHint : undefined}
        >
          <Select
            value={preset || "__unset"}
            onValueChange={(v) => setPreset(v === "__unset" ? "" : v)}
          >
            <SelectTrigger
              id="profile-role"
              data-testid="profile-role"
              aria-label="Your role"
              className="w-37.5"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__unset">Not set</SelectItem>
              {PROFESSIONS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {preset === OTHER && (
          <FormField label="Role name" htmlFor="profile-role-other" className="min-w-37.5 flex-1">
            <Input
              id="profile-role-other"
              data-testid="profile-role-other"
              value={custom}
              maxLength={40}
              placeholder="e.g. Data, Sales, Ops…"
              onChange={(e) => setCustom(e.target.value)}
            />
          </FormField>
        )}
      </div>
      <FormField label="What you do" htmlFor="profile-about">
        <Textarea
          id="profile-about"
          data-testid="profile-about"
          value={about}
          maxLength={280}
          rows={2}
          placeholder="A line about what you work on, so teammates and agents know who you are."
          onChange={(e) => setAbout(e.target.value)}
        />
      </FormField>
      <div>
        <Button
          variant="default"
          data-testid="profile-save"
          onClick={save}
          loading={saving}
          disabled={!dirty}
        >
          {saving ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </div>
  )
}
