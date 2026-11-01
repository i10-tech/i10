import Link from "next/link"
import { Sparkles } from "lucide-react"
import { upgradeSentence } from "@/lib/plan-required"

/**
 * The one state every identity screen shows when its plan does not include
 * the feature (#345): a gated route answered 403 `plan_required`.
 *
 * ⚠ ONE COMPONENT, REACHED FROM `Loading`, so a screen cannot forget it and no
 * two of them word it differently. The refusal of a save (a mutation) goes
 * through `toastFailure`, which says the same thing.
 */
export function UpgradePrompt({ feature }: { feature: string | null }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-dashed px-4 py-4 text-sm"
    >
      <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{upgradeSentence(feature)}</p>
        <p className="text-muted-foreground">
          Upgrade your plan to turn it on.{" "}
          <Link
            href="/settings/billing"
            className="text-foreground underline underline-offset-4"
          >
            See plans
          </Link>
        </p>
      </div>
    </div>
  )
}
