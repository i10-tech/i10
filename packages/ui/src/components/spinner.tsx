import { cn } from "cn"
import { Loader2Icon } from "lucide-react"

/*
 * shadcn's Spinner, unmodified.
 *
 * ⚠ `role="status"` AND THE LABEL ARE THE COMPONENT, not decoration around it.
 * A bare spinning icon is invisible to a screen reader, so a button that swaps
 * its text for one goes silent at the exact moment it has something to say.
 * Where a button keeps its label — which is the pattern in apps/auth — pass
 * `aria-hidden` and let the label carry the meaning instead, so the state is
 * announced once rather than twice.
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
