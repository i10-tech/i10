# i10 landing - reference site research

Per-site teardown gathered live in the browser (1024px pane) plus open-source code where available. Companion to BRIEF.md. Values like font sizes and letter-spacing are computed styles read from the live pages.

## i10 facts (repo)

- i10 = i + 10 letters = integration. Hosts: i10.tech (web), dash.i10.tech (console), auth.i10.tech, api.i10.tech, docs.i10.tech, mail.i10.tech
- Resend-compatible API: "Keep your code, change one import." resend/node -> @i10/node (zero deps). @i10/next webhook handler.
- Keys i10_live_ / i10_test_. Idempotency keys. error.retryable. rate_limit_exceeded vs daily_quota_exceeded.
- One DKIM record to start (i10._domainkey TXT), 2 min. Then MX send. + SPF include:_spf.i10.tech. SES eu-central-1 (Frankfurt). SPF+DKIM align, Gmail shows mailed-by customer.com
- Mailboxes via Stalwart (IMAP/JMAP/SMTP), Bulwark webmail. One email one password.
- Templates: React Email, visual editor, GitHub-connected (push to main goes live), render once fill on send.
- Console: emails, broadcasts, contacts, segments, topics, templates, domains, mailboxes, api-keys, webhooks, logs, suppressions, settings. DNS provider detection + Connect Cloudflare (OAuth), Domain Connect.
- Bodies sealed in R2 packs (encrypted), attachments to R2, inline images CID. Retention Free 3d / Pro 30d.
- Risk engine (pgvector, rules), sending tiers.
- Tokens: packages/ui tokens.css: no brand accent (by rule, "until chosen by a person"), Geist sans/mono, "i10 Display" slot on cdn.i10.tech (404 now; Amazon Ember licence warning in publish-fonts.sh). radius base 14px -> 10/12/14/18. dark bg #000, card .17, border white/12%.
- Local fonts: Amazon Ember Display (Lt/Rg/Md/Bd/He), Bricolage Grotesque variable.

## Linear

