import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * The full-screen source editor: editors publish a new version directly;
 * commenters submit the same edit as a proposal for review (with a "why" the
 * reviewer reads). A self-contained overlay driven entirely by props.
 */
export function SourceEditor({
  canPublish,
  title,
  proposeMsg,
  src,
  onProposeMsg,
  onSrc,
  onCancel,
  onPublish,
  onPropose,
}: {
  canPublish: boolean
  title: string
  proposeMsg: string
  src: string
  onProposeMsg: (v: string) => void
  onSrc: (v: string) => void
  onCancel: () => void
  onPublish: () => void
  onPropose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-2.5">
        <Icon name="edit" size={16} />
        <span className="font-mono text-xs text-muted-foreground">
          {canPublish ? `Editing source · ${title}` : "Proposing a change"}
        </span>
        {/* The proposer's "why" — shown to the reviewer. Editors who publish
            directly don't need it. */}
        {!canPublish && (
          <Input
            value={proposeMsg}
            onChange={(e) => onProposeMsg(e.target.value)}
            placeholder="What are you changing, and why?"
            data-testid="artifact-propose-message"
            className="h-8 max-w-[420px] flex-1 text-sm"
          />
        )}
        <span className="flex-1" />
        <Button variant="outline" size="sm" data-testid="artifact-edit-cancel" onClick={onCancel}>
          Cancel
        </Button>
        {canPublish ? (
          <Button
            variant="primary"
            size="sm"
            data-testid="artifact-publish-version"
            onClick={onPublish}
          >
            Publish new version
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            data-testid="artifact-propose-submit"
            onClick={onPropose}
          >
            Propose change
          </Button>
        )}
      </div>
      <textarea
        value={src}
        onChange={(e) => onSrc(e.target.value)}
        spellCheck={false}
        data-testid="artifact-source-editor"
        className="flex-1 resize-none border-0 bg-card px-5 py-4 font-mono text-sm leading-relaxed text-foreground outline-none"
      />
    </div>
  )
}
