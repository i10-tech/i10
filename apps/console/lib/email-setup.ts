import type { DomainSummary } from "@/lib/types"

/**
 * The guided setup on the Mailboxes page: four steps, each with a status read
 * from what the console already loads, and the words that go with it.
 *
 * ⚠ NO NEW API, AND NOTHING GUESSED. Every status comes from a domain's
 * `mailboxes` view (apps/api/src/domains/mailbox-hosting.ts) and the number of
 * mailboxes. Where that view is missing (the API is not wired for it, or the
 * read failed) a step is `unknown`: it gets no tick and says what it cannot
 * tell, instead of showing a tick that may be wrong or a "to do" that may not be.
 *
 * ⚠ ONE DOMAIN TELLS THE WHOLE STORY. Steps one to three are about a single
 * domain, the one furthest along, so "turned on" and "pointed at us" cannot be
 * true of two different names at once. The card names it in every line.
 *
 * ⚠ RECEIVING IS WHAT THE LAST DNS CHECK SAW, not a live lookup. The domain's
 * page checks DNS while it is open and when someone presses Verify; a record
 * published a minute ago can still read as missing here until then.
 */

export type SetupStepId = "domain" | "hosting" | "records" | "mailbox"

export type SetupState = "done" | "todo" | "unknown"

export interface SetupStep {
  id: SetupStepId
  title: string
  /** Why the step exists, in words for someone who has never set up email. Static. */
  help: string
  state: SetupState
  /** What is true right now, one line. */
  status: string
  /** Where it is done. Null where an earlier step has to come first. */
  action: { label: string; href: string } | null
}

export interface EmailSetup {
  steps: SetupStep[]
  /** The domain the first three steps are about. Null when there is none. */
  domain: { id: string; name: string } | null
  /** Whether the domain's sending side is still waiting on its DKIM records. */
  sendingWaiting: boolean
  /** Whether a mailbox can be created now: a domain proven and hosting mail. */
  canCreate: boolean
  done: number
}

export const SETUP_COPY = {
  domain: {
    title: "Add your domain and prove you own it",
    help: "A domain is the part after the @ in an email address, like acme.com. We need to know it is yours before we host mail on it.",
  },
  hosting: {
    title: "Turn on mailbox hosting for it",
    help: "This tells us to accept mail for the domain. It does not move any mail yet.",
  },
  records: {
    title: "Point your mail to us",
    help: "A domain's DNS records decide where its mail goes. Add the ones marked Receiving on the domain's page, under Records. The MX record is the one that names the server that takes in mail. Until you add them, mail keeps going to your old provider, and once you do, new mail arrives here. Create the mailboxes first if you do not want anyone's mail to go missing.",
  },
  mailbox: {
    title: "Create the first mailbox",
    help: "A mailbox is one person's email address on your domain, like sam@acme.com. They read and send from it in any mail app.",
  },
} as const

/** What explains DKIM, said once, where sending is still waiting on it. */
export const DKIM_NOTE =
  "Receiving mail works as soon as the records above are in. Sending from the domain starts once its DKIM records verify. DKIM is a signature that proves a message really came from you, and its records are on the same Records tab."

const NO_DOMAINS: DomainSummary[] = []

/** How far along a domain is, so the furthest one is the one the card follows. */
function progress(domain: DomainSummary): number {
  const view = domain.mailboxes
  if (!view?.owned) return 0
  return 1 + (view.enabled ? 1 : 0) + (view.enabled && view.receiving ? 1 : 0)
}

/** The domain furthest along, ignoring any another workspace has taken. Ties keep the list's order. */
export function focusDomain(domains: readonly DomainSummary[]): DomainSummary | null {
  let best: DomainSummary | null = null
  for (const domain of domains) {
    if (domain.displaced_at) continue
    if (!best || progress(domain) > progress(best)) best = domain
  }
  return best
}

const open = (domain: DomainSummary, label: string) => ({
  label,
  href: `/domains/${encodeURIComponent(domain.id)}`,
})

/**
 * The four steps for a workspace. `domains` is null when the read failed.
 *
 * ⚠ A STEP WHOSE EARLIER STEP IS NOT DONE IS "TO DO" WITH NO ACTION, whatever
 * its own data says: a hosting switch cannot be on for a name that is not yours,
 * and sending someone to turn it on first is how the API's refusal gets read.
 */
