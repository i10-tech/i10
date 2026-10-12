import { cn } from "cn"

/**
 * A tab bar while its page loads, with the real labels: the shape of Arc's
 * Tabs list (components/tabs), the first tab marked as the one that opens.
 */
export function SkeletonTabs({ tabs }: { tabs: string[] }) {
  return (
    <div
      aria-hidden
      className="inline-flex gap-1 rounded-[var(--radius-control)] border bg-[var(--surface-muted)] p-1"
    >
      {tabs.map((tab, i) => (
        <span
          key={tab}
          className={cn(
            "grid h-8 min-w-[5.5rem] place-items-center rounded-[calc(var(--radius-control)-3px)] px-3 text-sm font-medium text-[var(--text-muted)]",
            i === 0 && "border bg-[var(--surface)] text-foreground",
          )}
        >
          {tab}
        </span>
      ))}
    </div>
  )
}
