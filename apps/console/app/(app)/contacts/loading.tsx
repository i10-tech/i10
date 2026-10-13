import { PageSkeleton, TableSkeleton, ToolbarSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading contacts: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.contacts.title}
      description={PAGE_COPY.contacts.description}
      actions={["w-24", "w-28"]}
    >
      <ToolbarSkeleton filters={2} />
      <TableSkeleton
        list="contacts"
        rows={8}
        columns={[
          { kind: "box" },
          { head: "Email", className: "pl-0" },
          { head: "Name", className: "hidden md:table-cell" },
          { head: "Status", className: "w-[9rem]", kind: "status" },
          { head: "Added", className: "w-[9rem] text-right" },
        ]}
      />
    </PageSkeleton>
  )
}
