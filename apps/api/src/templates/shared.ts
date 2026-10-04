import {
  skeletonFromHtml,
  withPreviewText,
  type StoredVersion,
  type Variable,
} from "@repo/templates"
import type { DeclaredVariable } from "../db/core.js"

/**
 * The templates every workspace starts with, kept ONCE, here (2026-10-04).
 *
 * ⚠ ONE COPY FOR EVERY WORKSPACE, NOT A ROW PER WORKSPACE. A new workspace is
 * "seeded" with the welcome template by this module existing: the store lists
 * it beside the workspace's own templates, and a send that names `welcome`
 * falls through to it. Nothing is written to Postgres, so ten thousand
 * workspaces hold zero copies of the same bytes.
 *
 * ⚠ A WORKSPACE'S OWN TEMPLATE WITH THE SAME ALIAS REPLACES IT. The first edit
 * (or publish, or move) of a shared template makes that workspace its own
 * copy, under the same alias, with the shared version copied in as its v1 -
 * so a send by `welcome` keeps working, unchanged, until the copy is
 * published. From then on the shared one is invisible to that workspace.
 * Renaming the copy's alias brings the shared one back, by the same rule.
 *
 * ⚠ THE IDS ARE FIXED, AND A CHANGE TO THE EMAIL NEEDS A NEW VERSION ID. A
 * version is immutable - `message_bodies.template_version_id` records which
 * one went out - so editing the HTML below under the same `versionId` would
 * rewrite what every past welcome send says it was. Bump `versionId` (and
 * `number`) with the HTML.
 */
export interface SharedTemplate {
  templateId: string
  versionId: string
  /** The alias a send uses, and the alias a workspace's own copy takes. */
  name: string
  title: string
  subject: string
  previewText: string
  /** As written, with `{{ name }}` placeholders: what a copy's draft starts from. */
  html: string
  text: string
  variables: DeclaredVariable[]
  /** The version a send renders, made once at load. */
  version: StoredVersion
  /** When this version of the shared template was made, for the console. */
  createdAt: Date
}

/*
 * Adapted from React Email's "Protocol" welcome demo
 * (resend/react-email, apps/demo/emails/03-Protocol/welcome.tsx).
 *
 * Copyright 2024 Plus Five Five, Inc. Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so, subject to
 * the following conditions: The above copyright notice and this permission
 * notice shall be included in all copies or substantial portions of the
 * Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * ⚠ THEIR LOGO AND SOCIAL ICONS ARE LEFT OUT: they are Resend's mark, and a
 * template every workspace sends must not carry it. The hero artwork
 * (`static/dither/dither-image-1.png`, under the same licence) is kept for now
 * at the user's request (2026-10-04), to be replaced later.
 *
 * ⚠ THE ARTWORK IS SERVED FROM i10.tech, NOT FROM THE DEMO. Theirs lives on a
 * Vercel preview deployment we do not control; every welcome email ever sent
 * would lose its image the day it goes. Ours is apps/web/public/email/
 * welcome-hero.jpg, scaled to twice the 592px it is shown at and re-encoded
 * (600 KB down to 215 KB). Replacing it means a new file name AND a new
 * version id below, so emails already sent keep the image they were sent with.
 */
