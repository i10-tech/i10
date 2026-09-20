import { publishDnsRecords, refreshDomain, verifyDomain } from "@/lib/actions"
import type { ConflictingRecord, Domain } from "@/lib/types"

/**
 * Getting a domain from "added" to "sending", without anybody pressing anything.
 *
 * ⚠ THIS FILE EXISTS BECAUSE THE SAME FOUR STEPS WERE WRITTEN THREE TIMES. The
 * add form published and toasted; the onboarding flow published and moved to a
 * screen; the OAuth callback published and verified in a loop. All three were
 * doing publish → verify → hope, each with its own idea of what a 409 meant and
 * its own wording for the same outcome — so a fix to one of them fixed one
 * third of the product, and the two surfaces a customer is most likely to
 * compare were the two most likely to disagree.
 *
 * ⚠ IT IS PLAIN FUNCTIONS RATHER THAN A HOOK, WHICH IS WHAT LETS ALL THREE USE
 * IT. The callers do not share a shape — one is a form submit, one is a phase
 * machine, one is an effect that runs once on a callback page — and a hook
 * would have forced a common render model on three components that legitimately
 * render nothing alike. What they share is the SEQUENCE and the set of
 * OUTCOMES, so that is what is shared; every caller still writes its own words.
 *
 * ⚠ AND NOTHING HERE DECIDES TO DELETE ANYBODY'S RECORDS. A zone with an
 * existing DMARC record answers 409 with what stands in the way, and that comes
 * back as an outcome for the caller to put in front of a person. Passing
 * `replaceConflicts` is possible and is never done on a caller's own initiative.
 */

/** What is happening right now, for whatever the caller wants to show. */
export type ActivationStage = "publishing" | "checking"

export type Activation =
  /** Records in place and the provider agrees. Nothing left to do. */
  | { kind: "verified"; domain: Domain }
  /**
   * Records written, ownership proved, and the provider has not caught up.
   *
   * ⚠ THE ORDINARY HAPPY ENDING, NOT A HALF-FAILURE. DNS is finished at this
   * point and the only thing outstanding is Amazon's own check, which runs on
   * its schedule and not ours. A caller that renders this as a problem is
   * telling somebody who is done that they are not.
   */
  | { kind: "published"; domain: Domain | null; written: number }
  /** Nothing was written. Somebody has to agree to the removals first. */
  | { kind: "conflicts"; conflicts: ConflictingRecord[] }
  /** We could not write them. The records are still the customer's to publish. */
  | { kind: "failed"; reason: string }

/**
 * Publish a domain's records at a connected provider, then check them once.
 *
 * ⚠ THE FIRST CHECK IS PART OF PUBLISHING, NOT A SEPARATE ACT SOMEBODY ASKS
 * FOR. Writing records and then waiting to be told to look at them is the step
 * that made this a three-button job; the records were written by us, seconds
 * ago, so there is nobody else who should have to say "now go and see".
 *
 * ⚠ AND A "not yet" FROM THAT FIRST CHECK IS NOT A FAILURE. It is the expected
 * answer inside the first few seconds — see `watchUntilVerified`, which is what
 * the caller should start next rather than reporting anything final.
 */
