import { listRegistryObjects, type StalwartCaller } from "./stalwart.js"

/**
 * Keeps Stalwart's `Domain` objects in step with `core.mailbox_domains()`.
 *
 * Stalwart 1.0 only accepts mail and logins for a domain it holds as a `Domain`.
 * `i10.tech` comes from infra/k8s/i10/stalwart/config/plan.ndjson; every customer
 * domain has to be created here, over the same registry JMAP the quota sync uses
 * (see the wire notes at the top of ./stalwart.ts).
 *
 * ⚠ THE MARKER IS HOW WE KNOW A DOMAIN IS OURS TO CHANGE. Every Domain created
 * here carries `description: "i10-managed"`, and nothing without it is ever
 * modified, disabled or destroyed - `i10.tech`, which the plan owns, and any
 * domain somebody added by hand. The registry is shared with people and with
 * the plan; guessing ownership from the name alone is how a reconcile disables
 * the domain our own mail leaves from.
 */
export const MANAGED_MARKER = "i10-managed"

/**
 * ⚠ NEVER ADOPTED, EVEN WITH `adopt`. `i10.tech` is in `core.mailbox_domains()`
 * (migration 0029) so it is "desired" and unmarked, which is exactly what an
 * adoptable hand-added domain looks like. Adopting it would rewrite the
 * description of a domain the plan upserts by `name`.
 */
export const PROTECTED_DOMAINS: ReadonlySet<string> = new Set(["i10.tech"])

export interface StalwartDomain {
  id: string
  /** Lowercased. */
  name: string
  enable: boolean
  description: string | null
  catchAllAddress: string | null
}

export interface EnsureOptions {
  /**
   * The catch-all address. `undefined` leaves it alone, a string sets it and
   * `null` clears it.
   */
  catchAllAddress?: string | null
}

export type EnsureOutcome =
  | "created"
  /** Existed, ours, and something about it changed (re-enabled, catch-all). */
  | "updated"
  | "unchanged"
  /** Exists without our marker, so it was left strictly alone. */
  | "unmanaged"

const norm = (name: string) => name.trim().toLowerCase()

const isManaged = (d: StalwartDomain) => d.description === MANAGED_MARKER

/** Whether Stalwart already holds `wanted` as the catch-all, case aside. */
const sameCatchAll = (d: StalwartDomain, wanted: string | null) =>
  (d.catchAllAddress?.toLowerCase() ?? null) === wanted

/** The catch-all part of an update, empty when it is already right or not wanted. */
function catchAllPatch(
  domain: StalwartDomain,
  wanted: ReadonlyMap<string, string | null>,
  name: string,
): { catchAllAddress?: string | null } {
  if (!wanted.has(name)) return {}
  const address = wanted.get(name) ?? null
  return sameCatchAll(domain, address) ? {} : { catchAllAddress: address }
}

function toDomain(raw: Record<string, unknown>): StalwartDomain {
  // ⚠ A MISSING `id` OR `name` MEANS THE SHAPE IS NOT WHAT WE EXPECT, and every
  // way of reading that as "no such domain" ends in the reconcile creating one
  // that already exists. Same rule as the account reader: fail, never default.
  if (typeof raw.id !== "string" || typeof raw.name !== "string") {
    throw new Error("stalwart returned a Domain without an id or a name")
  }
  return {
    id: raw.id,
    name: raw.name.toLowerCase(),
    // `enable` defaults to true in the registry, so an absent one is enabled.
    enable: raw.enable !== false,
    description: typeof raw.description === "string" ? raw.description : null,
    catchAllAddress:
      typeof raw.catchAllAddress === "string" ? raw.catchAllAddress : null,
  }
}

/** Every Domain the registry holds. */
export async function listDomains(call: StalwartCaller): Promise<StalwartDomain[]> {
  return (await listRegistryObjects(call, "Domain")).map(toDomain)
}

/** One domain by exact name, or null. */
async function findDomain(
  call: StalwartCaller,
  name: string,
): Promise<StalwartDomain | null> {
  const wanted = norm(name)
  // ⚠ THE WHOLE LIST, NOT A FILTERED QUERY. Stalwart's `Domain/query` filter
  // semantics are unverified (a text match would also return `notacme.com`),
  // and the registry holds one Domain per hosted name, so listing is cheap and
  // uses the paging path the account sync already proves in production.
  return (await listDomains(call)).find((d) => d.name === wanted) ?? null
}

