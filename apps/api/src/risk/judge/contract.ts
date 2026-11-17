/**
 * What the content judge asks about one email, and the state it asks it about.
 *
 * ⚠ TWO BYTE-IDENTICAL COPIES: apps/api/src/risk/judge/contract.ts and
 * tools/risk-eval/src/judges/contract.ts. The evaluation harness cannot import
 * from the API, and a judge measured on other words is not the judge that
 * runs; apps/api/test/risk-judge.test.ts fails when the two files differ.
 *
 * ⚠ THE QUESTIONS, THEIR IDS AND THEIR ORDER SHIP EXACTLY AS MEASURED. The
 * model is shown each question's id and position, so renaming, reordering or
 * rewording one is a different judge: change `JUDGE_CONTRACT` with it, and
 * measure it again (docs/decisions/risk.md, "The content judge").
 *
 * ⚠ THE EMAIL IS ATTACKER-WRITTEN DATA. It travels only inside `state.email`,
 * a JSON field of its own, and never inside a question's instructions; the
 * instructions are ours and fixed. Every field is capped well inside the
 * smallest context window (clef-flash, 24,576 tokens), and a cut is recorded
 * in `truncated`, never made silently.
 *
 * ⚠ NO FACTS ABOUT OUR OWN ACCOUNT IN THE STATE. Saying the sender domain was
 * verified by the sending account made the model trust the sender.
 */
export const JUDGE_QUESTION_IDS = [
  "imp_short",
  "imp_any",
  "domain_altered",
  "mailbox",
  "cred_short",
  "phish_short",
  "scam",
  "spam_short",
  "marketing_short",
] as const

export type JudgeQuestion = (typeof JUDGE_QUESTION_IDS)[number]

/**
 * The version of the questions plus the state. Judgements are stored under
 * `model#JUDGE_CONTRACT`, so answers to other questions are never read as
 * answers to these. Raise it with any change to either.
 */
export const JUDGE_CONTRACT = 2

/** A yes/no question as System One defines it: the answer is P(yes). */
export interface NoulQuestion {
  type: "noul"
  instructions: string
  criteria: { true: string; false: string }
}

export const JUDGE_QUESTIONS: Readonly<Record<JudgeQuestion, NoulQuestion>> = {
  imp_short: {
    type: "noul",
    instructions:
      "Does this email claim to come from an organisation that `email.sender_domain` does not belong to?",
    criteria: {
      true: "claims to be an organisation whose real domain is not the sender domain",
      false:
        "the sender domain belongs to the organisation it claims to be, or it claims to be no organisation",
    },
  },
  imp_any: {
    type: "noul",
    instructions:
      "Does this email present itself as coming from an organisation, well known or not, whose own domain is different from `email.sender_domain`? Compare the organisation's name with the sender domain. A domain that only resembles the name (digits or other characters swapped for letters, or the name with words such as secure, verify, login, account, billing or support attached) does not belong to it. A domain or subdomain the organisation owns does belong to it.",
    criteria: {
      true: "the sender domain is not the organisation's own domain",
      false:
        "the sender domain is the organisation's own domain, or the email names no organisation as its sender",
    },
  },
  domain_altered: {
    type: "noul",
    instructions:
      "Is `email.sender_domain` an altered copy of the organisation name used in the email: digits or other characters swapped for letters, or extra words such as secure, verify, login, account, billing, support or help attached to the name?",
    criteria: {
      true: "the sender domain is an altered copy of the organisation's name",
      false:
        "the sender domain is the plain name of the organisation, or is unrelated to any name in the email",
    },
  },
  mailbox: {
    type: "noul",
    instructions:
      "Does this email present itself as coming from the recipient's own email service, IT department or mail administrator (mailbox full, password expiring, messages held back, account to be deactivated or verified) while `email.sender_domain` is not the recipient's own domain `email.recipient_domain`?",
    criteria: {
      true: "poses as the recipient's own mail service or IT department from a different domain",
      false:
        "does not pose as the recipient's mail service or IT department, or is sent from the recipient's own domain",
    },
  },
  cred_short: {
    type: "noul",
    instructions:
      "Does this email ask the recipient to send or enter a password, a verification code, or card or bank details? Only delivering a code or a password reset link does not count.",
    criteria: {
      true: "asks for credentials or payment details",
      false: "does not",
    },
  },
  phish_short: {
    type: "noul",
    instructions:
      "Is this email phishing? An honest notice from a service to its own user, sent from the service's own domain and linking to its own site, is not phishing, however urgent it sounds.",
    criteria: {
      true: "a deceptive attempt to steal credentials, money or data",
      false: "an honest message",
    },
  },
  scam: {
    type: "noul",
    instructions:
      "Is this email a scam: an advance-fee, lottery, inheritance, investment, romance, job or extortion message that tries to get money or personal data from the recipient?",
    criteria: {
      true: "a scam",
      false: "not a scam",
    },
  },
  spam_short: {
    type: "noul",
    instructions:
      "Is this unsolicited bulk mail that the recipient most likely never asked for?",
    criteria: {
      true: "unsolicited bulk mail",
      false: "mail the recipient plausibly expects",
    },
  },
  marketing_short: {
    type: "noul",
    instructions: "Is this marketing or a newsletter?",
    criteria: {
      true: "promotional or newsletter content",
      false: "transactional, account or personal mail",
    },
  },
}

