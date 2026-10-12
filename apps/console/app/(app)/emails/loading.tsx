import { PageSkeleton, TableSkeleton, ToolbarSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading the emails list: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.emails.title}
      description={PAGE_COPY.emails.description}
      actions={["w-16"]}
    >
      <ToolbarSkeleton range filters={3} />
      <TableSkeleton
        rows={8}
        columns={[
          { head: "Status", className: "w-[9rem]", kind: "status" },
          { head: "To", className: "w-[16rem]" },
          { head: "Subject" },
          { head: "From", className: "hidden w-[16rem] lg:table-cell" },
          { head: "Sent", className: "w-[9rem] text-right" },
        ]}
      />
    </PageSkeleton>
  )
}
