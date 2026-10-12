import {
  CardGridSkeleton,
  PageSkeleton,
  RememberedListSkeleton,
  TableSkeleton,
  ToolbarSkeleton,
} from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading broadcasts: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.broadcasts.title}
      description={PAGE_COPY.broadcasts.description}
      actions={["w-32"]}
    >
      <ToolbarSkeleton filters={1} view />
      <RememberedListSkeleton
        viewKey="broadcasts"
        fallback="table"
        table={
          <TableSkeleton
            columns={[
              { head: "Name" },
              { head: "Status", className: "w-[9rem]", kind: "status" },
              { head: "Segment", className: "hidden w-[12rem] md:table-cell" },
              {
                head: "Recipients",
                className: "hidden w-[8rem] text-right sm:table-cell",
                kind: "number",
              },
              { head: "Updated", className: "w-[9rem] text-right" },
            ]}
          />
        }
        grid={<CardGridSkeleton className="lg:grid-cols-3" lines={1} />}
      />
    </PageSkeleton>
  )
}