/** Characters kept per field. 12,000 characters stay under 24K tokens in any script. */
export const MAX_SUBJECT_CHARS = 500
export const MAX_TEXT_CHARS = 12_000
export const MAX_NAME_CHARS = 200
export const MAX_DOMAIN_CHARS = 253
export const MAX_LINK_HOSTS = 25

const HOST = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[:/?#"'\s<>]|$)/gi
const IP_LINK = /https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?=[:/?#"'\s<>]|$)/g
const ANCHOR = /<a\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)[^>]*>(.*?)<\/a>/gis
const BARE_HOST = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/g

/** Registrable domains with two labels after the name. */
const TWO_LEVEL = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.cn",
  "com.tr",
  "co.in",
  "co.id",
  "co.za",
  "com.mx",
  "com.sg",
  "co.nz",
  "com.hk",
  "co.kr",
  "com.sa",
  "com.eg",
])

/** The site a host belongs to: its last two labels, or three under a two-level suffix. */
export function siteOf(host: string): string {
  const p = host.toLowerCase().replace(/\.+$/, "").split(".")
  const n = TWO_LEVEL.has(p.slice(-2).join(".")) && p.length >= 3 ? 3 : 2
  return p.slice(-n).join(".")
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

function unescapeHtml(s: string): string {
  return s.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (m, dec, hex, name) => {
      if (name) return NAMED[name] ?? m
      const code = dec ? Number(dec) : parseInt(hex, 16)
      return code <= 0x10ffff ? String.fromCodePoint(code) : m
    },
  )
}

const firstHost = (s: string) => [...s.matchAll(HOST)][0]?.[1]

/** Where an email's links go, relative to its sender: facts the model cannot work out from text. */
export interface LinkEvidence {
  links: { host: string; same_site_as_sender: boolean | null }[]
  links_to_other_sites: number | null
  links_shown_as_one_site_but_going_to_another: number
  links_to_bare_ip_addresses: number
  /** More hosts were linked than `MAX_LINK_HOSTS`. */
  cut: boolean
}