/** One `x:Domain/set`; a refusal in any of its three result maps is a throw. */
async function setDomain(
  call: StalwartCaller,
  args: { create?: object; update?: object; destroy?: string[] },
): Promise<void> {
  const [, result] = await call([["x:Domain/set", args, "s"]])

  // ⚠ A REFUSED WRITE IS A 200 WITH THE ID UNDER `notCreated`, NOT AN `error`
  // RESPONSE, so the caller's JMAP-error check does not see it. Without this a
  // key missing `sysDomainCreate` would read as a successful reconcile that
  // simply never created anything.
  for (const key of ["notCreated", "notUpdated", "notDestroyed"] as const) {
    const refused = result[key]
    if (refused && typeof refused === "object" && Object.keys(refused).length > 0) {
      const first = Object.values(refused)[0] as
        { type?: unknown; description?: unknown } | undefined
      throw new Error(
        `stalwart refused the domain change: ${key} ${String(first?.type ?? "unknown")} ${String(
          first?.description ?? "",
        )}`.trim(),
      )
    }
  }
}

function newDomain(name: string, catchAllAddress: string | null | undefined) {
  return {
    name,
    description: MANAGED_MARKER,
    enable: true,
    certificateManagement: { "@type": "Manual" },
    dnsManagement: { "@type": "Manual" },
    /*
     * ⚠ `Manual`, WHICH HOLDS NO KEYS, NOT THE DEFAULT `Automatic`. Customer
     * mail is signed by SES: every mailbox domain's route is `ses-relay` (the
     * `dkimSignDomain` rule in plan.ndjson signs only when it is not), and the
     * customer publishes SES's DKIM records. `Automatic` would generate a key
     * pair Stalwart never signs with and, once DNS is ever automated, publish
     * a second selector nobody asked for.
     */
    dkimManagement: { "@type": "Manual" },
    subAddressing: { "@type": "Enabled" },
    ...(typeof catchAllAddress === "string" ? { catchAllAddress } : {}),
  }
}

const createDomain = (
  call: StalwartCaller,
  name: string,
  catchAllAddress?: string | null,
) => setDomain(call, { create: { d: newDomain(norm(name), catchAllAddress) } })

const updateDomain = (call: StalwartCaller, id: string, patch: object) =>
  setDomain(call, { update: { [id]: patch } })

/**
 * Makes sure a domain exists, is ours and is enabled. Creates it when absent;
 * a domain without the marker is reported `unmanaged` and left alone.
 */
export async function ensureDomain(
  call: StalwartCaller,
  name: string,
  opts: EnsureOptions = {},
): Promise<EnsureOutcome> {
  const existing = await findDomain(call, name)

  if (!existing) {
    await createDomain(call, name, opts.catchAllAddress)
    return "created"
  }
  if (!isManaged(existing)) return "unmanaged"

  const patch: Record<string, unknown> = {}
  if (!existing.enable) patch.enable = true
  if (
    opts.catchAllAddress !== undefined &&
    opts.catchAllAddress !== existing.catchAllAddress
  ) {
    patch.catchAllAddress = opts.catchAllAddress
  }
  if (Object.keys(patch).length === 0) return "unchanged"

  await updateDomain(call, existing.id, patch)
  return "updated"
}

/**
 * Stops Stalwart accepting mail and logins for one of our domains. Disables, never
 * destroys: the domain's mail is still in the store, and destroying the object
 * is not a thing to do on the back of a flag. Returns whether it wrote.
 */
export async function disableDomain(
  call: StalwartCaller,
  name: string,
): Promise<boolean> {
  const existing = await findDomain(call, name)
  if (!existing || !isManaged(existing) || !existing.enable) return false

  await updateDomain(call, existing.id, { enable: false })
  return true
}

/**
 * Removes one of our domains from the registry. Nothing calls this on its own:
 * it is for a person who has decided the domain's mail can go. Returns whether
 * it wrote; an unmarked domain is never destroyed.
 */
export async function destroyDomain(
  call: StalwartCaller,
  name: string,
): Promise<boolean> {
  const existing = await findDomain(call, name)
  if (!existing || !isManaged(existing)) return false

  await setDomain(call, { destroy: [existing.id] })
  return true
}

export interface DomainPlan {
  /** Wanted and absent. */
  create: string[]
  /** Ours, wanted and disabled. */
  enable: string[]
  /**
   * Ours, wanted and enabled, whose catch-all differs from `desired` (#406).
   * Only ever filled when `desired` is a Map: a Set says nothing about catch-alls.
   */
  catchAll: string[]
  /** Ours, enabled and no longer wanted. */
  disable: string[]
  /** Wanted and present without our marker; written only with `adopt`. */
  adopt: string[]
  /** Everything else Stalwart holds, `i10.tech` and hand-added domains included. */
  untouched: string[]
}

