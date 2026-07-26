import { Camera } from "lucide-react"
import { useRef } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

// The dashed-circle profile-photo picker (Settings › Profile + onboarding): a
// button-wrapped Avatar over a hidden file input, with a status caption. One
// component so the two surfaces can't drift.
export function AvatarPicker({
  image,
  initials,
  uploading,
  onPick,
  ariaLabel,
  testId,
  fallbackClassName,
}: {
  image?: string | null
  /** Initials to show when the person has a name; null falls back to the Camera glyph. */
  initials?: string | null
  uploading: boolean
  onPick: (file: File | null) => void
  ariaLabel: string
  /** Button testid; the hidden input gets `${testId}-input`. */
  testId: string
  /** Fallback tint override (e.g. the soft brand tint for your own initials). */
  fallbackClassName?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        data-testid={testId}
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="group relative size-16 overflow-hidden rounded-full border border-dashed border-input outline-none hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
        aria-label={ariaLabel}
      >
        <Avatar className="size-full rounded-full">
          {image && <AvatarImage src={image} alt="Your avatar" />}
          <AvatarFallback className={cn("rounded-full", fallbackClassName)}>
            {initials ? (
              <span className="text-xl font-medium">{initials}</span>
            ) : (
              <Camera className="size-4" strokeWidth={1.75} aria-hidden />
            )}
          </AvatarFallback>
        </Avatar>
      </button>
      <span className="text-sm text-muted-foreground">
        {uploading ? "Uploading…" : image ? "Change" : "Add a photo"}
      </span>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        data-testid={`${testId}-input`}
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </div>
  )
}
