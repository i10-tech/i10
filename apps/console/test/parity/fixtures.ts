/**
 * Small builders for the data each page loads. Every one takes the TAG that
 * the case is built from, and puts it in all of its free text (see cases.tsx).
 */

export const iso = (daysAgo: number) =>
  new Date(Date.UTC(2026, 10, 1 - daysAgo)).toISOString()

/** `n` rows from `make(i)`. */
export const rows = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i))

/**
 * A copy of `value` with `tag` appended to every string stored under one of
 * `keys`, at any depth: preview fixtures reused as a tagged dataset, without
 * touching the enums the shape reads.
 */
export function retext<T>(value: T, tag: string, keys: string[]): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string")
      return key !== undefined && keys.includes(key) ? `${v}-${tag}` : v
    if (Array.isArray(v)) return v.map((x) => walk(x, key))
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    }
    return v
  }
  return walk(value) as T
}

export function domain(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    object: "domain" as const,
    id: `dom_${tag}${i}`,
    name: `${tag}${i}.example.com`,
    status: "verified",
    created_at: iso(i + 1),
    region: "us-east-1",
    delegated: false,
    ...over,
  }
}

export function apiKey(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `key_${tag}${i}`,
    name: `${tag} key ${i}`,
    prefix: `ak_${tag}${i}`,
    mode: "live",
    scopes: ["emails:send"],
    domains: [],
    created_at: iso(i + 2),
    last_used_at: iso(i),
    expires_at: null,
    revoked_at: null,
    created_by: {
      id: `usr_${tag}`,
      name: `${tag} person`,
      email: `${tag}@example.com`,
    },
    can_rotate: true,
    can_revoke: true,
    can_edit: true,
    ...over,
  }
}

export function email(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `em_${tag}${i}`,
    created_at: iso(i),
    from: `${tag}@example.com`,
    to: [`${tag}${i}@example.org`],
    subject: `${tag} subject ${i}`,
    status: "delivered",
    last_event: "delivered",
    scheduled_at: null,
    sent_at: iso(i),
    last_error: null,
    ...over,
  }
}

export function contact(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `con_${tag}${i}`,
    email: `${tag}${i}@example.com`,
    first_name: `${tag}first${i}`,
    last_name: `${tag}last${i}`,
    unsubscribed: false,
    properties: null,
    created_at: iso(i + 1),
    ...over,
  }
}

export function segment(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `seg_${tag}${i}`,
    name: `${tag} segment ${i}`,
    description: `${tag} description ${i}`,
    contact_count: 10 + i,
    created_at: iso(i + 1),
    ...over,
  }
}

export function topic(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `top_${tag}${i}`,
    name: `${tag} topic ${i}`,
    description: `${tag} description ${i}`,
    default_subscription: "opt_in",
    visibility: "public",
    subscriber_count: 3 + i,
    created_at: iso(i + 1),
    ...over,
  }
}

export function broadcast(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `bc_${tag}${i}`,
    segment_id: `seg_${tag}0`,
    segment_name: `${tag} segment`,
    topic_id: null,
    name: `${tag} broadcast ${i}`,
    from: `${tag}@example.com`,
    reply_to: [],
    subject: `${tag} subject ${i}`,
    preview_text: null,
    status: "draft",
    scheduled_at: null,
    sent_at: null,
    recipient_count: null,
    created_at: iso(i + 1),
    ...over,
  }
}

export function suppression(tag: string, i: number) {
  return {
    address: `${tag}${i}@example.com`,
    reason: "bounce",
    message_id: null,
    created_at: iso(i + 1),
  }
}

export function request(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `req_${tag}${i}`,
    method: "POST",
    path: `/emails/${tag}${i}`,
    status: 200,
    duration_ms: 40 + i,
    error_name: null,
    user_agent: `${tag}-agent`,
    api_key_id: null,
    occurred_at: iso(i),
    ...over,
  }
}

export function template(tag: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: `tpl_${tag}${i}`,
    name: `${tag}-template-${i}`,
    title: `${tag} template ${i}`,
    folder_id: null,
    from: null,
    reply_to: null,
    preview_text: null,
    variables: [],
    kind: "html" as const,
    source: "managed" as const,
    subject: `${tag} subject ${i}`,
    published_at: iso(i),
    version: 1,
    versions: 1,
    github: null,
    shared: false,
    created_at: iso(i + 3),
    updated_at: iso(i),
    ...over,
  }
}

export function folder(tag: string, i: number) {
  return {
    id: `fol_${tag}${i}`,
    name: `${tag} folder ${i}`,
    parent_id: null as string | null,
    templates: 2,
    folders: 0,
    preview: [0, 1].map((n) => ({ id: `tpl_${tag}${n}`, updated_at: iso(n) })),
    created_at: iso(i + 5),
    updated_at: iso(i + 1),
  }
}

export function installation(tag: string) {
  return {
    installation_id: 1,
    account_login: `${tag}-org`,
    account_type: "Organization",
    suspended: false,
    created_at: iso(10),
  }
}

export function repository(tag: string, i: number, failing = false) {
  return {
    id: `repo_${tag}${i}`,
    installation_id: 1,
    repo_id: 100 + i,
    full_name: `${tag}-org/emails-${i}`,
    target_branch: "main",
    directory: "emails",
    last_commit_sha: "abcdef1234567",
    last_synced_at: iso(1),
    removed: false,
    templates: 2 + i,
    last_sync: {
      status: failing ? "failed" : "done",
      commit_sha: "abcdef1234567",
      problems: failing ? [`${tag} could not render welcome.tsx`] : [],
      outcomes: [],
      finished_at: iso(1),
    },
    created_at: iso(10),
  }
}

export function trusted(tag: string, i: number) {
  return {
    object: "trusted_template" as const,
    id: `tr_${tag}${i}`,
    name: `${tag}-receipt-${i}`,
    status: i === 0 ? ("approved" as const) : ("pending" as const),
    html: null,
    text: null,
    holes: [{ name: `${tag}name`, max: 20 }],
    matched: 12,
    submitted_at: iso(3),
    decided_at: i === 0 ? iso(1) : null,
    decision_reason: null,
  }
}
