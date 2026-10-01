"use client"

import { useEffect, useRef } from "react"
import { prefersReducedMotion } from "@/lib/gsap"

/*
 * Line graphics in Polar's manner: monochrome strokes on a canvas, one accent
 * colour, always moving a little. Each variant is a small drawing about the
 * thing it sits next to - rings for sending (a message leaving in every
 * direction), a burst for webhooks, a flow field for broadcasts, a gauge for
 * deliverability, a stack for mailboxes, a branch for templates.
 *
 * Built like Polar's (clients/apps/web/src/components/Landing/graphics):
 * canvas 2D, devicePixelRatio-aware, only animating while on screen, and a
 * single still frame under prefers-reduced-motion.
 */
export type GraphicVariant = "rings" | "burst" | "field" | "gauge" | "stack" | "branch"

export function LineGraphic({ variant, accent = "var(--brand)", className }: { variant: GraphicVariant; accent?: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return

    const probe = document.createElement("span")
    probe.style.color = accent
    document.body.appendChild(probe)
    const accentColor = getComputedStyle(probe).color
    probe.remove()
    const stroke = "rgba(255,255,255,0.72)"
    const dim = "rgba(255,255,255,0.12)"

    let w = 0
    let h = 0
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    const draw = DRAWERS[variant]
    let frame = 0
    let start = performance.now()
    let running = false

    const loop = (now: number) => {
      const t = (now - start) / 1000
      ctx.clearRect(0, 0, w, h)
      draw(ctx, w, h, t, { stroke, dim, accent: accentColor, ease })
      if (running) frame = requestAnimationFrame(loop)
    }

    if (prefersReducedMotion()) {
      draw(ctx, w, h, 2.2, { stroke, dim, accent: accentColor, ease })
      return () => ro.disconnect()
    }

    // Starts (from its first frame) once 40% of it is on screen, so a card
    // sliding in from the edge draws itself in front of the reader instead
    // of having already played; stops only when it is fully gone.
    const io = new IntersectionObserver(
      ([entry]) => {
        const ratio = entry?.intersectionRatio ?? 0
        if (ratio >= 0.4 && !running) {
          running = true
          start = performance.now()
          frame = requestAnimationFrame(loop)
        } else if (ratio === 0 && running) {
          running = false
          cancelAnimationFrame(frame)
        }
      },
      { threshold: [0, 0.4] },
    )
    io.observe(canvas)

    return () => {
      running = false
      cancelAnimationFrame(frame)
      io.disconnect()
      ro.disconnect()
    }
  }, [variant, accent])

  return <canvas ref={canvasRef} aria-hidden className={className ?? "size-full"} />
}

type Palette = { stroke: string; dim: string; accent: string; ease: (t: number) => number }
type Drawer = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, p: Palette) => void

