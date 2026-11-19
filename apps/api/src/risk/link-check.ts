import { CLEAN, encodeVerdict, isDecisive, type LinkFlag } from "./link-verdict.js"

/**
 * Link checking behind one port (#222): what a provider may answer about a
 * hostname, and the checker that asks every provider the deployment runs.
 *
 * ⚠ AN UNKNOWN ANSWER IS NEVER CLEAN. `unknown` means the provider could not
 * say - no key, no Redis, budget spent, an outage, a case it cannot tell apart -
 * and every caller treats it as "not checked": a link that could not be checked
 * earns no trust, and its host is asked again on the next run.
 *
 * ⚠ `skipped` IS NOT `unknown`. It is a provider declining a name it can never
 * speak about (an IP literal, a single label, a private suffix). It says nothing
 * either way, and a host every provider skips is recorded clean: it is not a
 * public name, so no list can hold it, and leaving it unchecked would let a
 * workspace fill the hourly batch of 100 with names that never resolve.
 */
export type LinkAnswer =
  | { kind: "clean" }
  | { kind: "unsafe"; labels: string[] }
  | { kind: "unknown" }
  | { kind: "skipped" }

export const UNKNOWN: LinkAnswer = { kind: "unknown" }
export const CLEAN_ANSWER: LinkAnswer = { kind: "clean" }
export const SKIPPED: LinkAnswer = { kind: "skipped" }

export interface LinkProvider {
  /** Stable, lowercase: it keys the cache, the health record and the stored verdict. */
  readonly name: string
  /** The cached answer. Never calls out; `unknown` when there is none. */
  cached(host: string): Promise<LinkAnswer>
  /** The cached answer, or a budgeted lookup; `unknown` when neither could say. */
  lookup(host: string): Promise<LinkAnswer>
}

export interface LinkCounts {
  clean: number
  unsafe: number
  unknown: number
  skipped: number
}

export interface LinkChecker {
  /** The stored verdict from cached answers alone. Never calls out. */
  cached(host: string): Promise<string | null>
  /** The stored verdict, asking every provider that has no cached answer; null when it cannot say yet. */
  lookup(host: string): Promise<string | null>
  /** Answers handed back by `lookup` so far in this process, per provider. */
  stats(): Record<string, LinkCounts>
}

/**
 * One verdict out of every provider's answer, or null when the answers are not
 * yet enough to store one.
 *
 * ⚠ STORED ONCE, SO STORED COMPLETE. A host's row is written on its first
 * verdict and never re-asked, so a verdict built while one provider was down
 * would freeze a half-answer: one resolver's block (45 points) recorded while
 * the other, down, would have made it two (90). Unsafe is stored at once only
 * when the flags already decide; otherwise every provider has to have spoken.
 */
export function combine(
  answers: readonly { provider: string; answer: LinkAnswer }[],
): string | null {
  const flags: LinkFlag[] = answers.flatMap(({ provider, answer }) =>
    answer.kind === "unsafe" ? [{ provider, labels: answer.labels }] : [],
  )
  if (flags.length > 0 && isDecisive(flags)) return encodeVerdict(flags)
  if (answers.length === 0 || answers.some((a) => a.answer.kind === "unknown"))
    return null
  return flags.length > 0 ? encodeVerdict(flags) : CLEAN
}

/** A verdict as the trust matcher reads it. */
export const asVerdict = (v: string | null): "clean" | "unsafe" | "unknown" =>
  v === null ? "unknown" : v === CLEAN ? "clean" : "unsafe"

export function linkChecker(providers: readonly LinkProvider[]): LinkChecker {
  const counts = new Map<string, LinkCounts>(
    providers.map((p) => [p.name, { clean: 0, unsafe: 0, unknown: 0, skipped: 0 }]),
  )
  const settle = (p: LinkProvider, ask: () => Promise<LinkAnswer>) =>
    ask()
      .catch((): LinkAnswer => UNKNOWN)
      .then((answer) => ({ provider: p.name, answer }))

  return {
    async cached(host) {
      return combine(
        await Promise.all(providers.map((p) => settle(p, () => p.cached(host)))),
      )
    },

    async lookup(host) {
      const answers = await Promise.all(
        providers.map((p) => settle(p, () => p.lookup(host))),
      )
      for (const { provider, answer } of answers) counts.get(provider)![answer.kind]++
      return combine(answers)
    },

    stats() {
      return Object.fromEntries([...counts].map(([name, c]) => [name, { ...c }]))
    },
  }
}