const WELCOME_HTML = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
<head>
<meta content="text/html; charset=UTF-8" http-equiv="Content-Type"/>
<meta name="x-apple-disable-message-reformatting"/>
<title>Welcome</title>
<style>
@media (max-width:600px){.m-full{max-width:100%!important}.m-px{padding-right:1rem!important;padding-left:1rem!important}.m-py-8{padding-top:2rem!important;padding-bottom:2rem!important}.m-py-12{padding-top:3rem!important;padding-bottom:3rem!important}.m-pt-10{padding-top:2.5rem!important}.m-pb-8{padding-bottom:2rem!important}.m-pb-10{padding-bottom:2.5rem!important}.m-h1{font-size:40px!important;letter-spacing:-1.2px!important}.m-h2{font-size:24px!important;line-height:1.5!important}}
@font-face{font-family:'IBM Plex Sans Condensed';font-style:normal;font-weight:500;mso-font-alt:'Arial';src:url(https://fonts.gstatic.com/s/ibmplexsanscondensed/v15/Gg8gN4UfRSqiPg7Jn2ZI12V4DCEwkj1E4LVeHY5a64vr.ttf) format('truetype')}
@font-face{font-family:'Inter';font-style:normal;font-weight:300;mso-font-alt:'Arial';src:url(https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuOKfMZg.ttf) format('truetype')}
@font-face{font-family:'Inter';font-style:normal;font-weight:400;mso-font-alt:'Arial';src:url(https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2) format('woff2')}
@font-face{font-family:'Inter';font-style:normal;font-weight:500;mso-font-alt:'Arial';src:url(https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuI6fMZg.ttf) format('truetype')}
</style>
</head>
<body dir="ltr" lang="en" style="background-color:#212121;margin:0;padding:0">
<table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center"><tbody><tr><td style="background-color:#212121;font-size:14px;line-height:1.5;letter-spacing:0.3px;font-weight:350;margin:0;padding:0;font-family:Inter,Arial,sans-serif">
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="max-width:640px;background-color:#131313;margin-right:auto;margin-left:auto"><tbody><tr style="width:100%"><td>

<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tbody><tr><td class="m-px" style="padding:1.5rem">
<p style="margin:0;font-size:15px;line-height:1.5;letter-spacing:-0.075px;font-weight:500;color:#ffffff;font-family:Inter,Arial,sans-serif">{{ company }}</p>
</td></tr></tbody></table>

<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tbody><tr><td class="m-px m-pt-10 m-pb-8" style="padding:4rem 1.5rem 3rem 1.5rem">
<p class="m-full m-h1" style="font-size:56px;line-height:1;letter-spacing:-1.68px;font-weight:500;font-family:'IBM Plex Sans Condensed','Arial Narrow',Arial,sans-serif;color:#ffffff;margin:0;max-width:490px;text-transform:uppercase">Welcome to {{ company }}</p>
<p class="m-full" style="font-size:14px;line-height:1.5;letter-spacing:0.3px;font-weight:350;color:#c4c4c4;margin:2.5rem 0 0 0;max-width:490px;font-family:Inter,Arial,sans-serif">Hi {{ name }}, you can start exploring right away, set up your workspace, and invite your team if you're working with others.</p>
</td></tr></tbody></table>

<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tbody><tr><td class="m-px" style="padding:0 1.5rem">
<img alt="" src="https://i10.tech/email/welcome-hero.jpg" width="592" style="display:block;outline:none;border:none;text-decoration:none;width:100%;max-width:592px;height:auto"/>
</td></tr></tbody></table>

<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tbody><tr><td class="m-px m-pb-10" style="padding:3.5rem 1.5rem 3.5rem 1.5rem">
<p class="m-h2" style="font-size:32px;line-height:0.9;letter-spacing:0.4px;font-weight:500;font-family:'IBM Plex Sans Condensed','Arial Narrow',Arial,sans-serif;color:#ffffff;margin:0;text-transform:uppercase">Get started</p>

<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-bottom:1px solid #2b2b2b"><tbody><tr><td class="m-py-8" style="padding:2.5rem 0">
<p style="font-size:20px;line-height:1.1;font-weight:500;font-family:'IBM Plex Sans Condensed','Arial Narrow',Arial,sans-serif;color:#ffffff;margin:16px 0 1rem 0">Set up your workspace</p>
<p style="font-size:14px;line-height:1.5;letter-spacing:0.3px;font-weight:350;color:#c4c4c4;margin:0.75rem 0;font-family:Inter,Arial,sans-serif">Complete the basics to get the most out of your account.</p>
</td></tr></tbody></table>

<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-bottom:1px solid #2b2b2b"><tbody><tr><td class="m-py-8" style="padding:2.5rem 0">
<p style="font-size:20px;line-height:1.1;font-weight:500;font-family:'IBM Plex Sans Condensed','Arial Narrow',Arial,sans-serif;color:#ffffff;margin:16px 0 1rem 0">Invite your team</p>
<p style="font-size:14px;line-height:1.5;letter-spacing:0.3px;font-weight:350;color:#c4c4c4;margin:0.75rem 0;font-family:Inter,Arial,sans-serif">Collaboration works best when everyone's in.</p>
</td></tr></tbody></table>

<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tbody><tr><td class="m-pt-10" style="padding-top:3.5rem">
<p style="font-size:15px;line-height:1.5;letter-spacing:-0.075px;font-weight:450;color:#ffffff;margin:0;font-family:Inter,Arial,sans-serif">Need help?</p>
<p class="m-full" style="font-size:13px;line-height:1.5;letter-spacing:0.2px;font-weight:300;color:#c4c4c4;margin:0.125rem 0 0 0;max-width:490px;font-family:Inter,Arial,sans-serif">Reply to this email and a person on the {{ company }} team will get back to you.</p>
</td></tr></tbody></table>
</td></tr></tbody></table>

<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-top:1px solid #2b2b2b"><tbody><tr><td class="m-px m-py-12" style="padding:4rem 1.5rem">
<p style="font-size:11px;line-height:1.5;letter-spacing:0.3px;font-weight:300;color:#4a4a4a;margin:0;max-width:320px;font-family:Inter,Arial,sans-serif">You're receiving this because you signed up for {{ company }}.</p>
</td></tr></tbody></table>

</td></tr></tbody></table>
</td></tr></tbody></table>
</body>
</html>`

const WELCOME_TEXT = `{{ company }}

WELCOME TO {{ company }}

Hi {{ name }}, you can start exploring right away, set up your workspace, and invite your team if you're working with others.

GET STARTED

Set up your workspace
Complete the basics to get the most out of your account.

Invite your team
Collaboration works best when everyone's in.

Need help?
Reply to this email and a person on the {{ company }} team will get back to you.

You're receiving this because you signed up for {{ company }}.`

const WELCOME_VARIABLES: DeclaredVariable[] = [
  { name: "name", type: "string", fallback: "there" },
  { name: "company", type: "string", fallback: "the team" },
]

/**
 * The marker nonce of the shared versions. Fixed rather than random because
 * the version is made at every process start and must come out byte for byte
 * the same each time; twelve lowercase letters, as `nonceFrom` makes them.
 */
const SHARED_NONCE = "sharedwelcom"

function made(input: {
  templateId: string
  versionId: string
  name: string
  title: string
  subject: string
  previewText: string
  html: string
  text: string
  variables: DeclaredVariable[]
  createdAt: string
}): SharedTemplate {
  const skeleton = skeletonFromHtml({
    html: withPreviewText(input.html, input.previewText),
    text: input.text,
    nonce: SHARED_NONCE,
  })
  // A shared template that does not parse is a bug in this file; fail at
  // start, loudly, rather than at somebody's send.
  if (!skeleton.ok)
    throw new Error(`shared template ${input.name}: ${skeleton.problems}`)
  const variables: Variable[] = skeleton.skeleton.variables.map((v) => {
    const declared = input.variables.find((d) => d.name === v.path)
    return declared?.fallback != null
      ? { path: v.path, preview: declared.fallback, fallback: declared.fallback }
      : v
  })
  return {
    templateId: input.templateId,
    versionId: input.versionId,
    name: input.name,
    title: input.title,
    subject: input.subject,
    previewText: input.previewText,
    html: input.html,
    text: input.text,
    variables: input.variables,
    createdAt: new Date(input.createdAt),
    version: {
      id: input.versionId,
      templateId: input.templateId,
      number: 1,
      subject: input.subject,
      html: skeleton.skeleton.html,
      text: skeleton.skeleton.text,
      nonce: SHARED_NONCE,
      variables,
      from: null,
      replyTo: null,
    },
  }
}

export const SHARED_TEMPLATES: readonly SharedTemplate[] = [
  made({
    templateId: "00000000-0000-4000-a000-000000000001",
    versionId: "00000000-0000-4000-a000-000000000102",
    name: "welcome",
    title: "Welcome",
    subject: "Welcome to {{ company }}",
    previewText: "Welcome to {{ company }}",
    html: WELCOME_HTML,
    text: WELCOME_TEXT,
    variables: WELCOME_VARIABLES,
    createdAt: "2026-10-04T00:00:00Z",
  }),
]

/** The shared template a reference names - by its id or its alias - if any. */
export function sharedTemplate(ref: string): SharedTemplate | undefined {
  return SHARED_TEMPLATES.find((t) => t.templateId === ref || t.name === ref)
}

/** The shared template whose version this is, if it is one. */
export function sharedVersion(versionId: string): SharedTemplate | undefined {
  return SHARED_TEMPLATES.find((t) => t.versionId === versionId)
}
