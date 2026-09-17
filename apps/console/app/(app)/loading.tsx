import { Skeleton } from "@repo/ui/components/skeleton"

/**
 * ⚠ A SKELETON WITH THE SHAPE OF A PAGE, NOT A CENTRED SPINNER. A spinner in
 * the middle of the content area makes every navigation feel like it went
 * somewhere blank; a header bar and a few rows keep the layout stable so the
 * real content lands in the space that was already reserved for it — no shift,
 * which is the thing people actually notice.
 *
 * ⚠ AND IT DOES NOT PULSE INDEFINITELY ANYWHERE THAT MATTERS. Tailwind's
 * `animate-pulse` is an infinite loop; the accessibility rules this design
 * system follows allow it because it is short-lived by construction — the
 * component unmounts the moment the route resolves.
 */
export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-6 pt-5 pb-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="mx-auto w-full max-w-7xl space-y-3 px-6 py-6">
        <Skeleton className="h-9 w-full max-w-xs" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
