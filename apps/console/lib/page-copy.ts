/**
 * Each list page's title and description, in one place: the page and its
 * loading skeleton (components/skeletons) both read them, so the skeleton
 * shows the same words the page will and they cannot drift apart.
 */
export const PAGE_COPY = {
  apiKeys: {
    title: "API keys",
    description:
      "Keys authenticate your servers. They are shown once when created and stored only as a hash - if you lose one, rotate it rather than looking for it.",
  },
  broadcasts: {
    title: "Broadcasts",
    description:
      "One email to a segment. Delivery, bounces and complaints are reported the same way as any other send.",
  },
  contacts: {
    title: "Contacts",
    description:
      "One row per person, however many segments they are in. Unsubscribing is recorded once and honoured everywhere.",
  },
  domains: {
    title: "Domains",
    description:
      "Mail leaves from a domain you control. Publish the records we issue, or delegate three subdomains to us and never think about them again.",
  },
  emails: {
    title: "Emails",
    description: "Every message this workspace has sent, with what happened to it.",
  },
  logs: {
    title: "Logs",
    description:
      "Requests your servers have made to the API, with what we answered. Bodies are never recorded - they contain your customers’ mail.",
  },
  mailboxes: {
    title: "Mailboxes",
    description:
      "Real IMAP mailboxes on your own domains - one address, one password, the same account you sign in with.",
  },
  segments: {
    title: "Segments",
    description:
      "Groups you target a broadcast at. Recipients never see them - that is what topics are for.",
  },
  suppressions: {
    title: "Suppressions",
    description:
      "Addresses that hard-bounced or complained, plus any you have added by hand. We skip them rather than sending and damaging your reputation. This list is yours alone: another workspace's bounces never land here.",
  },
  topics: {
    title: "Topics",
    description:
      "The choices a recipient gets on their preference page. Their answer here is binding on every broadcast that names the topic.",
  },
  webhooks: {
    title: "Webhooks",
    description:
      "Every event about your mail, signed so you can verify it came from us: posted to your URL, sent to an SQS queue, or held for you to fetch. Failed deliveries are retried with backoff.",
  },
  templates: {
    title: "Templates",
    description:
      "Write emails in the editor or upload React Email files, then send them by id or alias. Nothing changes what is going out until it is published, and any earlier version can be made live again.",
  },
} as const
