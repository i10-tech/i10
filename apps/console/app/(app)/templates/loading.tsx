import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import {
  PageSkeleton,
  RememberedListSkeleton,
  TableSkeleton,
  ToolbarSkeleton,
} from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading the template library: its header, then cards or rows, whichever view it is in. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.templates.title}
      description={PAGE_COPY.templates.description}
      actions={["w-16", "w-24"]}
    >
      <ToolbarSkeleton filters={1} view />
      <RememberedListSkeleton
        viewKey="templates"
        fallback="grid"
        table={
          <TableSkeleton
            columns={[
              { kind: "box" },
              { head: "Name", className: "pl-0", kind: "tile" },
              { head: "Status", className: "hidden md:table-cell", kind: "badge" },
              { head: "Version", className: "hidden lg:table-cell", kind: "number" },
              { head: "Edited" },
              { className: "w-12", kind: "menu" },
            ]}
          />
        }
        grid={
          <ul
            aria-hidden
            className="grid grid-cols-1 gap-x-4 gap-y-6 pt-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="space-y-3" style={{ opacity: 1 - i * 0.07 }}>
                <SkeletonBlock className="aspect-[4/3] w-full rounded-xl" />
                <div className="space-y-2 px-0.5">
                  <SkeletonBlock className="h-3.5 w-2/3 rounded-full" />
                  <SkeletonBlock className="h-3 w-1/3 rounded-full opacity-70" />
                </div>
              </li>
            ))}
          </ul>
        }
      />
    </PageSkeleton>
  )
}
