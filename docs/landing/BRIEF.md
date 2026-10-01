# i10 landing page - working brief

The single source of truth for the marketing site build (`apps/web`, served at
`i10.tech`). Written so the work survives a context reset: read this first,
then `RESEARCH.md` beside it for the per-site teardown.

Status is tracked in the checklist at the bottom. Update it as work lands.

---

## 1. What the user asked for (the goal)

Complete the landing page with everything below. Rich, dark, animated, pixel
perfect, nothing that reads as AI-generated. Claude has the go-ahead to make
decisions and invent things.

- **Dark only** for now. `apps/web` on the root domain (`i10.tech`).
- **Study every reference site** (list in section 3), live, interactively, one
  at a time, and read their open-source landing code where it exists. Done.
- **Motion everywhere, but controlled**: on-scroll animations, sticky/pinned
  sections, horizontal scroll, micro-interactions, hover states, nothing jumps
  (no layout shift), everything animated. GSAP (ScrollTrigger, SplitText),
  Motion (Framer Motion), three.js + React Three Fiber, **Lenis** smooth scroll
  (tune it, take cues from lenis.dev), shadcn/ui, Radix, Aceternity UI and
  Magic UI as raw material (restyled, never stock).
- **Great typography**, right sizing, radii, motion. "A killer mix" of fonts.
  Candidates tested: Inter Display, Geist, Bricolage Grotesque, Amazon Ember
  (installed locally). Decision in section 5.
- **Nav**: Linear/Resend/Cloudflare style item-to-item animation (a highlight
  that slides between items, one dropdown panel that morphs size and slides
  content), Clerk/Dub-style floating bar, Autumn-style fill animation on hover.
  Cloudflare behaviours: **"Log in" when signed out, "Dashboard" when signed
  in**; the logo collapses to the mark on scroll and recolours per section;
  the bar shifts up on scroll down and returns on scroll up.
- **App teasers** like Linear/Attio/Clerk/Resend/Supabase: show the product
  (console) and let it grow/focus on scroll (Attio).
- **Logos marquee** like Clerk ("Trusted by fast-growing companies..."). i10
  has no customers yet, so use honest content (see section 6).
- **Clerk "Frameworks / Integrations" grid** with its hover animation.
- **WorkOS toggle drum** (Ready -> Enabled, toggle flips).
- **Resend**: 3D hero object, icons, typography, interactive test-mode and
  webhooks cards, dashboard teaser with polished cards, the giant wordmark
  footer, the **pulsing "All systems operational" pill**.
- **Dub**: text with inline coloured icon tiles that changes on scroll.
- **Vercel /ai** three-card row (orbit, step list, file tree).
- **Bird**: interactive 3D earth (not to copy literally), giant wordmark footer.
- **Webflow footer mark**: a big colored logo bleeding off the footer corner.
  i10 needs one like it.
- **Footer**: Resend + Bird style giant word, but the word is **"Integration"**,
  not "i10" (i10 = i + 10 letters = integration). **Badges** on footer links
  ("New" on new products/features). Link things that do not exist yet, and
  create a page for each with placeholder content (legal pages included).
- **Cool 404 page**. **Pricing page** with plan cards and a **progress-bar
  volume selector** like Resend's; use **Resend's plans and prices as
  placeholders** (captured exactly in RESEARCH.md).
- **3D stuff**, cool coloured icons, sticky stuff, great footer, an enjoyable
  journey. Stytch is a favourite ("I want one just like it"). Polar is a
  favourite: study all its pages. Plane is nice too. itsoffbrand.com and
  landonorris.com: "like the fuck outta them".
- A **somewhat complete design system** that the dashboard can follow later.
- **Developers over businesses**: i10 is for both (sending API + mailboxes on
  your domain), dev-focused first.
- Brand: none yet. Take facts from the repo. Name: i10 = "Integration".

### Standing rules (from CLAUDE.md and memory)

- Work on branch **`feat/web-landing`** (created from fresh `origin/main`,
  upstream unset on purpose). Never commit, push, or `git add`. Finish with a
  one-line commit message for the user.