const DRAWERS: Record<GraphicVariant, Drawer> = {
  // Concentric rings drawing themselves in, inner to outer, a message leaving.
  rings(ctx, w, h, t, p) {
    const cx = w / 2
    const cy = h / 2
    const base = Math.min(w, h) * 0.08
    const cycle = 3.6
    const ct = t % cycle
    for (let i = 0; i < 5; i++) {
      const r = base + i * Math.min(w, h) * 0.075
      ctx.lineWidth = 1.5
      ctx.strokeStyle = p.dim
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
      const tip = p.ease(Math.min(1, Math.max(0, (ct - i * 0.22) / 2.2)))
      const tail = p.ease(Math.min(1, Math.max(0, (ct - i * 0.22 - 0.35) / 2.2)))
      if (tip <= 0 || tip - tail < 0.002) continue
      ctx.strokeStyle = i === 0 ? p.accent : p.stroke
      ctx.beginPath()
      ctx.arc(cx, cy, r, -Math.PI / 2 + tail * Math.PI * 2, -Math.PI / 2 + tip * Math.PI * 2)
      ctx.stroke()
    }
    ctx.fillStyle = p.accent
    ctx.beginPath()
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2)
    ctx.fill()
  },

  // Rays firing out from a centre, like one event fanned to many endpoints.
  burst(ctx, w, h, t, p) {
    const cx = w / 2
    const cy = h / 2
    const n = 22
    const R = Math.min(w, h) * 0.42
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.2
      const phase = (t * 0.7 + i * 0.37) % 1
      const r0 = R * (0.22 + 0.55 * p.ease(phase))
      const len = R * 0.18 * (1 - phase)
      ctx.strokeStyle = i % 7 === 0 ? p.accent : phase > 0.8 ? p.dim : p.stroke
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
      ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len))
      ctx.stroke()
    }
    ctx.strokeStyle = p.dim
    ctx.beginPath()
    ctx.arc(cx, cy, R * 0.14, 0, Math.PI * 2)
    ctx.stroke()
  },

  // A field of short strokes turning in a slow wave - many recipients, one send.
  field(ctx, w, h, t, p) {
    const step = 26
    const cols = Math.floor(w / step)
    const rows = Math.floor(h / step)
    const ox = (w - (cols - 1) * step) / 2
    const oy = (h - (rows - 1) * step) / 2
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const px = ox + x * step
        const py = oy + y * step
        const a = Math.sin(x * 0.35 + t * 0.9) + Math.cos(y * 0.3 - t * 0.6)
        const lit = Math.sin(x * 0.2 + y * 0.2 - t * 1.4) > 0.92
        ctx.strokeStyle = lit ? p.accent : "rgba(255,255,255,0.4)"
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.moveTo(px - Math.cos(a) * 7, py - Math.sin(a) * 7)
        ctx.lineTo(px + Math.cos(a) * 7, py + Math.sin(a) * 7)
        ctx.stroke()
      }
    }
  },

  // A gauge whose needle breathes around a high reading.
  gauge(ctx, w, h, t, p) {
    const cx = w / 2
    const cy = h * 0.62
    const R = Math.min(w * 0.4, h * 0.48)
    const ticks = 48
    const value = 0.86 + Math.sin(t * 0.8) * 0.04
    for (let i = 0; i <= ticks; i++) {
      const f = i / ticks
      const a = Math.PI + f * Math.PI
      const long = i % 6 === 0
      ctx.strokeStyle = f <= value ? (f > 0.8 ? p.accent : p.stroke) : p.dim
      ctx.lineWidth = long ? 2 : 1.4
      const r1 = R * (long ? 0.8 : 0.86)
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R)
      ctx.stroke()
    }
    const a = Math.PI + value * Math.PI
    ctx.strokeStyle = p.accent
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(a) * R * 0.66, cy + Math.sin(a) * R * 0.66)
    ctx.stroke()
    ctx.fillStyle = p.accent
    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI * 2)
    ctx.fill()
  },

  // Isometric trays settling onto a stack: a mailbox filling.
  stack(ctx, w, h, t, p) {
    const cx = w / 2
    const cos = Math.cos(Math.PI / 6)
    const sin = Math.sin(Math.PI / 6)
    const s = Math.min(w, h) * 0.26
    const n = 6
    const cycle = 4
    const ct = t % cycle
    for (let i = 0; i < n; i++) {
      const drop = p.ease(Math.min(1, Math.max(0, (ct - i * 0.35) / 1.1)))
      const y = h * 0.72 - i * 16 - (1 - drop) * 40
      ctx.globalAlpha = drop
      ctx.strokeStyle = i === n - 1 ? p.accent : p.stroke
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(cx, y - s * sin)
      ctx.lineTo(cx + s * cos, y)
      ctx.lineTo(cx, y + s * sin)
      ctx.lineTo(cx - s * cos, y)
      ctx.closePath()
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  },

  // A branch graph: commits flowing along main, one merge lighting up.
  branch(ctx, w, h, t, p) {
    const y1 = h * 0.42
    const y2 = h * 0.62
    const x0 = w * 0.12
    const x1 = w * 0.88
    ctx.lineWidth = 1.5
    ctx.strokeStyle = p.stroke
    ctx.beginPath()
    ctx.moveTo(x0, y1)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    ctx.strokeStyle = p.dim
    ctx.beginPath()
    ctx.moveTo(w * 0.3, y1)
    ctx.bezierCurveTo(w * 0.36, y2, w * 0.4, y2, w * 0.46, y2)
    ctx.lineTo(w * 0.6, y2)
    ctx.bezierCurveTo(w * 0.66, y2, w * 0.7, y1, w * 0.74, y1)
    ctx.stroke()
    const nodes = [0.12, 0.3, 0.52, 0.74, 0.88]
    const lit = Math.floor(t * 0.8) % nodes.length
    nodes.forEach((f, i) => {
      ctx.fillStyle = i === lit ? p.accent : "#0e0e11"
      ctx.strokeStyle = i === lit ? p.accent : p.stroke
      ctx.beginPath()
      ctx.arc(w * f, y1, i === lit ? 6 : 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    })
    ctx.fillStyle = "#0e0e11"
    ctx.strokeStyle = p.dim
    ctx.beginPath()
    ctx.arc(w * 0.53, y2, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  },
}
