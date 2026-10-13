import { PageSkeleton, TableSkeleton, ToolbarSkeleton } from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading API keys: its real header and columns, placeholder rows. See components/skeletons. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.apiKeys.title}
      description={PAGE_COPY.apiKeys.description}
      actions={["w-16", "w-28"]}
    >
      <ToolbarSkeleton filters={2} />
      <TableSkeleton
        list="api-keys"
        rows={5}
        columns={[
          { kind: "box" },
          { head: "Name", className: "pl-0" },
          { head: "Key", className: "w-[10rem]", kind: "mono" },
          { head: "Mode", className: "w-[6rem]", kind: "badge" },
          { head: "Sends from", className: "hidden w-[12rem] sm:table-cell" },
          { head: "Last used", className: "hidden w-[10rem] md:table-cell" },
          { head: "Created", className: "hidden w-[10rem] lg:table-cell" },
          { className: "w-12", kind: "menu" },
        ]}
      />
    </PageSkeleton>
  )
}
