import { FILLERS, FillContext } from "./fill.js"
import { makeRng, pick } from "./rng.js"
import {
  type Block,
  type GeneratedMail,
  MARKETING_TYPES,
  type Style,
  type Template,
  isHardNegativeType,
} from "./types.js"

/**
 * Turns one authored template into one mail: picks the wordings, fills the
 * placeholders, and renders the same blocks to a plain-text body and an HTML
 * body in the template's house style.
 */

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)(?::([a-z0-9_-]+))?\}/g
const CHOICE = /\[\[([^\]]*)\]\]/g
/** What must not survive rendering: a brace or a choice marker. */
const UNFILLED = /[{}]|\[\[|\]\]/

/** Labels of the order block; order mail is written in English only. */
const ORDER_LABELS = { subtotal: "Subtotal", shipping: "Shipping", total: "Total" }

interface Look {
  font: string
  page: string
  width: number
  radius: number
  header: "none" | "brand" | "band" | "logo"
  button: "link" | "pill" | "solid"
  size: number
}

const LOOKS: Record<Style, Look> = {
  "dev-terse": {
    font: "ui-monospace, Menlo, Consolas, monospace",
    page: "#ffffff",
    width: 540,
    radius: 0,
    header: "none",
    button: "link",
    size: 14,
  },
  "consumer-friendly": {
    font: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
    page: "#f3f4f6",
    width: 560,
    radius: 12,
    header: "brand",
    button: "pill",
    size: 16,
  },
  "formal-bank": {
    font: "Arial, Helvetica, sans-serif",
    page: "#eef1f5",
    width: 600,
    radius: 0,
    header: "band",
    button: "solid",
    size: 15,
  },
  "small-shop": {
    font: "Georgia, 'Times New Roman', serif",
    page: "#faf7f2",
    width: 560,
    radius: 4,
    header: "logo",
    button: "solid",
    size: 16,
  },
}

const ACCENTS = ["#2457d6", "#0f766e", "#b4233c", "#6d28d9", "#c2410c", "#1f2937"]

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function multiline(s: string): string {
  return escapeHtml(s).replace(/\n/g, "<br>")
}

class Renderer {
  constructor(
    private readonly t: Template,
    private readonly ctx: FillContext,
  ) {}

  /** Chooses among `[[a|b]]`, then fills placeholders. Fails on anything left over. */
  fill(source: string): string {
    const chosen = source.replace(CHOICE, (_, body: string) =>
      pick(this.ctx.rng, body.split("|")),
    )
    const filled = chosen.replace(PLACEHOLDER, (_, key: string, arg?: string) => {
      if (key === "link") {
        if (arg === undefined) throw new Error(`${this.t.id}: {link} needs a path`)
        return this.ctx.link(arg)
      }
      const filler = FILLERS[key]
      if (filler === undefined)
        throw new Error(`${this.t.id}: unknown placeholder {${key}}`)
      return this.ctx.once(`fill:${key}`, () => filler(this.ctx))
    })
    if (UNFILLED.test(filled)) {
      throw new Error(`${this.t.id}: unfilled placeholder or choice in "${filled}"`)
    }
    return filled
  }

  private orderRows(): { lines: string[]; totals: [string, string][] } {
    const order = this.ctx.order()
    return {
      lines: order.lines.map(
        (l) => `${l.quantity} x ${l.name} - ${this.ctx.money(l.price * l.quantity)}`,
      ),
      totals: [
        [ORDER_LABELS.subtotal, this.ctx.money(order.subtotal)],
        [ORDER_LABELS.shipping, this.ctx.money(order.shipping)],
        [ORDER_LABELS.total, this.ctx.money(order.total)],
      ],
    }
  }

  footer(): string[] {
    const f = this.ctx.pack.footer
    const marketing = MARKETING_TYPES.includes(this.t.type)
    const reason = this.fill(marketing ? f.subscribed : f.received)
    const help = this.fill(f.help)
    const sentBy = this.fill(f.sentBy)
    const lines: string[] = []
    switch (this.t.style) {
      case "dev-terse":
        if (marketing) lines.push(reason)
        break
      case "consumer-friendly":
        lines.push(reason, help)
        break
      case "formal-bank":
        lines.push(this.fill(f.automated))
        break
      case "small-shop":
        lines.push(reason)
        break
    }
    if (marketing) {
      lines.push(`${f.unsubscribe}: ${this.ctx.link("unsubscribe")}`)
      lines.push(`${f.preferences}: ${this.ctx.link("preferences")}`)
    } else if (this.t.type === "weekly-digest") {
      lines.push(`${f.preferences}: ${this.ctx.link("preferences")}`)
    }
    lines.push(sentBy)
    return lines
  }

  /** Chooses wordings and fills every string of the body, once, for both renderings. */
  resolve(blocks: Block[]): Block[] {
    return blocks.map((block): Block => {
      if (typeof block === "string") return this.fill(block)
      if ("cta" in block)
        return { cta: this.fill(block.cta), url: this.fill(block.url) }
      if ("code" in block) return { code: this.fill(block.code) }
      if ("rows" in block)
        return { rows: block.rows.map(([k, v]) => [this.fill(k), this.fill(v)]) }
      if ("list" in block) return { list: block.list.map((i) => this.fill(i)) }
      if ("note" in block) return { note: this.fill(block.note) }
      return block
    })
  }

