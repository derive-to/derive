import { useNavigate } from "@tanstack/react-router"
import { Upload } from "lucide-react"
import { useRef } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { libraryArtifactsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

// The library's one primary action, replacing a resting card that spent ~100px teaching
// something you learn once. Both ways in are still here — the card's real content was
// two buttons and a file input, so this is the same capability at a tenth the footprint.
export function NewArtifactButton() {
  const nav = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const publish = useApiMutation({
    mutationFn: (f: File) => api.publish(f, { title: f.name.replace(/\.[^.]+$/, "") }),
    invalidate: [libraryArtifactsQuery({}).queryKey],
    success: () => "Published",
  })

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        data-testid="library-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (f) publish.mutate(f)
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" data-testid="library-new" disabled={publish.isPending}>
            <Icon name="plus" size={16} />
            {publish.isPending ? "Publishing…" : "New"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="library-new-write" onSelect={() => nav({ to: "/new" })}>
            <Icon name="edit" size={16} /> Write or paste
          </DropdownMenuItem>
          {/* Decks were the one thing Derive could do that nothing in the product said it
              could: the badge only appears after you've already built one. This is the
              entry point, and it opens the editor on the same canonical starter the CLI
              scaffolds and the MCP serves. */}
          <DropdownMenuItem
            data-testid="library-new-deck"
            onSelect={() => nav({ to: "/new", search: { start: "deck" } })}
          >
            <Icon name="present" size={16} /> Start a deck
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="library-upload" onSelect={() => fileRef.current?.click()}>
            <Upload className="size-4" aria-hidden /> Upload a file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
