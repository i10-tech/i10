import {
  CardGridSkeleton,
  PageSkeleton,
  RememberedListSkeleton,
  TableSkeleton,
  ToolbarSkeleton,
} from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading segments: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.segments.title}
      description={PAGE_COPY.segments.description}
      actions={["w-32"]}
    >
      <ToolbarSkeleton filters={1} view />
      <RememberedListSkeleton
        viewKey="segments"
        fallback="grid"
        table={
          <TableSkeleton
            columns={[
              { head: "Name" },
              { head: "Contacts", className: "w-[9rem] text-right", kind: "number" },
              { head: "Created", className: "w-[9rem] text-right" },
              { className: "w-12", kind: "menu" },
            ]}
          />
        }
        grid={<CardGridSkeleton className="lg:grid-cols-3" lines={0} />}
      />
    </PageSkeleton>
  )
}