  text(blocks: Block[], footer: string[]): string {
    const parts: string[] = []
    for (const block of blocks) {
      if (typeof block === "string") parts.push(block)
      else if ("cta" in block) parts.push(`${block.cta}: ${block.url}`)
      else if ("code" in block) parts.push(block.code)
      else if ("rows" in block)
        parts.push(block.rows.map(([k, v]) => `${k}: ${v}`).join("\n"))
      else if ("list" in block)
        parts.push(block.list.map((item) => `- ${item}`).join("\n"))
      else if ("note" in block) parts.push(block.note)
      else {
        const { lines, totals } = this.orderRows()
        parts.push([...lines, ...totals.map(([k, v]) => `${k}: ${v}`)].join("\n"))
      }
    }
    parts.push(footer.join("\n"))
    return parts.join("\n\n")
  }

  html(blocks: Block[], footer: string[], subject: string): string {
    const look = LOOKS[this.t.style]
    const accent = pick(this.ctx.rng, ACCENTS)
    const product = escapeHtml(this.ctx.brand().name)
    const body: string[] = []
    const p = `margin:0 0 16px;line-height:1.55`
    for (const block of blocks) {
      if (typeof block === "string") {
        body.push(`<p style="${p}">${multiline(block)}</p>`)
      } else if ("cta" in block) {
        const href = escapeHtml(block.url)
        const label = escapeHtml(block.cta)
        const style =
          look.button === "link"
            ? `color:${accent};text-decoration:underline`
            : `display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:${look.button === "pill" ? 999 : 4}px;font-weight:600`
        body.push(
          `<p style="margin:0 0 20px"><a href="${href}" style="${style}">${label}</a></p>`,
        )
      } else if ("code" in block) {
        body.push(
          `<p style="margin:0 0 20px;font:600 28px ui-monospace, Menlo, monospace;letter-spacing:4px">${escapeHtml(block.code)}</p>`,
        )
      } else if ("rows" in block) {
        const rows = block.rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 16px 4px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`,
          )
          .join("")
        body.push(
          `<table role="presentation" style="margin:0 0 16px;border-collapse:collapse">${rows}</table>`,
        )
      } else if ("list" in block) {
        const items = block.list.map((i) => `<li>${escapeHtml(i)}</li>`).join("")
        body.push(
          `<ul style="margin:0 0 16px;padding-left:20px;line-height:1.55">${items}</ul>`,
        )
      } else if ("note" in block) {
        body.push(
          `<p style="margin:0 0 16px;font-size:13px;color:#6b7280;line-height:1.5">${multiline(block.note)}</p>`,
        )
      } else {
        const { lines, totals } = this.orderRows()
        const rows = lines
          .map(
            (l) =>
              `<tr><td style="padding:6px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(l)}</td></tr>`,
          )
          .join("")
        const sums = totals
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 0">${escapeHtml(k)}: ${escapeHtml(v)}</td></tr>`,
          )
          .join("")
        body.push(
          `<table role="presentation" style="margin:0 0 16px;width:100%;border-collapse:collapse">${rows}${sums}</table>`,
        )
      }
    }
    const header = {
      none: "",
      brand: `<div style="font-weight:700;font-size:18px;color:${accent};margin:0 0 20px">${product}</div>`,
      band: `<div style="background:${accent};color:#ffffff;padding:16px 28px;font-weight:700;font-size:18px">${product}</div>`,
      logo: `<div style="text-align:center;letter-spacing:3px;text-transform:uppercase;font-size:14px;margin:0 0 24px;color:${accent}">${product}</div>`,
    }[look.header]
    const small = footer.map((l) => escapeHtml(l)).join("<br>")
    const padding =
      look.header === "band" ? "28px" : look.header === "none" ? "0" : "28px"
    const dir = this.ctx.pack.dir
    return [
      "<!doctype html>",
      `<html lang="${this.t.lang}" dir="${dir}">`,
      `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>`,
      `<body style="margin:0;padding:24px 12px;background:${look.page};font-family:${look.font};font-size:${look.size}px;color:#111827">`,
      `<div style="max-width:${look.width}px;margin:0 auto;background:#ffffff;border-radius:${look.radius}px;overflow:hidden">`,
      look.header === "band" ? header : "",
      `<div style="padding:${padding}">`,
      look.header === "band" ? "" : header,
      ...body,
      `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280">${small}</p>`,
      "</div></div></body></html>",
    ].join("\n")
  }
}

export function renderTemplate(
  t: Template,
  opts: { seed: string; index: number; year: number },
): GeneratedMail {
  const rng = makeRng(`${opts.seed}\0${t.id}\0${opts.index}`)
  const ctx = new FillContext({ rng, lang: t.lang, style: t.style, year: opts.year })
  const r = new Renderer(t, ctx)
  const subject = r.fill(pick(rng, t.subject))
  const footer = r.footer()
  const blocks = r.resolve(t.body)
  const text = r.text(blocks, footer)
  const html = r.html(blocks, footer, subject)
  return {
    key: `${t.id}#${opts.index}`,
    templateId: t.id,
    type: t.type,
    style: t.style,
    lang: t.lang,
    hardNegative: isHardNegativeType(t.type),
    subject,
    text,
    html,
    fromDomain: ctx.senderDomain(),
  }
}
