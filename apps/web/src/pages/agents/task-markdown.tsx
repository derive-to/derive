import { mdBlocksToHtml } from "../artifact/lib/markdown"

export function TaskMarkdown({ text }: { text: string }) {
  return (
    <div
      className="min-w-0 break-words text-base leading-7 [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:font-semibold [&_li]:pl-1 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-4 [&_pre]:mb-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-secondary [&_pre]:p-4 [&_pre_code]:p-0 [&_table]:w-full [&_table]:text-left [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-3 [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_.markdown-table]:mb-5 [&_.markdown-table]:overflow-x-auto [&>:last-child]:mb-0"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the shared renderer escapes HTML and only admits safe links.
      dangerouslySetInnerHTML={{
        __html: mdBlocksToHtml(
          text.replace(/\[([^\]]+)\]\((\/(?:home|tmp|Users)\/[^)]+)\)/g, "$1"),
        ),
      }}
    />
  )
}
