/* global document, getComputedStyle, requestAnimationFrame, window */
// Runs in the page. Records every visible element's box and effective opacity once per frame.
;(() => {
  const ids = new WeakMap()
  let next = 1
  const idOf = (el) => {
    if (!ids.has(el)) ids.set(el, next++)
    return ids.get(el)
  }
  const label = (el) => {
    const text = (el.getAttribute("aria-label") || el.innerText || "").trim().replace(/\s+/g, " ")
    return `${el.tagName.toLowerCase()} "${text.slice(0, 50)}"`
  }
  const effectiveOpacity = (el) => {
    let value = 1
    for (let node = el; node && node !== document.documentElement; node = node.parentElement)
      value *= Number(getComputedStyle(node).opacity)
    return value
  }
  const sample = () => {
    const frame = new Map()
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("nextjs-portal, script, style, [data-motion-ignore]")) continue
      const box = el.getBoundingClientRect()
      if (box.width < 2 || box.height < 2) continue
      const style = getComputedStyle(el)
      if (style.visibility === "hidden" || style.display === "none") continue
      const leaf = !el.children.length || el.matches("button, a, input, textarea, svg, li, h1, h2, h3, p")
      if (!leaf) continue
      frame.set(idOf(el), { x: box.x, y: box.y, w: box.width, h: box.height, el })
    }
    return frame
  }
  window.__motion = {
    frames: [],
    shifts: [],
    running: false,
    start() {
      this.frames = []
      this.shifts = []
      this.running = true
      const t0 = performance.now()
      const tick = () => {
        if (!this.running) return
        const frame = sample()
        const compact = new Map()
        for (const [id, b] of frame)
          compact.set(id, { x: b.x, y: b.y, w: b.w, h: b.h, o: effectiveOpacity(b.el), name: label(b.el) })
        this.frames.push({ t: Math.round(performance.now() - t0), boxes: compact })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    stop(options) {
      this.running = false
      return analyse(this.frames, options)
    },
  }
  function analyse(frames, { jump, appear }) {
    const issues = []
    const push = (kind, t, name, detail, box) => issues.push({ kind, t, name, detail, box })
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1].boxes
      const now = frames[i].boxes
      const before = frames[i - 2]?.boxes
      const after = frames[i + 1]?.boxes
      const moved = new Map()
      for (const [id, b] of now) {
        const p = prev.get(id)
        if (!p) {
          // Appeared whole: full size and fully visible in its first frame, and it stays.
          if (b.h >= appear && b.o > 0.9 && frames.slice(i, i + 4).every((f) => f.boxes.has(id))) {
            const next = after?.get(id)
            const growing = next && (next.h > b.h + 0.5 || next.o > b.o + 0.01)
            if (!growing) push("pop-in", frames[i].t, b.name, `${Math.round(b.h)}px tall, opacity ${b.o.toFixed(2)}`, b)
          }
          continue
        }
        const dx = b.x - p.x
        const dy = b.y - p.y
        const size = Math.abs(dx) >= Math.abs(dy) ? dx : dy
        if (Math.abs(size) < jump) continue
        const was = before?.get(id)
        const lastStep = was ? Math.max(Math.abs(p.x - was.x), Math.abs(p.y - was.y)) : 0
        const coming = after?.get(id)
        const nextStep = coming ? Math.max(Math.abs(coming.x - b.x), Math.abs(coming.y - b.y)) : 0
        // A snap: this frame's move is far bigger than the frames on either side of it.
        if (Math.abs(size) > 2.5 * Math.max(lastStep, 1) && Math.abs(size) > 2.5 * Math.max(nextStep, 1)) {
          const key = `${dx.toFixed(0)},${dy.toFixed(0)}`
          if (!moved.has(key)) moved.set(key, { name: b.name, dx, dy, n: 0 })
          moved.get(key).n++
        }
      }
      for (const m of moved.values())
        push("snap", frames[i].t, m.name, `${m.dx.toFixed(1)},${m.dy.toFixed(1)}px in one frame, with ${m.n} elements`)
      for (const [id, p] of prev) {
        if (now.has(id) || p.h < appear || p.o <= 0.9) continue
        push("pop-out", frames[i].t, p.name, `${Math.round(p.h)}px tall, opacity ${p.o.toFixed(2)}`, p)
      }
    }
    // One finding per thing: drop anything inside a bigger box flagged the same way at once.
    const contains = (o, b) =>
      o !== b && o.x <= b.x + 1 && o.y <= b.y + 1 && o.x + o.w >= b.x + b.w - 1 && o.y + o.h >= b.y + b.h - 1
    const kept = issues
      .filter((i) => !i.box || !issues.some((o) => o.box && o.kind === i.kind && o.t === i.t && contains(o.box, i.box)))
      .map((i) => {
        const rest = { ...i }
        delete rest.box
        return rest
      })
    return { frames: frames.length, ms: frames.at(-1)?.t ?? 0, issues: kept }
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (!entry.hadRecentInput && entry.value > 0.001 && window.__motion.running)
          window.__motion.shifts.push({ t: Math.round(entry.startTime), value: entry.value })
    }).observe({ type: "layout-shift", buffered: false })
  } catch {
    // layout-shift entries are Chromium-only; elsewhere the sampler runs without them.
  }
})()
