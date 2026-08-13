import type { ReactNode } from "react"
import type { LinkRole } from "@/api"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuTrigger,
} from "@/components/ui/select-menu"

export const LINK_ROLE_LABEL: Record<Exclude<LinkRole, "none">, string> = {
  viewer: "Can view",
  commenter: "Can comment",
  editor: "Can edit",
}

/** The shared "Anyone" body for artifacts and collections. Subject-specific
 *  discovery controls slot between the role and password, while every actual link
 *  capability—role warning, set/change/clear password—stays one implementation. */
export function WorldLinkControls({
  role,
  pending,
  hasLock,
  lockDraft,
  passwordOpen,
  password,
  testPrefix,
  onRoleChange,
  onLockChange,
  onPasswordOpen,
  onPasswordChange,
  onPasswordSet,
  children,
}: {
  role: Exclude<LinkRole, "none">
  pending: boolean
  hasLock: boolean
  lockDraft: boolean
  passwordOpen: boolean
  password: string
  testPrefix: "share" | "collection-share"
  onRoleChange: (role: Exclude<LinkRole, "none">) => void
  onLockChange: (on: boolean) => void
  onPasswordOpen: () => void
  onPasswordChange: (password: string) => void
  onPasswordSet: (password: string) => void
  children?: ReactNode
}) {
  return (
    <>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">Anyone with the link</span>
        <SelectMenu value={role} onValueChange={(v) => onRoleChange(v as typeof role)}>
          <SelectMenuTrigger
            aria-label="What the link grants"
            data-testid={`${testPrefix}-link-role`}
            disabled={pending}
            className="bg-card"
          >
            {LINK_ROLE_LABEL[role]}
          </SelectMenuTrigger>
          <SelectMenuContent>
            <SelectMenuItem value="viewer">Can view</SelectMenuItem>
            <SelectMenuItem value="commenter">Can comment</SelectMenuItem>
            <SelectMenuItem value="editor">Can edit</SelectMenuItem>
          </SelectMenuContent>
        </SelectMenu>
      </div>

      {role === "editor" && (
        <p className="mt-2 rounded-lg bg-warning/10 px-2.5 py-2 text-2xs text-warning">
          Anyone with the link can edit, publish, and share this.
        </p>
      )}

      {children}

      <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
        <Checkbox
          checked={hasLock || lockDraft}
          disabled={pending}
          aria-label="Require a password"
          data-testid={`${testPrefix}-lock-toggle`}
          onCheckedChange={(v) => onLockChange(v === true)}
        />
        Require a password
      </label>
      {(lockDraft || (hasLock && passwordOpen)) && (
        <div className="mt-2 flex gap-1.5">
          <Input
            type="password"
            data-testid={`${testPrefix}-visibility-password`}
            placeholder={hasLock ? "New password" : "Set a password"}
            aria-label="Password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password) onPasswordSet(password)
            }}
            className="flex-1"
          />
          <Button
            data-testid={`${testPrefix}-visibility-save`}
            variant="secondary"
            size="sm"
            disabled={!password}
            loading={pending}
            onClick={() => onPasswordSet(password)}
          >
            {pending ? "Setting…" : "Set password"}
          </Button>
        </div>
      )}
      {!lockDraft && hasLock && !passwordOpen && (
        <Button
          variant="link"
          size="xs"
          data-testid={`${testPrefix}-password-change`}
          className="mt-1 self-start px-0"
          onClick={onPasswordOpen}
        >
          Change password
        </Button>
      )}
    </>
  )
}
