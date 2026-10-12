import {
  CardGridSkeleton,
  PageSkeleton,
  RememberedListSkeleton,
  TableSkeleton,
  ToolbarSkeleton,
} from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading topics: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.topics.title}
      description={PAGE_COPY.topics.description}
      actions={["w-28"]}
    >
      <ToolbarSkeleton filters={1} view />
      <RememberedListSkeleton
        viewKey="topics"
        fallback="table"
        table={
          <TableSkeleton
            columns={[
              { head: "Name" },
              {
                head: "Default",
                className: "hidden w-[11rem] md:table-cell",
                kind: "badge",
              },
              { head: "Visibility", className: "w-[8rem]", kind: "badge" },
              { head: "Subscribers", className: "w-[9rem] text-right", kind: "number" },
              { className: "w-12", kind: "menu" },
            ]}
          />
        }
        grid={<CardGridSkeleton className="lg:grid-cols-3" lines={0} />}
      />
    </PageSkeleton>
  )
}