export async function activateDomain({
  domainId,
  provider,
  replaceConflicts = false,
  onStage,
}: {
  domainId: string
  /** The registry slug. It is what the API matches an adapter on. */
  provider: string
  /** Only ever true because a person was shown the list and agreed. */
  replaceConflicts?: boolean
  onStage?: (stage: ActivationStage) => void
}): Promise<Activation> {
  onStage?.("publishing")

  const published = await publishDnsRecords({ domainId, provider, replaceConflicts })

  if (!published.ok) {
    /*
     * ⚠ A 409 IS THE PROTOCOL, NOT AN ERROR. The API writes nothing and hands
     * back what stands in the way; flattening it into `failed` would lose the
     * one thing that makes it resolvable.
     */
    if (published.status === 409 && !replaceConflicts) {
      const listed = published.body?.conflicts
      // ⚠ NARROWED, NOT CAST. `body` is the API's own JSON and is data.
      return {
        kind: "conflicts",
        conflicts: Array.isArray(listed) ? (listed as ConflictingRecord[]) : [],
      }
    }
    return { kind: "failed", reason: published.error }
  }

  onStage?.("checking")

  const checked = await verifyDomain(domainId)
  // ⚠ THE SAME CHECK AS THE WATCH BELOW, AND FOR THE SAME REASON: `ok` is about
  // the request, not about the body.
  if (!checked.ok || typeof checked.data?.status !== "string") {
    /*
     * ⚠ THE RECORDS ARE PUBLISHED EVEN THOUGH THE CHECK DID NOT ANSWER, and
     * saying "we could not publish" here would be false. The written count is
     * the fact we have; the check is a head start that did not land.
     */
    // ⚠ `null` RATHER THAN A GUESS. The publish response carries what was
    // written, not the domain row, and the one call that would have returned a
    // fresh row is the one that just failed.
    return { kind: "published", domain: null, written: published.data.created.length }
  }

  return checked.data.status === "verified"
    ? { kind: "verified", domain: checked.data }
    : {
        kind: "published",
        domain: checked.data,
        written: published.data.created.length,
      }
}

/**
 * ⚠ BACKED OFF RATHER THAN FIXED, AND THE SHAPE IS CHOSEN FOR THE FIRST TEN
 * SECONDS. Cloudflare serves a written record within a second or two and our
 * own proof reads their nameservers directly, so the common case resolves
 * almost immediately — front-loading the attempts is what turns "verified in
 * about a minute" into "verified before the success screen finishes animating".
 * What follows is spaced out because everything after the first few seconds is
 * waiting on Amazon, and asking faster does not make Amazon answer sooner.
 */
const SCHEDULE_MS = [2_000, 3_000, 5_000, 8_000, 12_000, 15_000, 15_000]

/**
 * Keep asking until the provider agrees, or until the budget runs out.
 *
 * ⚠ IT RESOLVES RATHER THAN REJECTING WHEN IT RUNS OUT, because running out is
 * not an error. A domain that is still pending after a minute is in exactly the
 * state the nightly re-check exists for; the console simply stops watching and
 * says so, and the badge turns green on the next page load.
 *
 * ⚠ AND IT IS ABORTABLE, WHICH IS NOT OPTIONAL FOR SOMETHING THAT OUTLIVES A
 * SCREEN. Every caller is a component that can unmount — a form that navigates,
 * an onboarding step that advances — and a timer left running against an
 * unmounted tree sets state on it a minute later.
 */
export async function watchUntilVerified({
  domainId,
  signal,
  onTick,
  schedule = SCHEDULE_MS,
}: {
  domainId: string
  signal?: AbortSignal
  /** Called with each answer, so a caller can show progress without polling too. */
  onTick?: (domain: Domain) => void
  schedule?: readonly number[]
}): Promise<{ verified: boolean; domain: Domain | null }> {
  let last: Domain | null = null

  for (const delay of schedule) {
    if (signal?.aborted) return { verified: false, domain: last }

    const waited = await sleep(delay, signal)
    if (!waited) return { verified: false, domain: last }

    const result = await refreshDomain(domainId)
    /*
     * ⚠ THE PAYLOAD IS CHECKED, NOT ASSUMED, AND THAT IS NOT PARANOIA. `ok`
     * means the request did not throw; it does not promise a body of the shape
     * this loop wants. A route answering with something else — a fixture that
     * does not exist, a proxy's error page, a later change to the envelope —
     * reached `.status` on `undefined` and threw out of a timer, seven times a
     * minute, on a page nobody had touched.
     */
    if (!result.ok || typeof result.data?.status !== "string") continue

    last = result.data
    onTick?.(result.data)
    if (result.data.status === "verified")
      return { verified: true, domain: result.data }
  }

  return { verified: false, domain: last }
}

/** Resolves false if the wait was cut short. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop)
      resolve(true)
    }, ms)

    function stop() {
      clearTimeout(timer)
      resolve(false)
    }

    signal?.addEventListener("abort", stop, { once: true })
  })
}
