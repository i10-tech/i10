import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
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
export function CapacityBanner({
  capacity: capacityProp,
  loading = false,
}: {
  capacity?: TeamCapacity | null
  loading?: boolean
} = {}) {
  if (loading) {
    return (
      <BoneScope id="capacity-banner" loading={true}>
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-start gap-3">
            <Bone id="icon" shape="box" width={20} height={20} radius={4} inline />
            <div className="min-w-0 flex-1 space-y-2">
              <Bone id="title" lineHeight={20} width={280} />
              <Bone id="body" lines={2} lineHeight={18} width="85%" />
            </div>
          </div>
        </div>
      </BoneScope>
    )
  }

  if (!capacityProp) return null
  const capacity = capacityProp
  if (!capacity.alert || capacity.alert.level === 0 || capacity.personal) return null
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
