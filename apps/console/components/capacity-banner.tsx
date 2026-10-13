import { tryApi } from "@/lib/api"
import type { TeamCapacity } from "@/lib/actions"
import { CapacityAlert } from "@/components/capacity-alert"

/**
 * The capacity banner on the overview (#327): admins only, at 80% and at 100%
 * of the plan's member limit, counting members alone - the same crossing the
 * email went out for.
 *
 * ⚠ NOTHING RENDERS WHEN THE READ FAILS, as with the sending banner: a slow
 * Clerk must never paint a full workspace, or take the overview down.
 *
 * ⚠ SHOWN WHILE THE CROSSING STANDS. The stored level says an alert went out
 * and has not re-armed; the live count says it still applies. Dismissing it
 * hides that crossing only - the next one shows again.
 */
export async function CapacityBanner() {
  const result = await tryApi<{ data: TeamCapacity | null }>("/console/team/capacity")
  if (!result.ok) return null
  const capacity = result.data.data
  if (!capacity?.alert || capacity.alert.level === 0 || capacity.personal) return null
  const level =
    capacity.members >= capacity.limit
      ? 100
      : capacity.members * 100 >= capacity.limit * 80
        ? 80
        : 0
  if (level === 0) return null
  return (
    <CapacityAlert
      level={level}
      members={capacity.members}
      limit={capacity.limit}
      canUpgrade={capacity.can_upgrade}
      crossing={capacity.alert.alerted_at ?? `${capacity.alert.level}`}
    />
  )
}
