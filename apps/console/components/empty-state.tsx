import Link from "next/link"
import { Button } from "@repo/ui/components/button"
import { cn } from "cn"

/**
 * Nothing here yet.
 *
 * ⚠ AN EMPTY STATE HAS TO SAY WHY IT IS EMPTY AND WHAT TO DO, AND THE TWO
 * REASONS NEED DIFFERENT WORDS. "No domains" on a new account means "add one";
 * "no domains" after a filter means "your filter matched nothing". Rendering
 * the same sentence for both is how somebody concludes their data has been
 * deleted. Every caller passes the filtered variant explicitly.
 *
 * ⚠ AND IT IS A DASHED BORDER, NOT A CARD. A solid bordered box full of empty
 * space reads as a component that failed to load; a dashed outline reads as a
 * space waiting to be filled, which is what it is.
 */
export function EmptyState({
  title,
  description,
  action,
  secondary,
  className,
}: {
  title: string
  description?: string
  action?: { label: string; href: string }
  secondary?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {(action || secondary) && (
        <div className="mt-3 flex items-center gap-2">
          {action && (
            <Button size="sm" asChild>
              <Link href={action.href}>{action.label}</Link>
            </Button>
          )}
          {secondary}
        </div>
      )}
    </div>
  )
}
