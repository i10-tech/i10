import { PageSkeleton, TableSkeleton, ToolbarSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading suppressions: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.suppressions.title}
      description={PAGE_COPY.suppressions.description}
      actions={["w-16", "w-24", "w-32"]}
    >
      <ToolbarSkeleton filters={1} />
      <TableSkeleton
        rows={8}
        columns={[
          { head: "Address" },
          { head: "Reason", className: "w-[12rem]", kind: "badge" },
          { head: "Message", className: "hidden w-[9rem] md:table-cell" },
          { head: "Added", className: "w-[9rem] text-right" },
          { className: "w-12", kind: "menu" },
        ]}
      />
    </PageSkeleton>
  )
}
