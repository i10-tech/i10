import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("en")

/**
 * Account-security mail, written the way careful services write it: it names
 * the product, gives a way to ignore the mail, never asks for a password or a
 * code by reply, and links only to the sender's own domain.
 */
export const EN_SECURITY: Template[] = [
  // password-reset
  t(
    "password-reset",
    "dev-terse",
    ["Reset your {product} password", "{product}: password reset requested"],
    [
      "Someone asked to reset the password for {email}.",
      { cta: "Reset password", url: "{link:reset}" },
      "The link works once and expires in {minutes} minutes. If this was not you, ignore this email and your password stays as it is.",
      "{product} will never ask for your password by email.",
    ],
  ),
  t(
    "password-reset",
    "consumer-friendly",
    ["Reset your {product} password", "Let's get you back into {product}"],
    [
      "Hi {first},",
      "We got a request to reset the password on your {product} account. Tap the button below to choose a new one.",
      { cta: "Choose a new password", url: "{link:reset}" },
      "This link expires in {minutes} minutes. Didn't ask for this? You can safely ignore this email, nothing will change on your account.",
      "[[Take care|Talk soon]],\nThe {product} team",
    ],
  ),
  t(
    "password-reset",
    "formal-bank",
    [
      "Password reset request for your {product} online account",
      "{product}: your password reset link",
    ],
    [
      "Dear {name},",
      "We received a request on {date} at {time} to reset the password of your {product} online profile.",
      { cta: "Reset your password", url: "{link:reset}" },
      "The link is valid for {minutes} minutes and can be used once. If you did not make this request no action is needed and you may disregard this message. If you are worried about the security of your account, call the number printed on the back of your card.",
      "{product} will never ask you for your password, PIN or full card number by email or by telephone.",
      "Yours sincerely,\n{product} Customer Security",
    ],
  ),
  t(
    "password-reset",
    "small-shop",
    ["Reset your {product} password", "Your {product} password reset link"],
    [
      "Hi {first},",
      "You, or someone using your email address, asked to reset the password for your {product} account.",
      { cta: "Reset my password", url: "{link:reset}" },
      "The link stops working in {minutes} minutes. If you did not ask for this, just ignore this email.",
      "Questions about an order? Email us at {support}.",
    ],
  ),

  // email-verification
  t(
    "email-verification",
    "dev-terse",
    ["Verify your email for {product}", "{product}: confirm {email}"],
    [
      "Confirm that {email} is your address to finish setting up your {product} account.",
      { cta: "Verify email", url: "{link:verify}" },
      "This link expires in {hours} hours. If you did not create an account you can ignore this message.",
    ],
  ),
  t(
    "email-verification",
    "consumer-friendly",
    ["Please confirm your email address", "One quick step to finish joining {product}"],
    [
      "Hi {first},",
      "Thanks for signing up for {product}! Confirm your email address so we know it's really you.",
      { cta: "Confirm my email", url: "{link:verify}" },
      "If the button doesn't work, copy this link into your browser:\n{link:verify}",
      "Didn't sign up? No problem, just delete this email and we won't send you anything else.",
    ],
  ),
  t(
    "email-verification",
    "formal-bank",
    [
      "Confirm your email address for {product}",
      "{product}: email address verification",
    ],
    [
      "Dear {name},",
      "To complete the registration of your {product} online profile, please confirm that this email address belongs to you.",
      { cta: "Confirm email address", url: "{link:verify}" },
      "The link is valid for {hours} hours. If you did not register with {product}, please disregard this message.",
      "We will never ask you to send your password or card details in reply to an email.",
      "Yours sincerely,\n{product} Customer Services",
    ],
  ),
  t(
    "email-verification",
    "small-shop",
    [
      "Confirm your email for {product}",
      "Welcome to {product}, please confirm your email",
    ],
    [
      "Hi {first},",
      "Thanks for creating an account with {product}. Please confirm your email address so we can send you order updates.",
      { cta: "Confirm my email", url: "{link:verify}" },
      "Not you? Ignore this email and the account will not be activated.",
    ],
  ),

  // otp-code
  t(
    "otp-code",
    "dev-terse",
    ["{code} is your {product} sign-in code", "Your {product} login code"],
    [
      "Your {product} sign-in code:",
      { code: "{code}" },
      "It expires in {minutes} minutes. Do not share it with anyone, {product} staff will never ask for it.",
      "If you did not try to sign in, you can ignore this email.",
    ],
  ),
  t(
    "otp-code",
    "consumer-friendly",
    ["Your {product} code is {code}", "Here's your sign-in code"],
    [
      "Hi {first},",
      "Use this code to finish signing in to {product}:",
      { code: "{code}" },
      "It's good for the next {minutes} minutes. Keep it to yourself, we'll never ask you to read it out or send it to us.",
      "Wasn't you? You can ignore this message, and you may want to change your password.",
    ],
  ),
  t(
    "otp-code",
    "formal-bank",
    ["Your one-time security code", "{product}: one-time passcode {code}"],
    [
      "Dear {name},",
      "Your one-time security code for {product} online banking is:",
      { code: "{code}" },
      "The code is valid for {minutes} minutes and can be used once. Never disclose it to anyone, including anyone who contacts you claiming to be from {product}.",
      "If you did not request this code, please contact us using the number on the back of your card.",
    ],
  ),
  t(
    "otp-code",
    "small-shop",
    ["Your {product} sign-in code: {code}", "{code} is your code for {product}"],
    [
      "Hi {first},",
      "Enter this code to sign in to your {product} account:",
      { code: "{code}" },
      "It expires in {minutes} minutes. If you did not request it, you can ignore this email.",
    ],
  ),

  // magic-link
  t(
    "magic-link",
    "dev-terse",
    ["Sign in to {product}", "{product} sign-in link"],
    [
      "Use this link to sign in as {email}:",
      { cta: "Sign in", url: "{link:magic}" },
      "Single use, valid for {minutes} minutes, and only in the browser where you asked for it. If you did not ask, ignore this email.",
    ],
  ),
  t(
    "magic-link",
    "consumer-friendly",
    ["Your magic link to {product}", "Tap to sign in to {product}"],
    [
      "Hi {first},",
      "No password needed. Tap the button to sign in to {product} on this device.",
      { cta: "Sign in to {product}", url: "{link:magic}" },
      "This link expires in {minutes} minutes and only works once. If you didn't ask for it, you can ignore this email, nobody can get into your account without it.",
    ],
  ),
  t(
    "magic-link",
    "formal-bank",
    ["Your secure sign-in link", "{product}: secure sign-in link requested"],
    [
      "Dear {name},",
      "A secure sign-in link was requested for your {product} account on {date} at {time}.",
      { cta: "Sign in securely", url: "{link:magic}" },
      "The link expires after {minutes} minutes. If you did not request it, do not use it and contact us using the number on the back of your card.",
      "{product} will never ask you for your password or PIN by email.",
    ],
  ),
  t(
    "magic-link",
    "small-shop",
    ["Your {product} sign-in link", "Sign in to {product}"],
    [
      "Hi {first},",
      "Here is the link you asked for to sign in to your {product} account.",
      { cta: "Sign in", url: "{link:magic}" },
      "It works once and expires in {minutes} minutes. If it wasn't you, just ignore this email.",
    ],
  ),

  // new-device-alert
  t(
    "new-device-alert",
    "dev-terse",
    ["New sign-in to your {product} account", "{product}: sign-in from {device}"],
    [
      "A new sign-in to {email} was recorded.",
      {
        rows: [
          ["Device", "{device}"],
          ["Location", "{location}"],
          ["IP address", "{ip}"],
          ["Time", "{date}, {time}"],
        ],
      },
      "If this was you, nothing to do. If not, reset your password and revoke sessions in your security settings:",
      { cta: "Review security settings", url: "{link:security}" },
    ],
  ),
  t(
    "new-device-alert",
    "consumer-friendly",
    ["New sign-in on {device}", "Did you just sign in to {product}?"],
    [
      "Hi {first},",
      "We noticed a sign-in to your {product} account from a device we don't recognise.",
      {
        rows: [
          ["Device", "{device}"],
          ["Where", "{location}"],
          ["When", "{date}, {time}"],
        ],
      },
      "If that was you, great, there's nothing more to do. If it wasn't, we recommend changing your password.",
      { cta: "Secure my account", url: "{link:security}" },
      "We'll never ask for your password by email.",
    ],
  ),
  t(
    "new-device-alert",
    "formal-bank",
    [
      "Security notice: new device signed in to your account",
      "{product}: sign-in from a new device",
    ],
    [
      "Dear {name},",
      "We detected a sign-in to your {product} online profile from a device that you have not used before.",
      {
        rows: [
          ["Date and time", "{date}, {time}"],
          ["Device", "{device}"],
          ["Approximate location", "{location}"],
        ],
      },
      "If you recognise this activity, no action is required. If you do not, please change your password in your online profile and call the number on the back of your card.",
      "{product} will never ask you to confirm your password, PIN or one-time codes by email, text message or telephone.",
      "Yours sincerely,\n{product} Security Team",
    ],
  ),
  t(
    "new-device-alert",
    "small-shop",
    ["New sign-in to your {product} account", "Was this you?"],
    [
      "Hi {first},",
      "Someone signed in to your {product} account from {device} near {location} on {date}.",
      "If that was you, you can ignore this email. If it wasn't, please reset your password.",
      { cta: "Reset my password", url: "{link:reset}" },
    ],
  ),

  // password-changed
  t(
    "password-changed",
    "dev-terse",
    ["Your {product} password was changed", "{product}: password changed"],
    [
      "The password for {email} was changed on {date} at {time}.",
      "If you did this, no further action is needed. If you did not, reset your password now and contact {support}.",
      { cta: "Reset password", url: "{link:reset}" },
    ],
  ),
  t(
    "password-changed",
    "consumer-friendly",
    ["Your password has been changed", "Password updated on your {product} account"],
    [
      "Hi {first},",
      "This is a quick note to say your {product} password was changed on {date}.",
      "If it was you, all good. If you don't recognise this change, let us know right away at {support} and reset your password here:",
      { cta: "Reset my password", url: "{link:reset}" },
    ],
  ),
  t(
    "password-changed",
    "formal-bank",
    [
      "Confirmation: your password has been changed",
      "{product}: password change confirmation",
    ],
    [
      "Dear {name},",
      "We confirm that the password of your {product} online profile was changed on {date} at {time}.",
      "If you made this change, you do not need to do anything. If you did not, please call us immediately on the number printed on your card or statement.",
      "For your security, {product} will never ask you for your password in an email or phone call.",
      "Yours sincerely,\n{product} Customer Security",
    ],
  ),
  t(
    "password-changed",
    "small-shop",
    ["Your {product} password was changed", "Password changed"],
    [
      "Hi {first},",
      "The password on your {product} account was changed on {date}. If this was you, there's nothing else to do.",
      "If it wasn't, reset your password and write to us at {support}.",
      { cta: "Reset my password", url: "{link:reset}" },
    ],
  ),

  // two-factor-changed
  t(
    "two-factor-changed",
    "dev-terse",
    ["Two-factor authentication enabled", "{product}: 2FA enabled on {email}"],
    [
      "Two-factor authentication was turned on for {email} on {date}.",
      "You will be asked for a code from your authenticator app at sign-in. Keep your recovery codes somewhere safe.",
      "Not you? Disable it and reset your password:",
      { cta: "Open security settings", url: "{link:security}" },
    ],
  ),
  t(
    "two-factor-changed",
    "dev-terse",
    ["Two-factor authentication disabled", "{product}: 2FA disabled on {email}"],
    [
      "Two-factor authentication was turned off for {email} on {date} at {time}.",
      "If you did this, nothing to do. If not, turn it back on and change your password:",
      { cta: "Open security settings", url: "{link:security}" },
    ],
  ),
  t(
    "two-factor-changed",
    "consumer-friendly",
    ["Two-step verification is now on", "You turned on two-step verification"],
    [
      "Hi {first},",
      "Two-step verification is now on for your {product} account. From now on we'll ask for a code when you sign in on a new device.",
      "Keep your backup codes safe, you'll need them if you lose your phone.",
      "Didn't do this? Secure your account right away:",
      { cta: "Review my security", url: "{link:security}" },
    ],
  ),
  t(
    "two-factor-changed",
    "consumer-friendly",
    ["Two-step verification was turned off", "Heads up: two-step verification is off"],
    [
      "Hi {first},",
      "Two-step verification was turned off for your {product} account on {date}.",
      "If you did that, you're all set. If you didn't, turn it back on and change your password.",
      { cta: "Turn it back on", url: "{link:security}" },
    ],
  ),
  t(
    "two-factor-changed",
    "formal-bank",
    [
      "Two-step verification has been activated",
      "{product}: security settings updated",
    ],
    [
      "Dear {name},",
      "Two-step verification was activated on your {product} online profile on {date} at {time}.",
      "If you made this change, no action is required. If you did not, please call us immediately.",
      "{product} will never ask you for your one-time codes by email, text message or telephone.",
      "Yours sincerely,\n{product} Customer Security",
    ],
  ),
  t(
    "two-factor-changed",
    "formal-bank",
    [
      "Two-step verification has been deactivated",
      "{product}: security settings updated",
    ],
    [
      "Dear {name},",
      "Two-step verification was deactivated on your {product} online profile on {date} at {time}.",
      "If you made this change, no action is required. If you did not, please sign in and reactivate it, and call us on the number printed on your card.",
      "Yours sincerely,\n{product} Customer Security",
    ],
  ),
]
