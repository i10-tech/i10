import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("en")

/**
 * Hard negatives: legitimate mail with the surface of phishing. Urgent
 * subjects, a deadline, a brand name, "verify", "suspended", a button. A real
 * service sends all of these, and a judge that flags them as phishing costs
 * honest senders money. They are tagged so the report can break them out.
 */
export const EN_HARD: Template[] = [
  // urgent-security-alert
  t(
    "urgent-security-alert",
    "dev-terse",
    [
      "Security alert: sign-in blocked",
      "Action required: suspicious sign-in on {product}",
    ],
    [
      "We blocked a sign-in attempt to {email} from {location} ({ip}) at {time}.",
      "If this was not you, change your password within {hours} hours and revoke active sessions. If it was you, you can approve the attempt and try again.",
      { cta: "Review and secure account", url: "{link:security}" },
      "{product} staff will never ask for your password or a code by email, chat or phone.",
    ],
  ),
  t(
    "urgent-security-alert",
    "consumer-friendly",
    [
      "Important: unusual activity on your account",
      "We locked your account to keep it safe",
    ],
    [
      "Hi {first},",
      "We spotted several failed sign-in attempts on your {product} account and locked it temporarily to protect you.",
      "To unlock it, confirm it's you and choose a new password:",
      { cta: "Unlock my account", url: "{link:unlock}" },
      "This link expires in {hours} hours. If you didn't try to sign in, we recommend changing your password even if you don't use this link.",
      "We will never ask for your password by email or message.",
    ],
  ),
  t(
    "urgent-security-alert",
    "formal-bank",
    [
      "URGENT: Security alert on your account",
      "{product}: immediate action may be required",
    ],
    [
      "Dear {name},",
      "Our systems detected an unusual sign-in to your {product} online profile from {location} on {date} at {time}. As a precaution we have limited access to your profile.",
      "If this was you, please sign in through our app or website to confirm. If you do not recognise this activity, call us now on the number printed on the back of your card.",
      { cta: "Go to secure sign-in", url: "{link:security}" },
      "Please note that {product} will never ask you to disclose your full password, PIN or one-time codes, and will never ask you to transfer money to a safe account.",
      "Yours sincerely,\n{product} Fraud Prevention",
    ],
  ),

  // payment-failed-final
  t(
    "payment-failed-final",
    "dev-terse",
    [
      "Final notice: payment failed, workspace suspends on {date2}",
      "{product}: action required to avoid suspension",
    ],
    [
      "We have been unable to charge {amount} for {team} after {n2} attempts.",
      "If the payment does not go through by {date2}, the workspace will be suspended and API calls will return errors.",
      { cta: "Update payment method now", url: "{link:billing}" },
      "Data is kept for {days} days after suspension.",
    ],
  ),
  t(
    "payment-failed-final",
    "consumer-friendly",
    [
      "Your {product} subscription will be cancelled",
      "Last chance to update your payment details",
    ],
    [
      "Hi {first},",
      "We've tried to take your payment of {amount} a few times without success. If we can't collect it by {date2}, your subscription will be cancelled and you'll lose access to premium features.",
      { cta: "Update payment details", url: "{link:billing}" },
      "If you've already updated your card, thank you, you can ignore this email.",
    ],
  ),
  t(
    "payment-failed-final",
    "formal-bank",
    ["Final reminder: payment overdue", "{product}: your account may be restricted"],
    [
      "Dear {name},",
      "Your payment of {amount} due on {date} has not been received. To avoid a restriction on your account on {date2}, please make the payment as soon as possible.",
      { cta: "Pay now", url: "{link:billing}" },
      "If you have already paid, please disregard this notice. We will never ask you to pay by gift card or to share your card security code in reply to an email.",
      "Yours sincerely,\n{product} Collections",
    ],
  ),

  // account-suspension
  t(
    "account-suspension",
    "dev-terse",
    ["Your {product} account has been suspended", "{product}: account suspended"],
    [
      "The account {email} was suspended on {date} because an invoice of {amount} remains unpaid.",
      "Sending and API access are disabled. Pay the invoice to restore access immediately.",
      { cta: "Pay invoice", url: "{link:billing}" },
      "Contact {support} if you believe this is a mistake.",
    ],
  ),
  t(
    "account-suspension",
    "consumer-friendly",
    ["Your account is suspended", "We've paused your {product} account"],
    [
      "Hi {first},",
      "We've paused your {product} account because we couldn't verify the billing details on file. Your content is safe and will be kept for {days} days.",
      "To reactivate, update your billing information:",
      { cta: "Reactivate my account", url: "{link:billing}" },
      "If you think we got this wrong, reply to this email and a person will take a look.",
    ],
  ),
  t(
    "account-suspension",
    "small-shop",
    ["Your {product} account is on hold", "Account on hold: action needed"],
    [
      "Hi {first},",
      "We had to put your {product} account on hold because a recent payment was declined and an order could not be completed.",
      { cta: "Review my account", url: "{link:account}" },
      "We'll hold it for {days} days. Questions? Email {support}.",
    ],
  ),

  // verify-deadline
  t(
    "verify-deadline",
    "dev-terse",
    ["Verify your email within {hours} hours", "Action required: confirm {email}"],
    [
      "Your {product} account is not verified yet. Unverified accounts are deactivated after {hours} hours.",
      { cta: "Verify email now", url: "{link:verify}" },
      "If you did not create an account, ignore this email.",
    ],
  ),
  t(
    "verify-deadline",
    "consumer-friendly",
    [
      "Confirm your email or your account will be closed",
      "Don't lose your {product} account",
    ],
    [
      "Hi {first},",
      "We still haven't heard from you. Please confirm your email address within {hours} hours, otherwise we'll close your new {product} account.",
      { cta: "Confirm my email", url: "{link:verify}" },
      "Didn't sign up? Ignore this message and we'll delete the details.",
    ],
  ),
  t(
    "verify-deadline",
    "formal-bank",
    [
      "Action required: verify your identity",
      "{product}: please complete verification by {date2}",
    ],
    [
      "Dear {name},",
      "To meet our regulatory obligations we must complete identity verification on your {product} profile. If this is not completed by {date2}, some services may be restricted.",
      { cta: "Start verification", url: "{link:verify}" },
      "You will only be asked to upload documents inside your secure online profile. We will never ask you to send documents or passwords by email.",
      "Yours sincerely,\n{product} Compliance",
    ],
  ),

  // bank-transaction-review
  t(
    "bank-transaction-review",
    "formal-bank",
    ["Please review a recent transaction", "{product}: did you make this payment?"],
    [
      "Dear {name},",
      "We have temporarily held a card payment that looked unusual:",
      {
        rows: [
          ["Amount", "{amount}"],
          ["Merchant", "{place}"],
          ["Date", "{date}, {time}"],
          ["Card", "ending in {last4}"],
        ],
      },
      "Please confirm whether you made this payment. If you do not respond, your card may be blocked to protect you.",
      { cta: "Review transaction", url: "{link:review}" },
      "We will never ask you for your PIN, full card number or passwords. If you are unsure, call the number on the back of your card.",
      "Yours sincerely,\n{product} Fraud Prevention",
    ],
  ),
  t(
    "bank-transaction-review",
    "consumer-friendly",
    ["Was this you? Check a recent payment", "Quick check on a payment of {amount}"],
    [
      "Hi {first},",
      "We noticed a payment of {amount} at {place} that's a bit different from how you usually spend, so we've paused it.",
      "Tap below to tell us whether it was you:",
      { cta: "Yes, it was me / No, it wasn't", url: "{link:review}" },
      "If it wasn't you, we'll freeze your card straight away and send a new one.",
    ],
  ),
  t(
    "bank-transaction-review",
    "dev-terse",
    [
      "Unusual charge on your {product} account",
      "{product} billing: charge of {amount} flagged",
    ],
    [
      "A charge of {amount} to the card ending in {last4} was flagged for review.",
      "If you did not authorise it, disable the card and contact {support}.",
      { cta: "Review charge", url: "{link:review}" },
    ],
  ),
]
