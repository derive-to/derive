// The Dock mark. Brand colors are intentionally fixed — a logo doesn't theme —
// while everything else in the app is tokenized.
export const Logo = ({ size = 24 }: { size?: number }) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: decorative brand mark; the adjacent "Dock" wordmark labels it
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
    <rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540" />
    <path
      d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z"
      fill="none"
      stroke="#8a7dc0"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <rect x="13.6" y="6.4" width="4.8" height="4.8" rx="1.2" fill="#655999" />
  </svg>
)