export function linkEvidence(
  html: string | null,
  text: string,
  senderDomain: string | null,
): LinkEvidence {
  const source = `${html ?? ""}\n${text}`
  const all = [
    ...new Set(
      [...source.matchAll(HOST)].map((m) => m[1]!.toLowerCase().replace(/\.+$/, "")),
    ),
  ]
  const hosts = all.slice(0, MAX_LINK_HOSTS)
  const mine = senderDomain ? siteOf(senderDomain) : null
  let shownElsewhere = 0
  for (const [, href, label] of (html ?? "").matchAll(ANCHOR)) {
    const shownText = unescapeHtml(label!.replace(/<[^>]+>/g, ""))
    const shown =
      firstHost(`${shownText} `) ??
      [...shownText.toLowerCase().matchAll(BARE_HOST)][0]?.[1]
    const real = firstHost(`${href} `)
    if (shown && real && siteOf(shown) !== siteOf(real)) shownElsewhere++
  }
  return {
    links: hosts.map((host) => ({
      host,
      same_site_as_sender: mine ? siteOf(host) === mine : null,
    })),
    links_to_other_sites: mine ? hosts.filter((h) => siteOf(h) !== mine).length : null,
    links_shown_as_one_site_but_going_to_another: shownElsewhere,
    links_to_bare_ip_addresses: new Set([...source.matchAll(IP_LINK)].map((m) => m[1]))
      .size,
    cut: all.length > hosts.length,
  }
}

/** One email, as the judge is given it. */
export interface JudgeEmail {
  subject: string
  /** The body as plain text. */
  text: string
  /** The HTML body, where there is one: the links' anchors are read from it. */
  html: string | null
  /** The display name of the From address, if any. */
  senderName: string | null
  /** The domain of the From address. */
  senderDomain: string | null
  /** The Reply-To domain, only when it differs from the sender's. */
  replyToDomain: string | null
  /** The domain of the first recipient, lower-cased. */
  recipientDomain: string | null
}

export interface JudgeState {
  email: {
    sender_name: string | null
    sender_domain: string | null
    reply_to_domain: string | null
    subject: string
    text: string
    links: { host: string; same_site_as_sender: boolean | null }[]
    links_to_other_sites: number | null
    links_shown_as_one_site_but_going_to_another: number
    links_to_bare_ip_addresses: number
    recipient_domain: string | null
  }
  /** True when any field above was cut to its cap. */
  truncated: boolean
}

/** At most `max` characters, never splitting a character in two. */
function cut(value: string, max: number): [string, boolean] {
  if (value.length <= max) return [value, false]
  const chars = Array.from(value)
  return chars.length <= max ? [value, false] : [chars.slice(0, max).join(""), true]
}

/** The state the judge is asked about. Whitespace runs collapse to one space. */
export function judgeState(email: JudgeEmail): JudgeState {
  let truncated = false
  const field = (value: string | null, max: number): string | null => {
    if (value === null) return null
    const [kept, wasCut] = cut(value, max)
    truncated ||= wasCut
    return kept
  }
  const evidence = linkEvidence(email.html, email.text, email.senderDomain)
  truncated ||= evidence.cut
  const state: JudgeState["email"] = {
    sender_name: field(email.senderName, MAX_NAME_CHARS),
    sender_domain: field(email.senderDomain, MAX_DOMAIN_CHARS),
    reply_to_domain: field(email.replyToDomain, MAX_DOMAIN_CHARS),
    subject: field(email.subject, MAX_SUBJECT_CHARS) ?? "",
    text: field(email.text.replace(/\s+/g, " ").trim(), MAX_TEXT_CHARS) ?? "",
    links: evidence.links.map((l) => ({
      host: field(l.host, MAX_DOMAIN_CHARS) ?? "",
      same_site_as_sender: l.same_site_as_sender,
    })),
    links_to_other_sites: evidence.links_to_other_sites,
    links_shown_as_one_site_but_going_to_another:
      evidence.links_shown_as_one_site_but_going_to_another,
    links_to_bare_ip_addresses: evidence.links_to_bare_ip_addresses,
    recipient_domain: field(email.recipientDomain, MAX_DOMAIN_CHARS),
  }
  return { email: state, truncated }
}
