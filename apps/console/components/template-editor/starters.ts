import type { DeclaredVariable } from "@/lib/types"

/**
 * The emails behind "Pick a template": a start, not a library.
 *
 * ⚠ HTML THE EDITOR PARSES INTO ITS OWN BLOCKS, so a starter is edited like
 * anything typed by hand. Variables are chips (`span[data-variable]`) and
 * come declared, with fallbacks where a send can do without them.
 */
export interface Starter {
  id: string
  name: string
  description: string
  subject: string
  previewText: string
  variables: DeclaredVariable[]
  html: string
}

const v = (name: string) => `<span data-variable="${name}"></span>`
const button = (label: string, href: string) =>
  `<a class="button" data-id="react-email-button" href="${href}">${label}</a>`

export const STARTERS: Starter[] = [
  {
    id: "welcome",
    name: "Welcome",
    description: "Greet a new user and point them at the first step.",
    subject: "Welcome to Acme, {{ name }}",
    previewText: "Your account is ready. Here is where to start.",
    variables: [
      { name: "name", type: "string", fallback: "there" },
      { name: "url", type: "string", fallback: null },
    ],
    html: `<h1>Welcome aboard, ${v("name")}</h1>
<p>Your account is ready. We built Acme so you can get from idea to inbox in minutes, and the first step takes about two.</p>
${button("Get started", "{{ url }}")}
<p>If you have questions, reply to this email. A real person reads every one.</p>
<hr>
<p>The Acme team</p>`,
  },
  {
    id: "password-reset",
    name: "Password reset",
    description: "A link to choose a new password, and what to do if it was not them.",
    subject: "Reset your password",
    previewText: "This link expires in an hour.",
    variables: [
      { name: "name", type: "string", fallback: "there" },
      { name: "reset_url", type: "string", fallback: null },
    ],
    html: `<h2>Reset your password</h2>
<p>Hi ${v("name")}, somebody asked to reset the password for your account. If it was you, choose a new one below.</p>
${button("Choose a new password", "{{ reset_url }}")}
<p>This link expires in an hour. If you did not ask for this, you can ignore this email; your password stays the same.</p>`,
  },
  {
    id: "receipt",
    name: "Receipt",
    description: "What was paid, for what, and where to find the invoice.",
    subject: "Your receipt from Acme",
    previewText: "Thanks for your payment.",
    variables: [
      { name: "amount", type: "string", fallback: null },
      { name: "plan", type: "string", fallback: "Pro" },
      { name: "invoice_url", type: "string", fallback: null },
    ],
    html: `<h2>Thanks for your payment</h2>
<p>We received ${v("amount")} for the ${v("plan")} plan.</p>
<blockquote><p>Keep this email for your records. The full invoice, with your billing details, is one click away.</p></blockquote>
${button("View invoice", "{{ invoice_url }}")}
<p>Questions about a charge? Reply and we will sort it out.</p>`,
  },
  {
    id: "newsletter",
    name: "Newsletter",
    description: "A headline story, a call to action and a footer.",
    subject: "What is new at Acme",
    previewText: "This month: faster sends, folders and more.",
    variables: [{ name: "name", type: "string", fallback: "there" }],
    html: `<h1>What is new this month</h1>
<p>Hi ${v("name")}, here is what changed since the last issue.</p>
<h2>Templates, organised</h2>
<p>Folders arrived. Keep onboarding, billing and alerts apart, and move templates between them by dragging.</p>
${button("Read the announcement", "https://acme.example/blog")}
<hr>
<p>You are receiving this because you subscribed to product news.</p>`,
  },
]
