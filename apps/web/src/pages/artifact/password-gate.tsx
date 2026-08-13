import { api } from "@/api"
import { PasswordGate as SharedPasswordGate } from "@/components/shared/password-gate"

/**
 * Shown when an artifact's public link carries a password and the visitor hasn't unlocked
 * it yet (getArtifact returned 401). On success the server sets the unlock cookie;
 * `onUnlocked` refetches so the real artifact view renders.
 */
export function PasswordGate({ shortId, onUnlocked }: { shortId: string; onUnlocked: () => void }) {
  return (
    <SharedPasswordGate
      subject="artifact"
      unlock={(password) => api.unlock(shortId, password)}
      onUnlocked={onUnlocked}
    />
  )
}
