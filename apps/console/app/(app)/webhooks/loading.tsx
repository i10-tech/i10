import {
  CardGridSkeleton,
  PageSkeleton,
  RememberedListSkeleton,
  TableSkeleton,
  ToolbarSkeleton,
} from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"
import { SkeletonTabs } from "@/components/skeleton-tabs"

/** Loading the webhooks page: its tabs, then the endpoints as they will show. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.webhooks.title}
      description={PAGE_COPY.webhooks.description}
      actions={["w-16", "w-32"]}
    >
      <SkeletonTabs tabs={["Endpoints", "Deliveries"]} />
      <ToolbarSkeleton filters={1} view />
      <RememberedListSkeleton
        viewKey="webhooks"
        fallback="grid"
        table={
          <TableSkeleton
            list="webhooks"
            rows={4}
            columns={[
              { kind: "box" },
              { head: "Endpoint", className: "pl-0", kind: "mono" },
              { head: "Status", className: "w-[9rem]", kind: "status" },
              { head: "Kind", className: "hidden w-[7rem] sm:table-cell" },
              { head: "Events", className: "hidden md:table-cell", kind: "badge" },
              { head: "Error rate", className: "w-[7rem] text-right", kind: "number" },
              { className: "w-12", kind: "menu" },
            ]}
          />
        }
        grid={
          <CardGridSkeleton
            list="webhooks"
            count={4}
            className="lg:grid-cols-2 2xl:grid-cols-3"
          />
        }
      />
    </PageSkeleton>
  )
}
