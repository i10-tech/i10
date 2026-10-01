import { ResumeRemount } from "../_lib/resume"

/**
 * Wraps one flow so its steps can come back after a reload.
 *
 * ⚠ THE "HIDE WHILE RESUMING" SCRIPT IS NOT HERE ANY MORE; IT IS IN THE ROOT
 * LAYOUT. Rendered from this page-level component it was fine on a full page
 * load, but the sign-in form reaches /mfa with a CLIENT navigation, and then
 * React renders the page's payload in the browser - where a `<script>` never
 * runs, and Next reports "Encountered a script tag while rendering React
 * component". The root layout is rendered once, with the document, which is
 * the only time the script has anything to do. See _lib/resume.tsx.
 */
export function ResumeBoundary({ children }: { children: React.ReactNode }) {
  return <ResumeRemount>{children}</ResumeRemount>
}
