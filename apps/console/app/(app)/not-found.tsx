import Link from "next/link"
import { Button } from "@repo/ui/components/button"

/**
 * ⚠ THE COPY IS DELIBERATELY AMBIGUOUS ABOUT WHY, AND THAT IS A PRIVACY
 * PROPERTY RATHER THAN VAGUENESS. Row level security makes another tenant's id
 * indistinguishable from one that never existed — a 404 either way. Saying "you
 * do not have access to this" would confirm the id is real, which turns every
 * detail page into an oracle for enumerating other people's records.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Not found</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          That page does not exist, or it belongs to a different workspace. If you
          were switching organizations, the thing you were looking at may live in
          the other one.
        </p>
      </div>
      <Button asChild>
        <Link href="/">Back to the overview</Link>
      </Button>
    </div>
  )
}