export interface ReconcileOptions {
  /** Write the plan. Without it the plan is computed and nothing is changed. */
  apply?: boolean
  /**
   * Take over the `adopt` domains: set the marker (and enable them), so they
   * are ours from then on. Only meaningful with `apply`.
   */
  adopt?: boolean
  /** More names to leave alone, beside `PROTECTED_DOMAINS` (our own `MAIL_DOMAINS`). */
  protect?: Iterable<string>
}

export interface ReconcileResult extends DomainPlan {
  /** Writes that were refused or failed; empty in a dry run. */
  failed: { name: string; error: string }[]
}

/**
 * What the reconcile is told to hold: the names alone (no opinion about
 * catch-alls), or each name with its catch-all address, `null` meaning none.
 */
export type DesiredDomains = ReadonlySet<string> | ReadonlyMap<string, string | null>

/**
 * Brings Stalwart's marked domains in line with `desired`, or reports what it
 * would do.
 *
 * ⚠ IT ONLY EVER TOUCHES MARKED DOMAINS, and removes access by disabling. A
 * domain nobody wants any more keeps its mail; it just stops being accepted.
 * Idempotent: once the plan has been applied the next run finds nothing to do.
 *
 * ⚠ A MAP CARRIES CATCH-ALLS, AND DRIFT IN THEM IS CORRECTED THE SAME WAY (#406).
 * The comparison is exact and lowercased: Stalwart holds the address as we
 * wrote it, and a differing case would otherwise be rewritten every run.
 * Protected and unmarked domains never get one written, for the reasons above.
 */
export async function reconcileDomains(
  call: StalwartCaller,
  desired: DesiredDomains,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const catchAlls = new Map<string, string | null>()
  if (desired instanceof Map) {
    for (const [name, address] of desired) {
      catchAlls.set(norm(name), address === null ? null : address.trim().toLowerCase())
    }
  }
  const wantsCatchAll = (name: string) => catchAlls.has(name)
  const want = new Set([...desired.keys()].map(norm))
  const protectedNames = new Set(
    [...PROTECTED_DOMAINS, ...(opts.protect ?? [])].map(norm),
  )
  const existing = await listDomains(call)
  const byName = new Map(existing.map((d) => [d.name, d]))

  const plan: DomainPlan = {
    create: [],
    enable: [],
    catchAll: [],
    disable: [],
    adopt: [],
    untouched: [],
  }

  for (const name of want) {
    if (protectedNames.has(name)) continue
    const domain = byName.get(name)
    if (!domain) plan.create.push(name)
    else if (!isManaged(domain)) plan.adopt.push(name)
    else if (!domain.enable) plan.enable.push(name)
    else if (wantsCatchAll(name) && !sameCatchAll(domain, catchAlls.get(name) ?? null))
      plan.catchAll.push(name)
    else plan.untouched.push(name)
  }

  for (const domain of existing) {
    const handled = want.has(domain.name) && !protectedNames.has(domain.name)
    if (handled) continue
    if (isManaged(domain) && domain.enable && !protectedNames.has(domain.name)) {
      plan.disable.push(domain.name)
    } else {
      plan.untouched.push(domain.name)
    }
  }

  for (const list of Object.values(plan)) list.sort()

  const failed: ReconcileResult["failed"] = []
  if (!opts.apply) return { ...plan, failed }

  // One domain failing must not stop the rest: the names are independent, and
  // the next run retries whatever is left.
  const attempt = async (name: string, write: () => Promise<void>) => {
    try {
      await write()
    } catch (error) {
      failed.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const name of plan.create) {
    await attempt(name, () => createDomain(call, name, catchAlls.get(name)))
  }
  for (const name of plan.enable) {
    await attempt(name, () =>
      updateDomain(call, byName.get(name)!.id, {
        enable: true,
        // ⚠ A re-enabled domain also gets its catch-all right, in the same write.
        ...catchAllPatch(byName.get(name)!, catchAlls, name),
      }),
    )
  }
  for (const name of plan.catchAll) {
    await attempt(name, () =>
      updateDomain(call, byName.get(name)!.id, {
        catchAllAddress: catchAlls.get(name) ?? null,
      }),
    )
  }
  for (const name of plan.disable) {
    await attempt(name, () =>
      updateDomain(call, byName.get(name)!.id, { enable: false }),
    )
  }
  if (opts.adopt) {
    for (const name of plan.adopt) {
      await attempt(name, () =>
        updateDomain(call, byName.get(name)!.id, {
          description: MANAGED_MARKER,
          enable: true,
        }),
      )
    }
  }

  return { ...plan, failed }
}
