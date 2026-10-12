import type { Metadata } from "next"

/**
 * Clerk's own UI, kept to compare ours against (2026-10-12).
 *
 * ⚠ REFERENCE ONLY, AND UNLISTED. The account panel, the team panel and the
 * "prove it is you" dialog are being rebuilt as ours; these three pages render
 * Clerk's originals exactly as the console used them, so every section, state
 * and animation of theirs can be checked against the replacement side by side.
 * Nothing links here. Delete the folder once the rebuild has reached parity.
 */
export const metadata: Metadata = {
  title: "Clerk reference",
  robots: { index: false, follow: false },
}

export default function ClerkReferenceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
