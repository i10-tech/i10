/**
 * The backup codes as a PDF, drawn like the console (2026-10-12): the same
 * card on the same page colour, Inter for words and Geist Mono for codes,
 * the muted panel the codes sit in on screen, and the radii the console's
 * surfaces use. Built in the browser - the codes never leave it.
 *
 * ⚠ THE COLOURS ARE READ FROM THE PAGE, NOT COPIED INTO HERE. The tokens are
 * `oklch()` and differ between themes; resolving them through a canvas pixel
 * turns whatever the console is showing right now into the RGB a PDF needs,
 * so a dark console saves a dark sheet and a light one a light sheet.
 *
 * ⚠ AND THE FONTS ARE STATIC FILES, because a PDF embeds one weight at a
 * time: the console's Inter is a variable web font, so /fonts/pdf holds the
 * two static weights from Fontsource (OFL) and Geist Mono's regular cut.
 * pdf-lib and the fonts load only when somebody presses Save.
 */

type Rgb = { r: number; g: number; b: number }

/** A CSS colour (a token's value, oklch or not) as 0-1 RGB, via one canvas pixel. */
function resolve(token: string, fallback: Rgb): Rgb {
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(token)
      .trim()
    if (!value) return fallback
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d")
    if (!ctx) return fallback
    // The page colour underneath, so a translucent token lands as seen.
    ctx.fillStyle = "#000"
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
    return { r: r / 255, g: g / 255, b: b / 255 }
  } catch {
    return fallback
  }
}

/**
 * The i10 mark (packages/ui mark.tsx) as plain paths a PDF can fill.
 *
 * ⚠ RE-DRAWN, NOT COPIED, BECAUSE TWO THINGS IN THE SVG DO NOT SURVIVE.
 * The mark is `skewX(-10)` with an even-odd hole in the 0, and pdf-lib's
 * path filler takes neither. So the same shapes are rebuilt here with their
 * arcs as cubic curves - a skew is affine, so skewing the control points is
 * exact - and the hole comes back as a second path in the card's colour.
 * Coordinates are the mark's own viewBox, "-17.7 0 155.4 100".
 */
function markPaths(): { solid: string; hole: string } {
  const t = Math.tan((10 * Math.PI) / 180)
  const k = 0.5523 // a quarter circle as one cubic
  const pt = (x: number, y: number) =>
    `${(x - t * y + 17.7).toFixed(3)} ${y.toFixed(3)}`
  const poly = (points: [number, number][]) =>
    `M ${points.map(([x, y]) => pt(x, y)).join(" L ")} Z`
  /** A stadium: straight sides, round ends of radius `r`, centred on `cx`. */
  const stadium = (cx: number, top: number, bottom: number, r: number) => {
    const c = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) =>
      `C ${pt(x1, y1)} ${pt(x2, y2)} ${pt(x, y)}`
    const yt = top + r
    const yb = bottom - r
    return [
      `M ${pt(cx - r, yt)}`,
      c(cx - r, yt - k * r, cx - k * r, top, cx, top),
      c(cx + k * r, top, cx + r, yt - k * r, cx + r, yt),
      `L ${pt(cx + r, yb)}`,
      c(cx + r, yb + k * r, cx + k * r, bottom, cx, bottom),
      c(cx - k * r, bottom, cx - r, yb + k * r, cx - r, yb),
      "Z",
    ].join(" ")
  }
  return {
    solid: [
      poly([
        [0, 0],
        [24, 0],
        [24, 22],
        [0, 22],
      ]),
      poly([
        [0, 32],
        [24, 32],
        [24, 100],
        [0, 100],
      ]),
      poly([
        [36, 18],
        [54, 0],
        [60, 0],
        [60, 100],
        [36, 100],
      ]),
      stadium(108, 0, 100, 36),
    ].join(" "),
    hole: stadium(108, 26, 74, 12),
  }
}