export function emailSetup(
  domains: readonly DomainSummary[] | null,
  mailboxCount: number,
): EmailSetup {
  const list = domains ?? NO_DOMAINS
  const domain = focusDomain(list)
  const view = domain?.mailboxes
  const name = domain?.name ?? ""
  const taken = list.length > 0 && domain === null

  // ── 1. The domain, proven ──────────────────────────────────────────────
  let first: SetupStep
  if (domains === null) {
    first = {
      id: "domain",
      ...SETUP_COPY.domain,
      state: "unknown",
      status: "We could not read your domains just now. Open Domains to check.",
      action: { label: "Open domains", href: "/domains" },
    }
  } else if (!domain) {
    first = {
      id: "domain",
      ...SETUP_COPY.domain,
      state: "todo",
      status: taken
        ? "Another workspace now holds every domain added here. Add one you own."
        : "No domain added yet.",
      action: { label: "Add a domain", href: "/domains/new" },
    }
  } else if (!view) {
    first = {
      id: "domain",
      ...SETUP_COPY.domain,
      state: "unknown",
      status: `${name} is added. We cannot tell yet whether you have proved you own it.`,
      action: open(domain, "Open the domain"),
    }
  } else if (!view.owned) {
    first = {
      id: "domain",
      ...SETUP_COPY.domain,
      state: "todo",
      status: `${name} is added, but you have not proved you own it yet.`,
      action: open(domain, "Prove you own it"),
    }
  } else {
    first = {
      id: "domain",
      ...SETUP_COPY.domain,
      state: "done",
      status: `You have proved you own ${name}.`,
      action: null,
    }
  }

  // ── 2. Hosting on ──────────────────────────────────────────────────────
  let second: SetupStep
  if (first.state !== "done" || !domain || !view) {
    second = {
      id: "hosting",
      ...SETUP_COPY.hosting,
      state: first.state === "unknown" ? "unknown" : "todo",
      status: "Comes after step 1.",
      action: null,
    }
  } else if (view.enabled) {
    second = {
      id: "hosting",
      ...SETUP_COPY.hosting,
      state: "done",
      status: `Mailbox hosting is on for ${name}.`,
      action: null,
    }
  } else {
    second = {
      id: "hosting",
      ...SETUP_COPY.hosting,
      state: "todo",
      status: `Mailbox hosting is off for ${name}. On its page, open Configuration and turn on Host mailboxes.`,
      action: open(domain, "Turn it on"),
    }
  }

  // ── 3. The records ─────────────────────────────────────────────────────
  let third: SetupStep
  if (second.state !== "done" || !domain || !view) {
    third = {
      id: "records",
      ...SETUP_COPY.records,
      state: second.state === "unknown" ? "unknown" : "todo",
      status: "Comes after step 2.",
      action: null,
    }
  } else if (view.receiving === undefined) {
    third = {
      id: "records",
      ...SETUP_COPY.records,
      state: "unknown",
      status: `We cannot tell yet where mail for ${name} goes.`,
      action: open(domain, "See the records"),
    }
  } else if (view.receiving) {
    third = {
      id: "records",
      ...SETUP_COPY.records,
      state: "done",
      status: `Mail for ${name} is pointed at us.`,
      action: null,
    }
  } else {
    third = {
      id: "records",
      ...SETUP_COPY.records,
      state: "todo",
      status: `Mail for ${name} still goes to your old provider.`,
      action: open(domain, "See the records"),
    }
  }

  // ── 4. A mailbox ───────────────────────────────────────────────────────
  const canCreate = Boolean(view?.owned && view.enabled)
  const fourth: SetupStep =
    mailboxCount > 0
      ? {
          id: "mailbox",
          ...SETUP_COPY.mailbox,
          state: "done",
          status:
            mailboxCount === 1
              ? "You have 1 mailbox."
              : `You have ${mailboxCount} mailboxes.`,
          action: null,
        }
      : {
          id: "mailbox",
          ...SETUP_COPY.mailbox,
          state: "todo",
          status: canCreate
            ? "No mailbox yet."
            : "Needs a domain that hosts mailboxes, from step 2.",
          // ⚠ THE BUTTON IS THE DIALOG, NOT A LINK: the card renders Create
          // mailbox where this step's action goes (see the component).
          action: null,
        }

  const steps = [first, second, third, fourth]
  return {
    steps,
    domain: domain ? { id: domain.id, name: domain.name } : null,
    // ⚠ ONLY WHERE THE NOTE CAN BE ACTED ON: a domain that is not proven yet has
    // no DKIM records worth talking about.
    sendingWaiting: Boolean(view?.owned && view.enabled && !view.sending),
    canCreate,
    done: steps.filter((step) => step.state === "done").length,
  }
}
