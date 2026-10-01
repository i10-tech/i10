/*
 * Real entries, taken from the repository's history. The changelog teaser,
 * the nav card and /changelog all read this list, so the site never claims a
 * feature the product has not shipped.
 */
export interface ChangelogEntry {
  date: string
  title: string
  summary: string
  tag: "Templates" | "Sending" | "Storage" | "Console" | "Deliverability" | "Security"
  pr?: number
}

export const changelog: ChangelogEntry[] = [
  {
    date: "2026-09-30",
    title: "GitHub-connected templates",
    summary:
      "Point a template at a repository. A push to the target branch renders a new version and makes it live.",
    tag: "Templates",
    pr: 235,
  },
  {
    date: "2026-09-30",
    title: "Visual templates with the React Email editor",
    summary:
      "Design in a visual editor that writes React Email, with images in a content-addressed bucket per workspace.",
    tag: "Templates",
    pr: 243,
  },
  {
    date: "2026-09-30",
    title: "Header injection refused at the edge",
    summary:
      "CR and LF in addresses and raw header names are rejected by the contract and again by the MIME builder.",
    tag: "Security",
    pr: 189,
  },
  {
    date: "2026-09-30",
    title: "Template thumbnails",
    summary:
      "The console lists templates as a grid of rendered previews, so the one you want is the one you can see.",
    tag: "Templates",
    pr: 249,
  },
  {
    date: "2026-09-30",
    title: "Rendered once, filled on send",
    summary:
      "A template version is rendered once in a sandbox. Sending only substitutes variables, so a template send costs what a plain send does.",
    tag: "Templates",
    pr: 239,
  },
  {
    date: "2026-09-30",
    title: "Upload a folder of templates",
    summary:
      "Drop a folder of React Email files and each one becomes a versioned template in one go.",
    tag: "Templates",
    pr: 237,
  },
  {
    date: "2026-09-30",
    title: "React Email templates",
    summary:
      "Write templates as React Email components. Every save is a new version with its own preview.",
    tag: "Templates",
    pr: 233,
  },
  {
    date: "2026-09-29",
    title: "Full bodies in sealed R2 packs",
    summary:
      "Message bodies are sealed into per-workspace packs and only released from Postgres after a read-back.",
    tag: "Storage",
    pr: 188,
  },
  {
    date: "2026-09-29",
    title: "Inline images by Content-ID",
    summary:
      "Reference attachments with cid: or pass data URIs; i10 builds the multipart/related tree for you.",
    tag: "Sending",
    pr: 168,
  },
  {
    date: "2026-09-29",
    title: "Usage ring in the console",
    summary:
      "One glanceable ring for the month's sending, replacing the bar and the pill.",
    tag: "Console",
    pr: 153,
  },
  {
    date: "2026-09-29",
    title: "Attachment retention by plan",
    summary:
      "Attachments live in R2 per workspace and are kept for 3 days on Free and 30 days on paid plans.",
    tag: "Storage",
    pr: 225,
  },
  {
    date: "2026-09-29",
    title: "A risk engine for abuse",
    summary:
      "Holds and an hourly risk score keep one bad sender from hurting the reputation everyone else sends on.",
    tag: "Security",
    pr: 221,
  },
  {
    date: "2026-09-28",
    title: "Per-workspace suppression lists",
    summary:
      "Suppressions with an API, an export and a complaint guard, isolated per workspace.",
    tag: "Deliverability",
    pr: 159,
  },
  {
    date: "2026-09-28",
    title: "Every SES event, published",
    summary:
      "Delivery, bounce, complaint, open, click and more, with per-domain open and click tracking.",
    tag: "Sending",
  },
  {
    date: "2026-09-28",
    title: "Sending health per domain",
    summary:
      "Reputation findings and daily sending-health snapshots are tracked for every workspace.",
    tag: "Deliverability",
    pr: 215,
  },
  {
    date: "2026-09-28",
    title: "Paused sending, explained",
    summary:
      "If sending is paused, the API refuses with a clear error, the console shows a banner and the owner gets an email.",
    tag: "Deliverability",
    pr: 214,
  },
]

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/* "30 Sep 2026". Written out rather than Intl, whose en-GB short month is "Sept". */
export const formatDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`
}
