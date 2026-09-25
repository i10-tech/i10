import { HIDE_WHILE_RESUMING } from "../_lib/resume-keys"
import { ResumeRemount } from "../_lib/resume"

/**
 * Wraps one flow so its steps can come back after a reload.
 *
 * ⚠ A SERVER COMPONENT, BECAUSE OF THE SCRIPT. React refuses a `<script>`
 * rendered by a client component — it will never run on a client render, and
 * React says so in the console. Rendered here it is plain server HTML, parsed
 * and run before the form below it paints. See _lib/resume.tsx for the rest.
 */
export function ResumeBoundary({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: HIDE_WHILE_RESUMING }} />
      <ResumeRemount>{children}</ResumeRemount>
    </>
  )
}
