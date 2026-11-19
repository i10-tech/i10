import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("en")

/** Invitations, welcome mail, API keys and account closure. */
export const EN_ACCOUNT: Template[] = [
  // team-invitation
  t(
    "team-invitation",
    "dev-terse",
    ["{inviter} invited you to {team} on {product}", "Invitation to join {team}"],
    [
      "{inviter} invited {email} to join the {team} workspace on {product}.",
      { cta: "Accept invitation", url: "{link:invite}" },
      "The invitation expires in {days} days. If you do not know {inviter} you can ignore this email.",
    ],
  ),
  t(
    "team-invitation",
    "consumer-friendly",
    ["{inviter} wants you on {team}", "You're invited to {team} on {product}"],
    [
      "Hi there,",
      "{inviter} has invited you to collaborate in {team} on {product}. Join to see what the team is working on.",
      { cta: "Join {team}", url: "{link:invite}" },
      "Not expecting this? You can ignore this email, or tell {inviter} you'd rather not join.",
    ],
  ),
  t(
    "team-invitation",
    "formal-bank",
    [
      "Invitation to access {team} on {product}",
      "{product}: you have been invited to {team}",
    ],
    [
      "Dear colleague,",
      "{inviter} has invited you to access the {team} business account on {product}. You will need to verify your identity before you can view any information.",
      { cta: "View invitation", url: "{link:invite}" },
      "This invitation is valid for {days} days. If you were not expecting it, do not follow the link; contact {inviter} directly to confirm.",
      "Yours sincerely,\n{product} Business Services",
    ],
  ),
  t(
    "team-invitation",
    "small-shop",
    ["{inviter} added you to {team}", "Join {team} on {product}"],
    [
      "Hi,",
      "{inviter} invited you to help manage the {team} store on {product}.",
      { cta: "Accept the invite", url: "{link:invite}" },
      "The invite is valid for {days} days.",
    ],
  ),

  // welcome
  t(
    "welcome",
    "dev-terse",
    ["Welcome to {product}", "Your {product} account is ready"],
    [
      "Your account {email} is ready.",
      {
        list: [
          "Create an API key in the dashboard",
          "Read the quickstart",
          "Invite your team",
        ],
      },
      { cta: "Open the dashboard", url: "{link:dashboard}" },
      "Stuck? Reply to this email or write to {support}.",
    ],
  ),
  t(
    "welcome",
    "consumer-friendly",
    ["Welcome to {product}, {first}!", "You're in! Here's how to get started"],
    [
      "Hi {first},",
      "Welcome to {product}! We're so glad you're here.",
      "Here are three things to try first:",
      {
        list: [
          "Add your first item",
          "Invite a friend or teammate",
          "Download the app for your phone",
        ],
      },
      { cta: "Get started", url: "{link:start}" },
      "If you have any questions, just reply, a real person reads every message.",
    ],
  ),
  t(
    "welcome",
    "formal-bank",
    [
      "Welcome to {product} online services",
      "Your {product} online profile is now active",
    ],
    [
      "Dear {name},",
      "Thank you for registering for {product} online services. Your profile is now active.",
      "To keep your account secure we recommend that you turn on two-step verification and review your notification settings.",
      { cta: "Go to your profile", url: "{link:dashboard}" },
      "{product} will never ask you for your password or PIN by email. If you receive a message that does, please forward it to {support}.",
      "Yours sincerely,\n{product} Customer Services",
    ],
  ),
  t(
    "welcome",
    "small-shop",
    ["Welcome to {product}", "Thanks for joining {product}, {first}"],
    [
      "Hi {first},",
      "Thanks for creating an account with {product}. We make everything in small batches and we're happy to have you.",
      "Your account lets you track orders, save favourites and check out faster.",
      { cta: "Start browsing", url: "{link:shop}" },
      "Warmly,\nThe {product} team",
    ],
  ),

  // api-key-created
  t(
    "api-key-created",
    "dev-terse",
    ["New API key created: {key_name}", "{product}: API key created"],
    [
      "An API key named {key_name} was created on {date} by {email}.",
      {
        rows: [
          ["Key", "{key_hint}"],
          ["Scope", "read and write"],
          ["Created", "{date}, {time}"],
        ],
      },
      "The full key is shown only once, at creation. If you did not create this key, revoke it now:",
      { cta: "Manage API keys", url: "{link:keys}" },
    ],
  ),
  t(
    "api-key-created",
    "dev-terse",
    ["API key added to {team}", "{product} security: new API key"],
    [
      "A new API key ({key_hint}) was added to {team}.",
      "Keys can send mail on behalf of your account, so treat them like passwords and never commit them to a repository.",
      { cta: "Review keys", url: "{link:keys}" },
    ],
  ),
  t(
    "api-key-created",
    "consumer-friendly",
    ["You created a new API key", "A new key was added to your {product} account"],
    [
      "Hi {first},",
      "You just created an API key called {key_name}. We're letting you know so there are no surprises.",
      "Keep it private, and if it ever gets shared by accident you can revoke it from your settings.",
      { cta: "Manage my keys", url: "{link:keys}" },
      "If you didn't create this key, revoke it right away and change your password.",
    ],
  ),

  // account-deletion
  t(
    "account-deletion",
    "dev-terse",
    ["Your {product} account was deleted", "{product}: deletion confirmed"],
    [
      "The account {email} and its data were deleted on {date}.",
      "Backups are purged within {days} days. This cannot be undone.",
      "If you did not request this, write to {support} immediately.",
    ],
  ),
  t(
    "account-deletion",
    "consumer-friendly",
    ["We've deleted your {product} account", "Sorry to see you go"],
    [
      "Hi {first},",
      "As you asked, we've deleted your {product} account and the content in it.",
      "If this was a mistake, you have {days} days to change your mind:",
      { cta: "Restore my account", url: "{link:restore}" },
      "Thanks for trying {product}. You're always welcome back.",
    ],
  ),
  t(
    "account-deletion",
    "formal-bank",
    [
      "Confirmation of account closure",
      "{product}: your online profile has been closed",
    ],
    [
      "Dear {name},",
      "We confirm that your {product} online profile was closed on {date} at your request.",
      "Statements and records are kept for the period required by law. If you did not request this closure, please call us immediately on the number printed on your card.",
      "Yours sincerely,\n{product} Customer Services",
    ],
  ),
]
