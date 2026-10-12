import type { ComponentProps } from "react"
import { cn } from "cn"

/**
 * The actions row at the end of an Arc dialog body. Arc's DialogContent has a
 * header and a body and leaves actions to the caller; this is that row, one
 * spacing step below the content, primary action last (rightmost).
 */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  )
}
