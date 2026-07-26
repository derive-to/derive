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
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { OTHER, PROFESSIONS, presetFor } from "@/lib/professions"
import { useApiMutation } from "@/lib/use-api-mutation"

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
  // Above the `!me` guard below — a hook can't sit under an early return. The functional
  // setMe keeps it null-safe up here; onSuccess only fires post-guard, with me present.
  const saveMut = useApiMutation({
    mutationFn: (vars: { profession: string; about: string }) => api.setProfile(vars),
    success: "Profile saved",
    onSuccess: (res) => {
      // Fires post-guard (Save is only reachable with me present), but the hook sits above
      // the `!me` return, so narrow here rather than assert.
      if (me) setMe({ ...me, profession: res.profession, about: res.about })
      onSaved?.()
    },
  })
  if (!me) return null

  // The role we'll persist: the preset, except "Other" which uses the free text.
  const profession = preset === OTHER ? custom.trim() : preset === "" ? "" : preset
  const dirty = profession !== (me.profession ?? "") || about.trim() !== (me.about ?? "")
  const presetHint = PROFESSIONS.find((p) => p.value === preset)?.hint ?? ""
  const save = () => saveMut.mutate({ profession, about: about.trim() })

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
          <FormField
            label="Role name"
            htmlFor="profile-role-other"
            count={custom.length}
            maxLength={40}
            className="min-w-37.5 flex-1"
          >
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
      <FormField label="What you do" htmlFor="profile-about" count={about.length} maxLength={280}>
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
          loading={saveMut.isPending}
          disabled={!dirty}
        >
          {saveMut.isPending ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </div>
  )
}