/** An SVG path for a rounded rectangle, from its top-left corner. */
function roundRect(width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height / 2)
  return [
    `M ${r} 0`,
    `H ${width - r}`,
    `A ${r} ${r} 0 0 1 ${width} ${r}`,
    `V ${height - r}`,
    `A ${r} ${r} 0 0 1 ${width - r} ${height}`,
    `H ${r}`,
    `A ${r} ${r} 0 0 1 0 ${height - r}`,
    `V ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    "Z",
  ].join(" ")
}

export type PdfColours = Record<
  "background" | "card" | "border" | "panel" | "foreground" | "secondary" | "muted",
  Rgb
>

/** The console's colours as they are on screen right now. */
export function pageColours(): PdfColours {
  return {
    background: resolve("--background", { r: 0.11, g: 0.11, b: 0.11 }),
    card: resolve("--surface-raised", { r: 0.15, g: 0.15, b: 0.15 }),
    border: resolve("--border", { r: 0.2, g: 0.2, b: 0.2 }),
    panel: resolve("--surface-muted", { r: 0.17, g: 0.17, b: 0.17 }),
    foreground: resolve("--foreground", { r: 0.94, g: 0.94, b: 0.94 }),
    secondary: resolve("--text-secondary", { r: 0.7, g: 0.7, b: 0.7 }),
    muted: resolve("--text-muted", { r: 0.55, g: 0.55, b: 0.55 }),
  }
}

/**
 * Fetches the fonts, builds the PDF in the page's colours, and saves it.
 * Resolves `"saved"` once the file is written, or `"cancelled"`.
 *
 * ⚠ IT WAITS FOR THE PERSON, NOT JUST FOR THE BYTES (2026-10-12). Where the
 * browser has a real save dialog (`showSaveFilePicker`: Chrome, Edge) this
 * resolves when they press Save there and the file is on disk, and a Cancel
 * is a cancel. Elsewhere a download has no such signal, so it resolves when
 * the window comes back into focus after the download prompt - or after a
 * moment, when the browser saves without asking and focus never leaves.
 */
export async function saveBackupCodesPdf(input: {
  codes: string[]
  email: string | null
}): Promise<"saved" | "cancelled"> {
  const [inter400, inter500, mono] = await Promise.all(
    ["inter-400.woff", "inter-500.woff", "geist-mono-400.ttf"].map((name) =>
      fetch(`/fonts/pdf/${name}`).then((r) => {
        if (!r.ok) throw new Error(`Could not load ${name}`)
        return r.arrayBuffer()
      }),
    ),
  )
  const bytes = await buildBackupCodesPdf({
    ...input,
    fonts: { regular: inter400!, medium: inter500!, mono: mono! },
    colours: pageColours(),
    date: new Date(),
  })
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" })
  const name = "i10-backup-codes.pdf"

  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName: string
        types: { description: string; accept: Record<string, string[]> }[]
      }) => Promise<{
        createWritable(): Promise<{
          write(data: Blob): Promise<void>
          close(): Promise<void>
        }>
      }>
    }
  ).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return "saved"
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return "cancelled"
      // A picker the page may not use (a cross-origin frame): download instead.
    }
  }

  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  document.body.append(link)
  const back = new Promise<void>((resolve) => {
    let left = false
    const onBlur = () => (left = true)
    const onFocus = () => {
      if (!left) return
      done()
    }
    const done = () => {
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
      window.clearTimeout(quiet)
      resolve()
    }
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
    // No prompt took focus away: the browser saved it straight to Downloads.
    const quiet = window.setTimeout(() => {
      if (!left) done()
    }, 1200)
  })
  link.click()
  link.remove()
  await back
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return "saved"
}

/** The PDF itself: pure, so it can be rendered and looked at outside a browser. */
export async function buildBackupCodesPdf({
  codes,
  email,
  fonts,
  colours,
  date,
}: {
  codes: string[]
  email: string | null
  fonts: { regular: ArrayBuffer; medium: ArrayBuffer; mono: ArrayBuffer }
  colours: PdfColours
  date: Date
}): Promise<Uint8Array> {
  const [{ PDFDocument, rgb }, fontkit] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit").then((m) => m.default),
  ])
  const inter400 = fonts.regular
  const inter500 = fonts.medium
  const mono = fonts.mono

  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  pdf.setTitle("i10 backup codes")
  pdf.setCreator("i10")
  pdf.setProducer("i10")
  const regular = await pdf.embedFont(inter400, { subset: true })
  const medium = await pdf.embedFont(inter500, { subset: true })
  const code = await pdf.embedFont(mono, { subset: true })

  const fill = (c: Rgb) => rgb(c.r, c.g, c.b)
  const page = {
    background: fill(colours.background),
    card: fill(colours.card),
    border: fill(colours.border),
    panel: fill(colours.panel),
    foreground: fill(colours.foreground),
    secondary: fill(colours.secondary),
    muted: fill(colours.muted),
  }

  // A4, in points.
  const W = 595.28
  const H = 841.89
  const sheet = pdf.addPage([W, H])
  sheet.drawRectangle({ x: 0, y: 0, width: W, height: H, color: page.background })

  const margin = 48
  const pad = 32
  const cardW = W - margin * 2
  const inner = cardW - pad * 2

  /** Wraps `text` to `width` at `size`, returning the lines. */
  const wrap = (text: string, font: typeof regular, size: number, width: number) => {
    const lines: string[] = []
    let line = ""
    for (const word of text.split(" ")) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line)
        line = word
      } else line = next
    }
    if (line) lines.push(line)
    return lines
  }

  const intro = wrap(
    "Each code signs you in once if you lose access to your authenticator app. Keep them somewhere safe and private - anyone with a code and your password can sign in as you.",
    regular,
    11,
    inner,
  )
  const rows = Math.ceil(codes.length / 2)
  const rowH = 30
  const panelPad = 20
  const panelH = rows * rowH + panelPad * 2 - 8

  // Heights, top to bottom, so the card is drawn once at its final size.
  const cardH =
    pad + 22 + 28 + 26 + 16 + 18 + 24 + intro.length * 17 + 24 + panelH + 28 + 34 + pad
  const top = margin
  sheet.drawSvgPath(roundRect(cardW, cardH, 26), {
    x: margin,
    y: H - top,
    color: page.card,
    borderColor: page.border,
    borderWidth: 1,
  })

  // `cursor` is the top of the next line, measured down from the card's top.
  let cursor = top + pad
  const text = (
    value: string,
    font: typeof regular,
    size: number,
    fill: ReturnType<typeof rgb>,
    x = margin + pad,
  ) => sheet.drawText(value, { x, y: H - cursor - size, size, font, color: fill })

  // The mark, 20pt tall as in the console's corner.
  const mark = markPaths()
  const markScale = 20 / 100
  sheet.drawSvgPath(mark.solid, {
    x: margin + pad,
    y: H - cursor,
    scale: markScale,
    color: page.foreground,
  })
  sheet.drawSvgPath(mark.hole, {
    x: margin + pad,
    y: H - cursor,
    scale: markScale,
    color: page.card,
  })
  cursor += 22 + 28
  text("Backup codes", medium, 22, page.foreground)
  cursor += 26 + 16
  if (email) text(`For ${email}`, regular, 12, page.secondary)
  cursor += 18
  text(
    `Generated ${date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    })}`,
    regular,
    10,
    page.muted,
  )
  cursor += 24
  for (const line of intro) {
    text(line, regular, 11, page.secondary)
    cursor += 17
  }
  cursor += 24

  // The muted panel the codes sit in on screen, in two columns.
  sheet.drawSvgPath(roundRect(inner, panelH, 16), {
    x: margin + pad,
    y: H - cursor,
    color: page.panel,
  })
  const colW = inner / 2
  codes.forEach((value, index) => {
    const column = index < rows ? 0 : 1
    const row = index < rows ? index : index - rows
    const x = margin + pad + panelPad + column * colW
    const y = H - (cursor + panelPad + row * rowH) - 14
    sheet.drawText(String(index + 1).padStart(2, "0"), {
      x,
      y: y + 1,
      size: 9,
      font: code,
      color: page.muted,
    })
    sheet.drawText(value, {
      x: x + 24,
      y,
      size: 14,
      font: code,
      color: page.foreground,
    })
  })
  cursor += panelH + 28

  for (const line of wrap(
    "A used code stops working. Regenerating them under Security in your i10 account replaces every code on this sheet.",
    regular,
    10,
    inner,
  )) {
    text(line, regular, 10, page.muted)
    cursor += 15
  }

  return pdf.save()
}
