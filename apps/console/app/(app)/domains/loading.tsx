import { PageSkeleton, TableSkeleton, ToolbarSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading domains: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.domains.title}
      description={PAGE_COPY.domains.description}
      actions={["w-16", "w-28"]}
    >
      <ToolbarSkeleton filters={2} />
      <TableSkeleton
        rows={5}
        columns={[
          { kind: "box" },
          { head: "Domain", className: "pl-0", kind: "tile" },
          { head: "Status", className: "w-[11rem]", kind: "status" },
          { head: "Setup", className: "hidden w-[10rem] sm:table-cell" },
          { head: "Region", className: "hidden w-[9rem] md:table-cell", kind: "mono" },
          { head: "Added", className: "w-[9rem] text-right" },
          { className: "w-12", kind: "menu" },
        ]}
      />
    </PageSkeleton>
  )
}
