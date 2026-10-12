import { PageSkeleton, TableSkeleton, ToolbarSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading the request log: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.logs.title}
      description={PAGE_COPY.logs.description}
      actions={["w-16"]}
    >
      <ToolbarSkeleton range filters={3} />
      <TableSkeleton
        rows={8}
        columns={[
          { className: "w-8 pr-0", kind: "chevron" },
          { head: "Method", className: "w-[5rem]", kind: "badge" },
          { head: "Endpoint", kind: "mono" },
          { head: "Status", className: "w-[5rem]", kind: "badge" },
          { head: "Duration", className: "w-[6rem] text-right", kind: "number" },
          { head: "Client", className: "hidden lg:table-cell" },
          { head: "When", className: "w-[9rem] text-right" },
        ]}
      />
    </PageSkeleton>
  )
}
