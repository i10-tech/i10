import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("en")

/**
 * Legitimate marketing: product news and changelogs. Each carries an
 * unsubscribe line (added by the renderer) and says plainly what it is.
 */
export const EN_MARKETING: Template[] = [
  // newsletter
  t(
    "newsletter",
    "consumer-friendly",
    [
      "What's new at {product}",
      "{product} news: [[spring|summer|autumn|winter]] update",
    ],
    [
      "Hi {first},",
      "Here's what the {product} team has been up to this season.",
      {
        list: [
          "A faster way to find things, with search that understands what you mean",
          "Shared folders, so a whole team can work from one place",
          "A calmer home screen, with fewer notifications by default",
        ],
      },
      { cta: "Read the full story", url: "{link:blog}" },
      "As always, you can reply to this email, we read everything.",
    ],
  ),
  t(
    "newsletter",
    "dev-terse",
    ["{product} product update", "{product} newsletter: what shipped"],
    [
      "A short summary of what shipped in the last month:",
      {
        list: [
          "Faster cold starts for new projects",
          "A new audit log with CSV export",
          "Better error messages when a deploy fails",
        ],
      },
      { cta: "Read the details", url: "{link:blog}" },
    ],
  ),
  t(
    "newsletter",
    "small-shop",
    ["New this month at {product}", "A note from the {product} workshop"],
    [
      "Hi {first},",
      "The [[season|month]] has been busy in the workshop. We've made new batches, brought back a few favourites and tidied up the shop.",
      {
        list: [
          "Small-batch candles, back in stock",
          "A new range of linen goods",
          "Free shipping on orders over a set amount until the end of the month",
        ],
      },
      { cta: "Visit the shop", url: "{link:shop}" },
      "Thank you for being one of our customers.",
    ],
  ),
  t(
    "newsletter",
    "formal-bank",
    ["Your {product} update", "{product}: news for customers"],
    [
      "Dear {name},",
      "We would like to tell you about some changes to our services this quarter.",
      {
        list: [
          "Extended opening hours at selected branches",
          "A clearer layout for your monthly statements",
          "New tools in the app to help you plan your spending",
        ],
      },
      { cta: "Find out more", url: "{link:news}" },
      "This message does not ask you for any personal information. {product} will never ask for your password or PIN by email.",
      "Yours sincerely,\n{product}",
    ],
  ),

  // changelog
  t(
    "changelog",
    "dev-terse",
    ["{product} {version} released", "Changelog: {product} {version}"],
    [
      "{product} {version} is out.",
      {
        list: [
          "Added: saved filters in the dashboard",
          "Improved: webhook retries now back off up to one hour",
          "Fixed: a rare timeout when exporting large reports",
          "Deprecated: the v1 events endpoint, removal planned for next quarter",
        ],
      },
      { cta: "Read the full changelog", url: "{link:changelog}" },
    ],
  ),
  t(
    "changelog",
    "consumer-friendly",
    ["New in {product}: version {version}", "{product} just got better"],
    [
      "Hi {first},",
      "We've just released version {version}. Highlights:",
      {
        list: [
          "Dark mode now follows your device setting",
          "Faster loading on slow connections",
          "Lots of small fixes you told us about",
        ],
      },
      { cta: "See everything that changed", url: "{link:changelog}" },
      "Thanks to everyone who sent feedback.",
    ],
  ),
  t(
    "changelog",
    "dev-terse",
    ["Release notes {version}", "{product} platform changes for {date}"],
    [
      "Platform changes effective {date}:",
      {
        list: [
          "API responses now include a request-id header",
          "The rate limit for the free tier is unchanged",
          "Node 18 support ends in {days} days",
        ],
      },
      { cta: "Release notes", url: "{link:changelog}" },
      "You are receiving this because you opted in to product announcements.",
    ],
  ),
]