- bg #08090a, Inter Variable w510, ffs "cv01","ss03". h1 64/64 -0.022em; h2 48/48 -0.022em (second sentence grey #8a8f98 in same h2). p 15/24 #8a8f98. Berkeley Mono.
- header fixed 73px, bg transparent, backdrop blur(20px), border-bottom white/8%.
- CTA pill 32px, 13px w510, bg #e5e5e6 text dark. Secondary dark pill.
- selection: color-mix(in lch, #5e6ad2, transparent 80%)
- nav item hover: 100ms ease-out-quad (.25,.46,.45,.94) color+background pill. Buttons 160ms.
- Dropdown: single panel (border, inner lighter card w/ columns title+desc, footer row "New ... Learn more ->"), slides/resizes between triggers.
- Sections: hero -> big app window w/ perspective bottom glow; logos row + mono caption "POWERING THE COMPANIES..."; big h2 two-tone; FIG 0.1/0.2/0.3 isometric line art columns w/ vertical dividers; feature sections w/ app fragments; "Features" accordion list w/ +; changelog cards (mono date); colored testimonial cards; centered CTA "Built for the future. Available today."; footer 6 columns small logo.

## Attio (light)

- interDisplay h1 64 w600 lh.95 -0.02em; inter body 18 w500 ss03; tiempos serif for quotes; JetBrains Mono.
- Hero: stacked app windows (terminal + app + side panels) scale up/converge on scroll. Logo grid bordered cells w/ corner arrow on hover.
- Page framed by vertical rails. Sticky left index (Build pipeline / Convert leads...) with active line indicator. Workflow node graph on dotted canvas.
- "Universal Context" dark band with horizon planet arc glow + vertical light streaks.
- Serif quote with grey second half, dotted bg. Footer: "New" blue pill badge, external links with ↗.

## Clerk (light + dark bands)

- font suisse + "geistNumbers" (digits from Geist via unicode-range first in stack). h1 64/72 w700 -0.025em.
- Floating nav: inset rounded bar, sticky top; changes theme over dark sections.
- Logos: bordered cells that swap logos staggered: opacity+filter(blur)+scale .13s cubic-bezier(.175,.885,.32,1.1).
- Sections joined by chamfered (trapezoid) edges. Dark bento cards w/ subtle illustrations.
- Framework grid (dashed/hairline cells): hover -> icon brand-colored, lifts, label fades in under, cell fills with dot-matrix pattern. ease .45s cubic-bezier(.33,1,.68,1).
- Eyebrow colored small text above h2 (Frameworks cyan / Integrations purple).

## WorkOS (light, Webflow)

- Untitled Sans; h1 80/84 w500 ls -0.07em (very tight); gradient text purple->blue on 2nd line.
- Hero right: vertical drum of toggle tiles (Audit Logs, Enterprise SSO, SCIM, RBAC, Connectors, Bot Blocking, Agent Auth); steps every ~1.5s; center tile larger + shifted left, toggle flips on, "Ready" -> green "Enabled". Behind: vertical periwinkle stripes in circular radial mask. Tiles above center = on (dark toggle), below = off & faded.
- Logos in soft grey cells grid. Glossy 3D-ish app icons for features. HTTP 200 JSON code card. Footer plain.

## Resend (dark) - closest competitor

- bg #000. h1 Domaine (serif display) 96/96 -0.01em, ss01 ss04 ss05 ss11. h2 ABC Favorit 56 -0.05em. body Inter 18/27 #a1a4a5. mono Commit Mono.
- Hero 3D cube = VIDEO (4 <video>), no canvas. Badge pill "Join us at Resend Forward >".
- Header sticky 58px; after: bg-black/60 backdrop-blur-md + texture png; before: backdrop-blur-2xl backdrop-brightness-200 masked to 1px line = refractive bright hairline.
- Buttons: dark, 1px border, radius 16px, 40px tall, 14px w600.
- Nav dropdown: shared panel resizes; content crossfades + slides in direction; cards with dark 3D thumbnails.
- Sections: logos grid inside rounded top-glow panel; "Integrate this afternoon" (orange gradient word) + glossy 3D envelope icon + language icon tiles row + code panel with framework tabs + "View on GitHub / Download ZIP"; pinned "First-class developer experience" w/ Test mode (streaming HTTP 200 ids, Delivered select + Send) and Modular webhooks (event timeline: Clicked/Bounced/Complained chips + meta chips); "Develop emails using React" editor w/ file list + live preview; "Everything in your control" deliverability grid; big testimonial; dashboard metrics teaser; testimonials carousel; CTA serif "Email reimagined. Available today."; footer.
- Footer: giant wordmark SVG fill white/5%, cut by hairline; cursor-follow radialGradient glow overlay (opacity 0 -> on hover), radial light under the line. Columns: Features/Resources/Company/Help/Community. Address, socials in round 36px bordered buttons.
- Status pill: rounded-full border white/5, bg gradient white/40->white/80 @10% opacity, inset top highlight 5%, 8px green dot + ring scaling (JS), 12px text, pad 8/16/8/14, h34. hover opacity up.
- PRICING: title serif "Pricing", sub "Start for free and scale as you grow.", tabs Transactional/Marketing (pill toggle). Range slider stops (transactional): 3,000 | 50,000 | 100,000 | 200,000 | 500,000 | 1,000,000 | 1,500,000 | 2,500,000 | 3,000,000+. "Recommended" badge follows plan.
  - Free $0 3,000/mo: 100 emails a day, 3 domains, Ticket support, 10,000 automation runs, 30-day data retention, (x) SSO
  - Pro $20 @50k, $35 @100k (Extra $0.90/1,000): All Free features, 10 domains, No daily email limit, 5 webhook endpoints, 100 AI credits/mo, Additional domains with add-on, (x) SSO
  - Scale $90 @100k ($0.90), $160 @200k ($0.80), $350 @500k ($0.70), $650 @1M ($0.65), $825 @1.5M ($0.52), $1,150 @2.5M ($0.46): All Pro, 1,000 domains, Dedicated Slack channel, 10 webhook endpoints, 500 AI credits, SSO with add-on, Dedicated IP with add-on
  - Enterprise (Custom) "Performance at any scale": All Scale, 99.99% uptime SLA, Personalized migration support, Guaranteed response times, Dedicated CSM, SSO, Custom usage plan, Enterprise rate limits. Contact us.
  - Marketing stops: 1,000 | 5,000 | 10,000 | 25,000 | 50,000 | 100,000 | 150,000 | 200,000+ contacts. Free $0 1,000 contacts (Unlimited broadcast sending, Ticket support, 10,000 automation runs, 3 segments, 3 domains, 5 AI credits, Marketing analytics). Pro marketing $40@5k, $80@10k, $180@25k, $250@50k, $450@100k, $650@150k (Unlimited broadcasts, Slack & ticket support, 10k automation runs, Unlimited domains, 100 AI credits, Marketing analytics). Enterprise 200k+.
  - Add-ons: Domains $20/mo (+100), Dedicated IPs $30/mo (Scale, >3,000/day), SSO $150/mo.
  - Compare table sections: Sending & receiving (Daily limit 100/No limit.., Inbound, REST API, SMTP relay, SDKs, Schedule, Batch, Open tracking, Link tracking, React Email); Deliverability & reliability (Custom domains 3/10/1,000/Flexible, Additional domains, Dedicated IPs, IP warming, Pristine shared IPs, Auto suppression, Bounce details, Multi-region, Data retention 30d, insights, DKIM/SPF/DMARC, Webhook endpoints 1/5/10/Flexible, events); Security & privacy (Social login, SSO, GDPR, SOC2, Pentest, DDoS, Backups, MFA, API key permissions, Signed webhooks); Customer support (Ticket, Slack, SLA, Deliverability expertise, In-app docs, AI assistant); AI credits 5/100/500/Flexible.
  - FAQ: annual discounts; non-profit/education; payment methods; free trial; custom plan contact; exceed limits; transactional vs marketing; unlimited broadcast; broadcasts count?; inbound counted?

## Supabase (dark green-tint)

- bg oklch(.19 .0025 157). h1 Manrope 46 w500 two lines, second line brand green. Inter 450 body. Cta green 26px tall 12px radius 8.
- Bento product cards each with its own live illustration: auth (email list with blur), edge fn (wireframe globe + "$ supabase functions deploy"), storage (image tiles), realtime (cursors on grid), vector (3D cube w/ glowing points), data API (route pills with dashed lines).
- Two-tone line "Use one or all. Best of breed..." Logo wall. "Use Supabase with React" framework icon tabs + code. Tweet wall columns scrolling vertically w/ masks.

## Neon (via render service; site serves agent-markdown to Claude UA)

- black, big hero canvas/video top. h1 two lines. White pill + outline pill.
- Numbered chapters "▶ BUILD YOUR BACKEND" red mono eyebrow + huge dim "01" numerals; 5 product columns staggered heights; "WHERE STARTUPS START" mono uppercase on green highlight blocks (terminal selection look); stat "100K+" box over faded logo wall; terminal widget "Initialization complete" progress bar w/ checkboxes.

## Databuddy (dark #18181c, LT Superior 600)

- pixel-art mascot (bunny) + warm orange/purple radial glow. Chips row (13 KB script, Cookieless, Privacy, Open source 1,166). Tabbed dashboard preview + insight card.
- Logo wall with YC batch badges. Bento live widgets: funnel, live users area chart, web vitals rings, sessions list, error tracking, flags w/ toggles, events counts.
- Cards with crop-mark corner brackets. Heading icon "≡" pink pixel accent. Investigation checklist "0 of 7 sources checked" animating.

## Autumn (black, Geist + Geist Mono)

- Page framed by rails; triple-hairline band separators; "// PRICING MODELS" mono comment labels.
- Nav: mono uppercase items each w/ 3x3 diamond pixel icon; hover = GSAP stagger fills pixels (opacity/scale) + text brightens. Dashboard CTA purple block at right edge.
- Badge "NEW · HOW TO BUILD A CREDIT LEDGER ↗" purple tinted w/ dotted texture. h1 Geist 56 -4% mixed grey/white words. Square purple CTA with arrow icon box + vertical stripe filler. Purple dotted gradient band behind code window. Colored testimonial carousel (side cards peeking), crop-mark corners.

## PostHog

- Desktop OS metaphor (windows, desktop icons, taskbar). Humor (cookie banner). Marker highlights on key phrases, tactile 3D buttons, mascot illos. Honest pricing copy.

## GSAP (gsap 3.15, ScrollSmoother; bg #0e100f, cream #fffce1, font Mori)

- Hero giant type w/ glossy 3D shapes embedded in letters; "{ Why GSAP® }" curly-brace labels; big paragraph with scroll-scrubbed word color highlight (gradient green); sticker chips "Animate"/"Anything" tilted; tool rows (Scroll/SVG/Text/UI) with gradient 3D shapes, colored category names; showreel carousel; footer: color-coded link groups; cream newsletter footer band.

## Bird (warm black #100f0c, TWK Lausanne 400; jetbrainsMono; "Fake Receipt" font)

- h1 64 -0.045em, second line grey. 3D globe canvas w/ city lights + pulse arcs + live counter "≈1,865,249 messages since you landed". MCP demo "Send a welcome email. Let me know when it arrives." tool rows email_send Sending. SDK tabs row. Links row with ↗. "Ready to build?" CTA. Footer giant "Bird" wordmark + ASCII art at very bottom; "● All Systems Operational" right.

## Vercel (black, Geist)

- h1 64 w400 -0.06em; h2 56 w450 -0.06em. Hero glowing triangle w/ grain halo (canvas). Logos row.
- Sticky split: left big stat sentence (white + grey) + "Features" list; right product screenshots. "Recently shipped" cards.
- /ai: 3 hairline-framed cards: AI Gateway orbit rings w/ provider icon nodes around center logo; Sandbox auto-scrolling step list (Execute ✓ pnpm install) w/ fade masks; eve file tree w/ faint architecture boxes. Title: bold name + grey desc same para. White pill "Start now" + "Read the docs ›".
- Footer: "New" grey badges; mono blue "● ALL SYSTEMS NORMAL."; theme switch.

## Cloudflare (warm dark #151414, cream #fffbf5, FT Kunst Grotesk 500, Apercu Mono)

- h1 56 -0.025em. Hero = inset orange rounded card (8px margin) w/ dot texture + sun glow at bottom. Pill badge "Connect 2026 ... (->)".
- Nav: logo + items with up/down chevrons; "Under attack?" red; Login + Contact sales pills; search circle. On hover a bordered highlight pill SLIDES between items; dropdown panel resizes (w/h) and content crossfades; panel radius ~12, columns split by hairlines, footer row (orange link + small links).
- On scroll down: nav items + wordmark collapse, only cloud mark remains top-left (white over orange hero, orange over dark; multiple colored logo layers crossfade), floating orange "Start building" pill at right. Scroll up restores.
- "Region: Earth" dotted globe w/ orange nodes + callout boxes w/ corner ticks. 3-col feature strip w/ crop-mark corners.

## Dub (light) - scroll paragraph: lines brighten grey->ink as you scroll, inline colored icon tiles after keywords, tilted floating UI cards + icon tiles w/ parallax, dotted bg inside rails. Logo grid with CASE STUDY tags. Webhook node diagram "New Event / Lead created". Tabs w/ active left bar.

## Tailscale (warm off-white) - product tabs (active = filled red card), big stat cards, blue gradient band, tweet cards, dark CTA card, mono small caps.

## Stripe - WebGL ribbon gradient hero, live "Global GDP running on Stripe" counter, two-tone h1 paragraph, gradient bento, particle globe, rails.

## Stytch (warm light, Booton 700 + Chivo Mono) - BLUEPRINT: page framed by double rails w/ L notches at every section seam; mono nav/buttons; chartreuse announcement badge; monochrome 1px line-art UI drawings; dark bands w/ animated pixel noise (dither) behind code; ⌘ bullets; accordion w/ square bullets; pastel icon squares; footer big clipped wordmark.

## Pinecone - "SELECT EXPERIENCE: Builder/Business Leader" toggle; agent install tabs (Claude Code/Cursor/...); madlib estimator "I'm building a [RAG pipeline] for a [production app]"; "{lower cost}" brace tags; corner-tick frame on CTA.

## Svix - logo grid w/ blue corner flags; hexagon bullets; mono body; giant SVIX footer wordmark on blue band; "We're Hiring" badge.

## Cursor - warm grey; product windows in tinted panels; alternating text/visual.

## Anthropic - kinetic hero: words of two phrases interleave/strike/fade ("products / safety / and put / the frontier"); release cards w/ mono DATE/CATEGORY/DETAILS rows.

## ElevenLabs - gradient orb carousel, bento w/ pastel gradients, rails w/ corner ticks.

## Webflow - "What [marketing teams ▾] love about Webflow" inline select; footer giant blue W mark cropped bottom-right + "Made in Webflow" badge.

## Framer - dark; neon-blue glowing prompt input hero.

## Notion - inline pill in headline "agents ● Think together"; stats ticker row with icons.

## Mintlify - "Agent traffic 69.8291%" live counter badge; "Agents at work today" ticker w/ mono live counters; green accent bar left of headings.

## GitBook - orange 3D tube knot hero; agent traffic tracker; "Get started with AI" Claude/ChatGPT/Cursor pill tabs + copy prompt.

## Scalar - landing laid out like the docs app (left sidebar nav); tilted 3D stickers; founder letter.

## POLAR (focus; dark #0a0a0a, PP Neue Montreal 400; Inter/InterDisplay; GeistMono) - studied live + source (polarsource/polar clients/apps/web/src/components/Landing)

- Announcement bar top (#141414) "Introducing ... ->". Nav 88px: logo, grey links (white on hover/active), Sign in, white pill "Get Started >" (14px w550, pad 12/20, h40).
- Features = full-width mega panel w/ large type links (Usage Billing / Subscriptions / MoR ~30px) + "More Features" column; bg matches page, hairline bottom.
- Hero: "Meet Polar" white + muted grey continuation, 36/45. MissionRulers: canvas rulers w/ ticks scrolling (tokens 210M..270M; revenue $42k..$66k), current value in white pill w/ caret, bump near pointer; sine-swell rate. "Tokens in, / revenue out" centered two-tone 48.
- CHAPTER pattern: hairline top border; grid 2 cols: left marker name ("Primitives", "Platform", "Meter anything", "Sell globally", "Unit economics", "What people say", "Pricing"), right two-tone headline (white + muted) + muted description ~20px; then content full width.
- Cards: bg #141414 on #0a0a0a, square corners, no borders; top = canvas line-art graphic (white strokes, dim rings), bottom = title 24 + muted desc. Graphics: rolling circles, serpentine line drawing w/ arrow, + x o * glyphs, radial spinners (line bursts), concentric rings drawing, vector field arrows, text rings "POLAR" swirling, isometric stacked-contour logo.
- Graphics code: canvas 2D, inView-gated rAF, dpr scale, colors from CSS vars --color-graphic-stroke/--color-graphic-dim, reduced-motion aware, cubic ease.
- Platform vignettes: mini product UIs (meter progress, "Pay $20" -> Processing, "Payout $9,311 · Wiring payout...") on grainy B&W wave photographs.
- Meter: code card "events.ingest({ name: 'gpt.seconds', value: 38 })" spinner "Metering 38 GPU seconds" -> "✓ Metered · $0.0456 added to Northwind's invoice".
- MoR: flow list w/ green check circles, arrow down, "Merchant Payout $9,311" green.
- Testimonial: logo tiles row (4), big centered quote card, author tabs.
- Pricing: 2x2 plan cards + Startup program card with isometric logo.
- Footer: logo+wordmark left, "Get Started ↗" underlined, columns right (Features/Resources/Company/Support), © line.
- Feature page: split hero (two-tone text + CTA pills | graphic card), chapters w/ keywords in white inside muted prose, hairline list rows (term + muted desc), 2x2 detail cards.
- Integrate: hero card cycles MCP/SDK/CLI/API w/ agent prompt typing; code tabs (Claude Code/Cursor/Codex/...) + Copy on grainy image.
- Company: B&W team photo, mission prose. 404: "404" left, "Sorry / We can't find the page..." right, destination cards each w/ live graphic + ↗.
- Resource pricing: doc layout, TOC rows w/ ↓, left label/right prose, tables.

## LIVE REDOS + remaining

- Plane (light, Satoshi 430): app shot over painterly blurred photo; mega menu: icon+title+desc grid, promo cards right (Self-host; "Works with your stack" chips ↗), bottom strip "New: ... Release v3.3.0 Learn more" + "Download app"; page dims behind. Autoplay tabs with progress line on top of active tab. "COMING SOON" tag. Footer: compare list, download buttons.
- Tailscale: mostly static; hamburger at this width.
- Stripe: mega menu blurs page behind (backdrop blur), panel morphs height, content slides horizontally between tabs, chevron morphs. GDP counter ticks. Bento cards swap gradient art -> live UI.
- Pinecone: vertical guide line follows cursor x (blueprint crosshair); stat rows w/ bar indicators.
- Svix: hex nut graphics, chrome exploded plates; footer SEO guides "Send/Receive webhooks with <lang>".
- Cursor (dark #14120b, CursorGothic + EB Garamond + Berkeley Mono): hero app demo PLAYS a story (tasks move In progress -> Ready for review, agent reads/writes files) over oil-painting landscape.
- Anthropic: h1 words reveal with RANDOM per-word delays (0-300ms) opacity+translateY; sr-only full text; links underlined inside heading.
- ElevenLabs: nav collapses on scroll to mark + CTAs; orb carousel.
- Webflow: footer giant W is a MASK: on hover images cycle inside the W with cursor parallax translate. Footer badges: tiny uppercase letterspaced blue "NEW"/"LABS" text (not pills). Inline select "What [marketing teams ▾] love about Webflow".
- Framer: prompt box types prompt & zooms; mega menu type columns + Updates card.
- Notion: pill in headline cycles verbs (Think->Ship...) w/ color + width morph.
- Mintlify (dark): flowing green line bundles (string art), agent traffic % ticking.
- GitBook: 3D knot unwinds on scroll into band behind product; odometer digits.
- Scalar: docs-app shaped landing w/ sidebar + floating Ask bar.
- Raycast (#07080a, Inter 600 64): floating glass nav bar; WebGL grainy red diagonal beams; 3D keycap grid w/ feature keys; agent demo steps; extension cards w/ colored glow; newsletter footer.
- Infisical: highlighter sweep on key words; scramble->decode mono caption; env matrix ✓/✗; "Machine version" footer toggle.
- Offbrand (#1d1d1d, Ataero): preloader logo outline -> liquid fill + BUILD counter; WebGL iridescent blob dents under cursor; text mix-blend over blob; letter scramble reveal; dotted orbit rings; logo grid w/ + crosshairs; parallax masonry; blob -> thumbnail cloud; inverted-corner gradient panel; footer "ASK AI FOR A SUMMARY" (Claude/ChatGPT/Perplexity/Gemini icons); custom cursor dot.
- Lando Norris: preloader "LOAD NORRIS"; 3D helmet follows cursor over portrait; topo contour bg; SVG signature scribble draws on scroll; opposing marquee giant text; serif italic accent words in grotesk caps; section bg color changes; helmet cards w/ chamfered corner.
- Lenis site: pinned heading while right column scrolls; Lenis defaults lerp .1.
- Autumn source: nav pixels sorted diagonally, gsap timeline stagger .025 opacity .15->1 scale .8->1.15->1 back.out(3), fill -> white; lazy gsap import; volume slider = native range w/ --slider-progress + clickable mono tick labels; elastic footer: overscroll at bottom lifts page w/ spring (stiffness 200 damping 15 mass .5) revealing footer image then recoils.
- Neon: cannot view human site live (serves agent markdown to Claude UA).
