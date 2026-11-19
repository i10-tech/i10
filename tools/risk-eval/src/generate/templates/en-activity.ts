import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("en")

/** Everyday activity mail: bookings, support, comments, digests, exports. */
export const EN_ACTIVITY: Template[] = [
  // booking-confirmation
  t(
    "booking-confirmation",
    "small-shop",
    ["Your appointment is confirmed", "Booking confirmed: {service} on {appt_date}"],
    [
      "Hi {first},",
      "Your booking at {place} is confirmed.",
      {
        rows: [
          ["Service", "{service}"],
          ["Date", "{appt_date}"],
          ["Time", "{appt_time}"],
          ["With", "{provider}"],
        ],
      },
      "Need to change it? Use the link below at least 24 hours before your appointment.",
      { cta: "Reschedule or cancel", url: "{link:booking}" },
    ],
  ),
  t(
    "booking-confirmation",
    "consumer-friendly",
    ["You're booked in!", "See you on {appt_date}"],
    [
      "Hi {first},",
      "Great, you're booked for {service} at {place} on {appt_date} at {appt_time}.",
      "We'll send a reminder the day before.",
      { cta: "Add to calendar", url: "{link:calendar}" },
    ],
  ),
  t(
    "booking-confirmation",
    "formal-bank",
    ["Confirmation of your appointment", "{product}: appointment on {appt_date}"],
    [
      "Dear {name},",
      "This email confirms your appointment with {provider} at {place}.",
      {
        rows: [
          ["Date", "{appt_date}"],
          ["Time", "{appt_time}"],
          ["Reason", "{service}"],
        ],
      },
      "Please bring photographic identification. If you can no longer attend, let us know at least one working day in advance.",
      { cta: "Manage appointment", url: "{link:booking}" },
      "Yours sincerely,\n{product} Appointments",
    ],
  ),

  // support-reply
  t(
    "support-reply",
    "dev-terse",
    ["Re: {ticket_subject} [{ticket}]", "{product} support: update on {ticket}"],
    [
      "{agent} replied to your ticket {ticket}:",
      "Thanks for the report. I reproduced this on our side and a fix is going out in the next release. I will update this ticket when it ships.",
      { cta: "View ticket", url: "{link:tickets}" },
      "You can reply to this email to add information to the ticket.",
    ],
  ),
  t(
    "support-reply",
    "consumer-friendly",
    ["{agent} from {product} replied to your question", "We've answered your request"],
    [
      "Hi {first},",
      '{agent} from the {product} team just replied to "{ticket_subject}".',
      '"Thanks for getting in touch! I\'ve taken a look and sorted this out for you. Let me know if anything still looks off."',
      { cta: "See the full reply", url: "{link:tickets}" },
      "Was this helpful? Just reply and tell us.",
    ],
  ),
  t(
    "support-reply",
    "small-shop",
    ["Re: your message to {product}", "Our reply about {ticket}"],
    [
      "Hi {first},",
      "Thanks for writing in. {agent} here, I've looked into {ticket} and added a note for you.",
      { cta: "Read our reply", url: "{link:tickets}" },
      "Reply to this email if there's anything else.",
    ],
  ),

  // comment-mention
  t(
    "comment-mention",
    "dev-terse",
    ["{actor} mentioned you in {doc}", "[{team}] new comment on {doc}"],
    [
      '{actor} mentioned you in a comment on "{doc}":',
      "> {comment}",
      { cta: "Open comment", url: "{link:comments}" },
      "Mute this thread in your notification settings.",
    ],
  ),
  t(
    "comment-mention",
    "consumer-friendly",
    ["{actor} mentioned you", "New comment from {actor}"],
    [
      "Hi {first},",
      "{actor} mentioned you in {project}:",
      '"{comment}"',
      { cta: "Reply", url: "{link:comments}" },
      "You can change how often we email you in your notification settings.",
    ],
  ),
  t(
    "comment-mention",
    "small-shop",
    ["{actor} left a note on {doc}", "New note on {doc}"],
    [
      "Hi {first},",
      "{actor} commented on {doc}:",
      '"{comment}"',
      { cta: "View note", url: "{link:comments}" },
    ],
  ),

  // weekly-digest
  t(
    "weekly-digest",
    "dev-terse",
    ["Your weekly {product} summary", "{team}: week in review"],
    [
      "This week on {team}:",
      {
        list: [
          "{n1} deploys, {n2} failed",
          "{n3} new comments",
          "{n2} pull requests merged",
        ],
      },
      { cta: "Open the dashboard", url: "{link:dashboard}" },
    ],
  ),
  t(
    "weekly-digest",
    "consumer-friendly",
    ["Your week in {product}", "Here's what you missed this week"],
    [
      "Hi {first},",
      "Here's a quick look at your week:",
      {
        list: [
          "{n1} new items added",
          "{n2} things marked as done",
          "{n3} updates from people you follow",
        ],
      },
      { cta: "Catch up", url: "{link:dashboard}" },
      "Have a great week!",
    ],
  ),
  t(
    "weekly-digest",
    "small-shop",
    ["This week at {product}", "Your weekly update from {product}"],
    [
      "Hi {first},",
      "A short note on what's happening this week: {n1} new arrivals, {n2} restocks and {n3} items back by popular request.",
      { cta: "See what's new", url: "{link:shop}" },
    ],
  ),

  // export-ready
  t(
    "export-ready",
    "dev-terse",
    ["Your export is ready", "{product}: {report} ({fmt}) is ready"],
    [
      'The export "{report}" ({fmt}, {size}) is ready to download.',
      { cta: "Download", url: "{link:exports}" },
      "The link is available for {days} days and requires you to be signed in.",
    ],
  ),
  t(
    "export-ready",
    "consumer-friendly",
    ["Your data export is ready to download", "{report} is ready"],
    [
      "Hi {first},",
      "The file you asked for is ready: {report} as {fmt}, {size}.",
      { cta: "Download my file", url: "{link:exports}" },
      "For your privacy the link expires in {days} days, and you'll need to sign in to open it.",
    ],
  ),
  t(
    "export-ready",
    "formal-bank",
    ["Your requested statement is available", "{product}: document ready for download"],
    [
      "Dear {name},",
      "The document you requested ({report}, {fmt}) is now available in your online profile.",
      { cta: "Sign in to download", url: "{link:exports}" },
      "For security reasons, the document is not attached to this email. It will remain available for {days} days.",
      "Yours sincerely,\n{product} Customer Services",
    ],
  ),
]
