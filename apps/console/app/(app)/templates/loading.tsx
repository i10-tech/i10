import {
  PageSkeleton,
  TemplateGridSkeleton,
  RememberedListSkeleton,
  TableSkeleton,
  ToolbarSkeleton,
} from "@/components/skeletons"
import { PAGE_COPY } from "@/lib/page-copy"

/** Loading the template library: its header, then cards or rows, whichever view it is in. */
export default function Loading() {
  return (
    <PageSkeleton
      title={PAGE_COPY.templates.title}
      description={PAGE_COPY.templates.description}
      actions={["w-16", "w-24"]}
    >
      <ToolbarSkeleton filters={1} view />
      <RememberedListSkeleton
        viewKey="templates"
        fallback="grid"
        table={
          <TableSkeleton
            list="templates"
            columns={[
              { kind: "box" },
              { head: "Name", className: "pl-0", kind: "tile" },
              { head: "Status", className: "hidden md:table-cell", kind: "badge" },
              { head: "Version", className: "hidden lg:table-cell", kind: "number" },
              { head: "Edited" },
              { className: "w-12", kind: "menu" },
            ]}
          />
        }
        grid={<TemplateGridSkeleton />}
      />
    </PageSkeleton>
  )
}