- **No em dash character anywhere** (code, copy, docs, chat). Use a hyphen.
- No worktrees. No attribution footers on GitHub.
- Dev server: a `next dev` for `@i10/web` is ALREADY running on **port 3002**
  (the user's `bun dev`). Use `http://localhost:3002` in the browser pane; do
  not start a second one. `.claude/launch.json` has a `web` entry now.
- Temporary route `apps/web/app/fonttest/` exists for type/mark exploration.
  **Delete it before handoff.**

---

## 2. i10 facts (from the repo) the copy can rely on

- `i10.tech` (web), `dash.i10.tech` (console), `auth.i10.tech`,
  `api.i10.tech`, `docs.i10.tech`, `mail.i10.tech` (Stalwart, grey-cloud).
- **Resend-compatible API**: "Keep your code, change one import."
  `resend` -> `@i10/node` (zero runtime deps). `@i10/next` has a signed webhook
  route handler. Same request/response shapes and error names.
- Keys are `i10_live_...` and `i10_test_...` (test mode exists).
- **One DKIM record to start** (`i10._domainkey`), sending in about two
  minutes. Then MX + SPF (`include:_spf.i10.tech`) move the bounce address onto
  your domain. SPF and DKIM both align; Gmail shows `mailed-by: yourdomain`.
- SES relay in **eu-central-1 (Frankfurt)**. EU is a real angle.
- Idempotency keys (a replay returns the first result). `error.retryable`;
  `rate_limit_exceeded` (retry) vs `daily_quota_exceeded` (do not).
- **Mailboxes** on your domain via Stalwart (IMAP, JMAP, SMTP), webmail
  (Bulwark), one email one password.
- **Templates**: React Email, visual editor, GitHub-connected (push to main
  goes live), render once and fill on send, images, thumbnails.
- Console areas: Emails, Broadcasts, Contacts, Segments, Topics, Templates,
  Domains, Mailboxes, API keys, Webhooks, Logs, Suppressions, Settings.
- DNS provider detection and one-click "Connect Cloudflare" (OAuth), Domain
  Connect for other registrars, provider-specific walkthroughs otherwise.
- Message bodies sealed (encrypted) into R2 packs, attachments to R2, inline
  images by Content-ID. Retention Free 3 days, Pro 30 days.
- Risk engine (rules + pgvector), sending tiers, suppression lists.
- Design tokens live in `packages/ui/src/styles/tokens.css` (shadcn + Uber
  Base motion). It says **no brand accent until a person chooses one**. The
  user has now delegated that choice; the web app sets its own accent token and
  flags it as a proposal for `packages/ui`.
- Fonts in the product today: Geist Sans/Mono; an "i10 Display" slot pointing
  at `cdn.i10.tech` (404, nothing uploaded). `infra/scripts/publish-fonts.sh`
  warns Amazon Ember's licence does not cover this use.

---

## 3. Reference sites studied (all live in the browser unless noted)

Linear, Attio, Clerk, WorkOS, Resend (+ pricing), Supabase, Neon (render
service only: it serves agent markdown to the Claude user agent), Databuddy,
Autumn (+ source), PostHog, GSAP, Bird, Vercel (home + /ai), Cloudflare, Dub,
Tailscale, Stripe, Pinecone, Stytch, Svix, Polar (home, feature page,
integrate, company, pricing doc, startup program, 404 + full source), Plane,
Raycast, Cursor, Anthropic, ElevenLabs, Webflow, Framer, Notion, Mintlify,
GitBook, Scalar, three.js, R3F/pmnd.rs, Infisical, itsoffbrand, landonorris,
lenis.dev.

Open source read: `polarsource/polar` (clients/apps/web/src/components/Landing),
`useautumn/autumn` (apps/website). Clones in the session scratchpad (not in the
repo).

Full teardown per site: **`docs/landing/RESEARCH.md`**.

---

## 4. The techniques worth stealing (how they do it)

- **Nav highlight that slides** (Linear, Resend, Cloudflare, Vercel): one
  absolutely positioned pill behind the items, moved with transform to the
  hovered item's rect. Hover color transitions 100 ms ease-out-quad
  `cubic-bezier(.25,.46,.45,.94)` (Linear).
- **One dropdown viewport that morphs** (Stripe, Resend, Cloudflare, Linear):
  a single panel whose width/height animate to the active content; content
  crossfades and slides a few px in the direction of travel; page behind dims
  or blurs (Stripe blurs, Plane dims).
- **Nav collapse on scroll** (Cloudflare, ElevenLabs): wordmark and links
  collapse, the mark stays (recoloured per section), a CTA pill stays.
- **Refractive hairline** under the header (Resend): a `backdrop-filter:
blur() brightness(2)` layer masked to 1 px.
- **Logo cells that swap** (Clerk): staggered opacity + blur + scale, 130 ms,
  `cubic-bezier(.175,.885,.32,1.1)`.
- **Framework grid hover** (Clerk): icon lifts and takes its brand color, label
  fades in under it, a dot-matrix fill fades into the cell. 450 ms
  `cubic-bezier(.33,1,.68,1)`.
- **Toggle drum** (WorkOS): vertical list stepping every ~1.5 s, center tile
  larger and shifted, toggle flips, "Ready" -> green "Enabled", striped field
  behind masked to a circle.
- **Pixel icon fill** (Autumn source): 3x3 diamond pixels sorted diagonally,
  GSAP stagger 0.025, opacity .15 -> 1, scale .8 -> 1.15 -> 1 `back.out(3)`.
- **Polar chapters** (source): hairline-topped section, left marker label,
  right two-tone headline (white + muted), then full-width content. Canvas 2D
  line-art graphics (rulers, concentric rings drawing, radial spinners, vector
  fields, text rings), inView-gated rAF, dpr-aware, reduced-motion aware,
  colors read from CSS vars.
- **Live product stories** (Cursor, Polar meter, Resend test mode): the teaser
  plays a sequence with states (spinner -> check, queued -> delivered).
- **Word reveal with random delays** (Anthropic): per-word opacity/translate
  with random 0-300 ms delays, full sentence in an sr-only span.
- **Headline pill that cycles verbs** (Notion): color + width morph.
- **Scroll-scrubbed text fill** (GSAP, Dub): words go from dim to bright as
  you scroll; Dub adds inline coloured icon tiles.
- **Scramble/decode text** (Infisical, Offbrand) and **highlighter sweep**.
- **Odometer digits** (GitBook), live ticking counters (Mintlify, Stripe GDP,
  Bird "messages since you landed").
- **Webflow footer mark is a mask**: on hover images cycle inside the glyph
  with cursor parallax. NEW/LABS badges are tiny spaced caps in the accent.
- **Resend footer**: giant wordmark `fill: white/5%`, cut by a hairline, plus a
  cursor-following radial gradient glow on the letters.
- **Status pill** (Resend): rounded-full, border white/5, gradient wash at 10%
  opacity, inset top highlight, 8 px green dot with an expanding ring, 12 px.
- **Blueprint frame** (Stytch, Attio, Autumn, Pinecone): page rails with
  notches/corner ticks at section seams, crop-mark corners on cards, cursor
  guide line (Pinecone), pixel-noise dither fields (Stytch).
- **Signature drawn on scroll** (Lando Norris), opposing giant marquees, per-
  section background color changes, chamfered card corners.
- **Offbrand**: preloader that outlines then fills the mark, iridescent WebGL
  blob reacting to the cursor, mix-blend text over it, dotted orbit rings,
  "Ask AI for a summary" links in the footer.
- **Elastic overscroll footer** (Autumn source): at the bottom, extra wheel
  lifts the page on a spring (stiffness 200, damping 15, mass .5) and recoils.

---

## 5. Decisions

### Type ("the killer mix")

- **Inter** (Fontsource variable, with the `opsz` axis) for all sans text.
  Display sizes use `opsz 32` (Inter Display), weight 560-600, tracking about
  -0.035em at 64-96 px, `font-feature-settings: "cv01","ss03"` (Linear's
  settings). Body 15-18 px, text opsz.
- **Instrument Serif italic** for rare accent words inside headlines (an
  editorial touch in the Resend/Lando spirit). Never for body.
- **Geist Mono** for labels, code, eyebrows, numbers in UI (uppercase mono
  eyebrows, `// COMMENT` labels).
- Geist Pixel is available from the `geist` package for tiny pixel details.
- Not shipping: Amazon Ember (licence), Bricolage (too quirky at display size),
  Geist Sans (too close to Vercel). Loaded via `next/font/local` from the
  installed packages so fallbacks get size-adjust and nothing shifts.

### Color

- Canvas `#0A0A0B`-ish near-black, surfaces step up in small increments,
  borders as white at 6-10%. Text: primary ~#EDEDEF, muted ~#8B8B94, faint
  ~#5A5A63.
- **Accent: "post yellow"** `oklch(0.88 0.17 95)`. The European mail color
  (Deutsche Post / Swiss Post / La Poste), and i10 sends from Frankfurt. Used
  sparingly: the mark, selection (`::selection` yellow at ~85% with near-black
  text), focus, highlighter sweeps, "New" badges, key numbers. Primary CTA
  stays a white pill.
- Product hues for icon tiles only: Sending blue, Mailboxes violet, Domains
  green, Templates pink, Webhooks orange, Deliverability cyan.
- Semantic: delivered green, bounced red, complained amber, queued blue.

### Mark

- **Option A, the slanted geometric ligature "i10"** (heavy, skewed -10deg,
  square-ish dot, chamfered 1, stadium 0). Webflow-footer energy. Refine the
  1's chamfer and the dot at small sizes. Wordmark text beside it where needed.
- Footer: giant "Integration" word (Resend/Bird) + the big yellow i10 mark
  bleeding off the bottom right (Webflow), masked content on hover.
- Recurring motifs: **postal** (postmark rings with rotating text, perforated
  stamp edges for badges, 4-state postal barcode bars for loaders/dividers)
  plus **blueprint** rails and crop marks. This is i10's own visual language.

### Stack

gsap 3.15 (+ @gsap/react, ScrollTrigger, SplitText), lenis 1.3, three 0.186,
@react-three/fiber 9, @react-three/drei 10, motion 13.4, geist 1.7,
@fontsource-variable/inter, @fontsource/instrument-serif, simple-icons (CC0
brand logos), shadcn/ui + Radix via `@repo/ui`. All installed in `apps/web`.
3D is lazy-loaded (`next/dynamic`, `ssr: false`) and paused offscreen.

---

## 6. Honesty rules for content

- No fake customer logos or testimonials. The logo marquee becomes **"Works
  with"**: frameworks, languages and DNS providers i10 actually supports.
- No fake live counters. Numbers shown are product facts ("1 DNS record",
  "~2 min", "eu-central-1", "0 runtime deps").
- The status pill must be backed by a real source: it polls
  `https://api.i10.tech/healthz`-style endpoint if one exists, otherwise shows
  a neutral "Status" link. Verify before shipping.
- Pricing uses Resend's numbers as **placeholders** and says so in a code
  comment (and nowhere misleading in the UI copy review).

---

## 7. Information architecture

- `/` home (section plan below)
- `/pricing` (plans, volume slider, compare table, add-ons, FAQ)
- `/product/*`: `email-api`, `mailboxes`, `domains`, `templates`, `webhooks`,
  `inbound`, `broadcasts`, `deliverability` (Polar feature-page template)
- `/developers`, `/changelog`, `/blog`, `/customers`, `/about`, `/careers`,
  `/brand`, `/security`, `/compare/resend`, `/migrate/resend`, `/status`
  (placeholder), `/contact`
- `/legal/privacy`, `/legal/terms`, `/legal/dpa`, `/legal/aup`,
  `/legal/cookies`, `/legal/subprocessors`
- `/design` design system page (tokens, type scale, components, motion)
- 404: "550 5.1.1 Recipient not found" bounce-notice concept (an SMTP bounce
  as the not-found page) + destination cards with live graphics (Polar).
- Docs link -> `docs.i10.tech`; Log in -> `dash.i10.tech`.

### Home section plan

1. **Nav**: floating bar, sliding highlight, morphing dropdown (Product,
   Developers, Resources), Pricing, Docs; right side Log in / Dashboard +
   "Start sending" pill. Collapses to mark + CTA on scroll.
2. **Hero**: announcement pill; headline with a cycling pill word or serif
   accent; subcopy; CTAs; `npm i @i10/node` copy chip; interactive 3D i10 mark
   (R3F, draggable, cursor-reactive).
3. **Console teaser** that scales/tilts into focus on scroll (Attio) and plays
   a story: add domain -> DNS verifies -> send -> delivered.
4. **Works-with marquee** (frameworks, languages, DNS providers).
5. **FIG 0.1 / 0.2 / 0.3** isometric line-art principles (Linear/Polar).
6. **Scroll-lit manifesto paragraph** with inline coloured icon tiles (Dub).
7. **"Change one import"** code section: diff from resend to @i10/node,
   language tabs, test-mode stream, webhook event timeline (Resend).
8. **Domains**: WorkOS-style drum of DNS records Pending -> Verified, one-click
   Connect Cloudflare, provider list.
9. **Pinned horizontal scroll** through product areas (GSAP).
10. **Mailboxes** for businesses: webmail teaser, IMAP/JMAP clients.
11. **Templates**: file tree + `git push` goes live (Vercel /ai card style).
12. **SDK/framework grid** with Clerk hover.
13. **Security/EU**: sealed bodies, DKIM signature drawn on scroll, Frankfurt.
14. **Changelog teaser** from real git history.
15. **Pricing teaser** + closing CTA.
16. **Footer**: giant "Integration", link columns with badges, status pill,
    socials, Webflow-style i10 mark, "Ask AI about i10" links.

---

## 8. Quality bar (non-negotiable)

- No layout shift: fonts with size-adjusted fallbacks, fixed media boxes,
  animations on transform/opacity only, initial hidden states set in CSS
  behind a `.js` class so no-JS still renders.
- `prefers-reduced-motion`: Lenis off, scrubs become static, loops stop.
- 3D and canvases pause offscreen and when the tab is hidden; dpr capped at 2.
- Keyboard: nav dropdowns operable, focus visible (accent ring), skip link.
- Mobile at 375 px: no horizontal scroll, 16 px gutters, nav becomes a sheet.
- Lighthouse-minded: lazy 3D, no blocking scripts, images sized.
- Verify every section in the browser pane at 1440, 1024 and 375 widths.

---

## 9. Progress checklist

- [x] Branch `feat/web-landing`, repo facts gathered
- [x] Study all reference sites live + Polar/Autumn source
- [x] Install stack in apps/web; `web` entry in .claude/launch.json
- [x] Type test (Inter Display + Instrument Serif + Geist Mono chosen)
- [x] Mark exploration (option A chosen)
- [x] Tokens + fonts + globals (design system foundation)
- [x] Layout shell: Lenis provider, nav, footer (route change resets scroll; no page-transition overlay)
- [x] Home sections (hero through closing)
- [x] Pricing page with slider
- [x] 404 (SMTP bounce notice)
- [x] Product/company/legal placeholder pages: one registry (`apps/web/lib/pages.ts`), one catch-all route, `dynamicParams = false` so anything unregistered is the 404
- [x] /design page (tokens, type scale measured live, radii, motion bench, icons, components)
- [x] Mobile pass (every route sweeps clean at 375 and 320, no horizontal overflow), reduced-motion pass (MotionConfig `user`, 3D idle gated, CSS covered), no-JS fallback for reveals
- [x] Lint (0 warnings), check-types, `next build` pass (36 static pages)
- [x] Delete `app/fonttest`, final review, one-line commit message

Open, deliberately:

- Legal, compare and blog copy is placeholder and says so on the page. Compare cells about other providers read "To verify" until checked against their docs.
- Pricing is Resend's, as asked; the mailbox add-on price is invented.
- Social links other than GitHub point at /contact until handles exist.
- PR numbers on /changelog are shown as text, not links, because the repository may be private.
