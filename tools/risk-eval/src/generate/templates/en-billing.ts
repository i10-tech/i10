import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("en")

/** Orders, receipts, subscriptions, refunds and shipping. */
export const EN_BILLING: Template[] = [
  // order-confirmation
  t(
    "order-confirmation",
    "small-shop",
    ["Your {product} order {order}", "Thanks for your order {order}"],
    [
      "Hi {first},",
      "Thank you for your order! We're getting it ready and we'll email you when it ships.",
      {
        rows: [
          ["Order", "{order}"],
          ["Placed", "{date}"],
        ],
      },
      { lines: "order" },
      "Shipping to: {ship_to}",
      { cta: "View your order", url: "{link:orders}" },
    ],
  ),
  t(
    "order-confirmation",
    "small-shop",
    ["Order confirmed: {order}", "We've got your order, {first}"],
    [
      "Thanks {first}, your order is confirmed.",
      { lines: "order" },
      "We'll send tracking details as soon as it leaves the workshop. Estimated dispatch: within [[2|3|4]] working days.",
      "Anything wrong? Email {support} and quote {order}.",
    ],
  ),
  t(
    "order-confirmation",
    "consumer-friendly",
    ["Order {order} is confirmed", "Thanks for your purchase!"],
    [
      "Hi {first},",
      "We've received your order {order} and we're on it.",
      { lines: "order" },
      { cta: "Track my order", url: "{link:orders}" },
      "Need to change something? Reply within an hour and we'll do our best.",
    ],
  ),

  // receipt
  t(
    "receipt",
    "dev-terse",
    ["Receipt from {company}", "{product}: invoice {invoice}"],
    [
      "Payment received, thank you.",
      {
        rows: [
          ["Invoice", "{invoice}"],
          ["Date", "{date}"],
          ["Plan", "{plan}"],
          ["Amount", "{price}"],
          ["Tax", "{tax}"],
          ["Total", "{amount}"],
          ["Card", "ending in {last4}"],
        ],
      },
      { cta: "Download invoice", url: "{link:invoices}" },
    ],
  ),
  t(
    "receipt",
    "consumer-friendly",
    ["Your receipt from {product}", "Thanks for your payment, {first}"],
    [
      "Hi {first},",
      "Thanks for your payment. Here's your receipt for the {plan} plan.",
      {
        rows: [
          ["Receipt", "{invoice}"],
          ["Paid on", "{date}"],
          ["Total", "{amount}"],
          ["Payment method", "card ending in {last4}"],
        ],
      },
      { cta: "View receipt", url: "{link:invoices}" },
      "Questions about this charge? Reply to this email or write to {support}.",
    ],
  ),
  t(
    "receipt",
    "formal-bank",
    ["Payment confirmation {invoice}", "{product}: confirmation of your payment"],
    [
      "Dear {name},",
      "We confirm receipt of your payment of {amount} on {date}.",
      {
        rows: [
          ["Reference", "{invoice}"],
          ["Description", "{plan} subscription"],
          ["Amount excluding tax", "{price}"],
          ["Tax", "{tax}"],
          ["Total charged", "{amount}"],
        ],
      },
      "A copy of this document is available in your online profile.",
      { cta: "View document", url: "{link:invoices}" },
      "Yours sincerely,\n{product} Accounts",
    ],
  ),
  t(
    "receipt",
    "small-shop",
    ["Receipt for your {product} purchase", "Your receipt {invoice}"],
    [
      "Hi {first},",
      "Here is the receipt for your recent purchase.",
      {
        rows: [
          ["Receipt", "{invoice}"],
          ["Date", "{date}"],
          ["Total paid", "{amount}"],
        ],
      },
      { cta: "Download receipt", url: "{link:invoices}" },
      "Thank you for supporting a small business.",
    ],
  ),

  // payment-failed (ordinary, calm)
  t(
    "payment-failed",
    "dev-terse",
    ["Payment failed for {product}", "{product}: we could not charge your card"],
    [
      "We tried to charge {amount} to the card ending in {last4} for the {plan} plan and the payment failed.",
      "We will retry in [[3|5]] days. To avoid an interruption, update your payment method before then.",
      { cta: "Update payment method", url: "{link:billing}" },
    ],
  ),
  t(
    "payment-failed",
    "consumer-friendly",
    ["We couldn't process your payment", "Your {product} payment didn't go through"],
    [
      "Hi {first},",
      "Your latest payment of {amount} for {product} didn't go through. This can happen if a card has expired or has reached its limit.",
      "Your plan stays active while we try again over the next few days. You can update your details here:",
      { cta: "Update my card", url: "{link:billing}" },
      "If you've already sorted it, thank you, and you can ignore this message.",
    ],
  ),
  t(
    "payment-failed",
    "formal-bank",
    [
      "Notice: a payment was not completed",
      "{product}: unsuccessful payment of {amount}",
    ],
    [
      "Dear {name},",
      "We were unable to collect a payment of {amount} due on {date} for your {product} {plan} subscription.",
      "No action is needed if you have already resolved this. Otherwise, please review your payment details in your online profile.",
      { cta: "Review payment details", url: "{link:billing}" },
      "We will never ask you for your full card number or security code by email.",
      "Yours sincerely,\n{product} Accounts",
    ],
  ),

  // renewal-reminder
  t(
    "renewal-reminder",
    "dev-terse",
    ["Your {product} plan renews on {date2}", "{product}: upcoming renewal"],
    [
      "The {plan} plan for {team} renews on {date2} for {amount} per {period}.",
      "To change or cancel, use the billing page before that date.",
      { cta: "Manage subscription", url: "{link:billing}" },
    ],
  ),
  t(
    "renewal-reminder",
    "consumer-friendly",
    ["A heads up about your {product} renewal", "Your {product} plan renews soon"],
    [
      "Hi {first},",
      "Just a friendly reminder that your {plan} plan renews on {date2}. We'll charge {amount} to your card ending in {last4}.",
      "Nothing to do if you'd like to keep going. If you'd rather change plans or cancel, you can do it in a minute:",
      { cta: "Manage my plan", url: "{link:billing}" },
    ],
  ),
  t(
    "renewal-reminder",
    "formal-bank",
    [
      "Notice of upcoming renewal",
      "{product}: your subscription will renew on {date2}",
    ],
    [
      "Dear {name},",
      "Your {product} {plan} subscription will renew automatically on {date2}. The amount of {amount} will be charged to your card ending in {last4}.",
      "You may amend or cancel the subscription at any time before the renewal date.",
      { cta: "Manage subscription", url: "{link:billing}" },
      "Yours sincerely,\n{product} Accounts",
    ],
  ),

  // trial-ending
  t(
    "trial-ending",
    "dev-terse",
    ["Your {product} trial ends in {days_left} days", "{product}: trial ending"],
    [
      "The trial for {team} ends on {date2}. After that the workspace drops to the free tier and some features turn off.",
      { cta: "Choose a plan", url: "{link:billing}" },
    ],
  ),
  t(
    "trial-ending",
    "consumer-friendly",
    ["Your free trial ends soon", "{days_left} days left on your {product} trial"],
    [
      "Hi {first},",
      "Your {product} trial wraps up on {date2}. We hope you've enjoyed it!",
      "To keep everything you've set up, pick a plan before then. If you'd rather not continue, you don't need to do anything and you won't be charged.",
      { cta: "See plans", url: "{link:billing}" },
    ],
  ),
  t(
    "trial-ending",
    "small-shop",
    ["Your {product} trial is almost over", "Trial ends {date2}"],
    [
      "Hi {first},",
      "Your trial of {product} ends on {date2}. You will not be charged unless you choose a plan.",
      { cta: "Choose a plan", url: "{link:billing}" },
    ],
  ),

  // refund-issued
  t(
    "refund-issued",
    "dev-terse",
    ["Refund issued: {amount}", "{product}: refund for {invoice}"],
    [
      "We refunded {amount} to the card ending in {last4} for invoice {invoice}.",
      "It can take 5 to 10 business days to appear on your statement.",
    ],
  ),
  t(
    "refund-issued",
    "consumer-friendly",
    ["Your refund is on its way", "We've refunded {amount}"],
    [
      "Hi {first},",
      "We've issued a refund of {amount} to your card ending in {last4}. Your bank can take up to 10 business days to show it.",
      "Thanks for your patience, and if there's anything else we can do, just reply to this email.",
    ],
  ),
  t(
    "refund-issued",
    "formal-bank",
    ["Confirmation of refund", "{product}: refund of {amount} processed"],
    [
      "Dear {name},",
      "A refund of {amount} relating to {invoice} was processed on {date} to the card ending in {last4}.",
      "Please allow up to 10 working days for the credit to appear on your statement.",
      "Yours sincerely,\n{product} Accounts",
    ],
  ),
  t(
    "refund-issued",
    "small-shop",
    ["Your {product} refund", "Refund processed for {order}"],
    [
      "Hi {first},",
      "We've refunded {amount} for order {order}. It should appear in your account within 5 to 10 working days.",
      "We're sorry it didn't work out this time.",
    ],
  ),

  // shipping-notice
  t(
    "shipping-notice",
    "small-shop",
    ["Your order {order} has shipped", "On its way: order {order}"],
    [
      "Hi {first},",
      "Good news, your order has shipped with {carrier}.",
      {
        rows: [
          ["Order", "{order}"],
          ["Tracking number", "{tracking}"],
          ["Estimated delivery", "{eta}"],
        ],
      },
      { cta: "Track your parcel", url: "{link:track}" },
      "Thanks for shopping with {product}.",
    ],
  ),
  t(
    "shipping-notice",
    "consumer-friendly",
    ["Your package is on the way", "Shipped: {order}"],
    [
      "Hi {first},",
      "Your order {order} left our warehouse today. {carrier} will bring it to {ship_to}.",
      {
        rows: [
          ["Tracking", "{tracking}"],
          ["Arriving", "{eta}"],
        ],
      },
      { cta: "Track package", url: "{link:track}" },
    ],
  ),
  t(
    "shipping-notice",
    "dev-terse",
    ["Shipment sent: {order}", "{product}: your hardware order shipped"],
    [
      "Order {order} shipped via {carrier}. Tracking number: {tracking}. Expected {eta}.",
      { cta: "Track shipment", url: "{link:track}" },
    ],
  ),

  // delivery-update
  t(
    "delivery-update",
    "small-shop",
    ["Your order has been delivered", "Delivered: order {order}"],
    [
      "Hi {first},",
      "{carrier} marked your order {order} as delivered on {date}.",
      "If it hasn't turned up, please check with neighbours and then email {support} so we can sort it out.",
    ],
  ),
  t(
    "delivery-update",
    "consumer-friendly",
    ["Out for delivery today", "Your parcel arrives today"],
    [
      "Hi {first},",
      "Your parcel {tracking} is out for delivery with {carrier} and should reach {ship_to} today.",
      { cta: "Follow the courier", url: "{link:track}" },
    ],
  ),
  t(
    "delivery-update",
    "formal-bank",
    ["Your replacement card has been dispatched", "{product}: card delivery update"],
    [
      "Dear {name},",
      "Your replacement card was dispatched on {date} and should arrive within 5 working days. It will arrive in a plain envelope.",
      "You will need to activate it before use. We will never ask you to share your PIN with anyone, including our staff.",
      "Yours sincerely,\n{product} Cards",
    ],
  ),

  // usage-limit-warning
  t(
    "usage-limit-warning",
    "dev-terse",
    ["You have used {pct}% of your {product} quota", "{product}: usage at {pct}%"],
    [
      "{team} has used {used} of {limit} requests this {period}.",
      "At 100% new requests are rejected until the period resets or you upgrade.",
      { cta: "View usage", url: "{link:usage}" },
    ],
  ),
  t(
    "usage-limit-warning",
    "consumer-friendly",
    ["You're close to your plan limit", "{pct}% of your {product} plan used"],
    [
      "Hi {first},",
      "You've used {pct}% of what's included in your {plan} plan this {period}: {used} of {limit}.",
      "To keep things running smoothly, you might want to upgrade before you hit the limit.",
      { cta: "See upgrade options", url: "{link:billing}" },
    ],
  ),
]
