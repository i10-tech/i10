"use client"

import * as React from "react"
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react"
import { ArrowUp, RotateCcw, RotateCw } from "lucide-react"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { Slider } from "@repo/ui/components/slider/slider"
import { motionTokens } from "@repo/ui/components/motion-tokens"

const ACCEPT = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const MAX_BYTES = 10 * 1024 * 1024
/** The crop square on screen, and the photo Clerk receives. */
const VIEW = 280
const OUTPUT = 512

const enter = [...motionTokens.ease.enter] as [number, number, number, number]
const soft = `blur(${motionTokens.blur.soft}px)`
/** Arc's file-dropzone refusal: a short decaying shake that reads as "no". */
const SHAKE = { x: [0, -7, 6, -4, 3, -1.5, 0] }

/**
 * A profile photo or workspace logo you can drop a file on (2026-10-12) -
 * Arc's file dropzone, folded into the avatar row Clerk's panels had: the
 * whole area takes a dragged image, the edge draws in and the avatar lifts
 * while one hovers, and "Upload" still opens the picker. Either way the image
 * opens in the editor first - crop, zoom, rotate - and what is uploaded is
 * the square it shows.
 *
 * ⚠ A WRONG FILE IS REFUSED HERE, NOT BY CLERK. The area shakes and says why
 * under the buttons; nothing is sent.
 */
export function PhotoField({
  name,
  src,
  shape = "circle",
  editable = true,
  locked,
  onUpload,
  onRemove,
  className,
  children,
}: {
  name: string
  src?: string
  /** A person is a circle; a workspace logo a rounded square. */
  shape?: "circle" | "square"
  editable?: boolean
  /** Said instead of the buttons when `editable` is false. */
  locked?: React.ReactNode
  onUpload: (file: File) => Promise<void>
  onRemove?: () => Promise<void>
  /**
   * The drop zone's own box. With `children` it is the whole card - the
   * profile form takes a dropped image anywhere on it, not only by the photo.
   */
  className?: string
  children?: React.ReactNode
}) {
  const reduce = useReducedMotion() ?? false
  const zone = React.useRef<HTMLDivElement>(null)
  const input = React.useRef<HTMLInputElement>(null)
  const depth = React.useRef(0)
  const [dragging, setDragging] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<{ url: string; type: string } | null>(
    null,
  )
  const [busy, setBusy] = React.useState<"upload" | "remove" | null>(null)

  function refuse(message: string) {
    setError(message)
    if (!reduce && zone.current)
      animate(zone.current, SHAKE, { duration: 0.42, ease: "easeOut" })
  }

  function take(file: File | undefined) {
    if (!file) return
    if (!ACCEPT.includes(file.type))
      return refuse("Use a PNG, JPEG, GIF or WebP image.")
    if (file.size > MAX_BYTES) return refuse("That image is over 10MB.")
    setError(null)
    setEditing({ url: URL.createObjectURL(file), type: file.type })
  }

  function closeEditor() {
    if (editing) URL.revokeObjectURL(editing.url)
    setEditing(null)
    if (input.current) input.current.value = ""
  }

  async function save(file: File) {
    setBusy("upload")
    try {
      await onUpload(file)
      closeEditor()
    } catch {
      // The caller said why; the editor stays open to try again.
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!onRemove) return
    setBusy("remove")
    try {
      await onRemove()
    } finally {
      setBusy(null)
    }
  }

  const drop = editable
    ? {
        onDragEnter: (event: React.DragEvent) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          depth.current += 1
          setDragging(true)
        },
        onDragOver: (event: React.DragEvent) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setDragging(false)
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault()
          depth.current = 0
          setDragging(false)
          take(event.dataTransfer.files[0])
        },
      }
    : {}

  const rounded = shape === "circle" ? "rounded-full" : "rounded-xl"
  return (
    <>
      <div
        ref={zone}
        {...drop}
        data-dragging={dragging || undefined}
        className={`relative rounded-2xl transition-colors duration-(--duration-fast) data-dragging:bg-accent/5 ${className ?? "-m-2 p-2"}`}
      >
        {/* The dashed edge draws in while a file hovers, as Arc's dropzone's does. */}
        <AnimatePresence>
          {dragging && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-2xl border border-dashed border-accent/60"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}
            />
          )}
        </AnimatePresence>
        <div className="flex flex-wrap items-center gap-4">
          <motion.span
            className="relative grid place-items-center"
            animate={dragging && !reduce ? { y: -3, scale: 1.04 } : { y: 0, scale: 1 }}
            transition={motionTokens.spring.snappy}
          >
            <Avatar name={name} src={src} size="xl" className={rounded} />
            <AnimatePresence>
              {dragging && (
                <motion.span
                  aria-hidden
                  className={`absolute inset-0 grid place-items-center bg-background/70 text-foreground ${rounded}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: motionTokens.duration.fast }}
                >
                  <motion.span
                    initial={reduce ? false : { y: 6, opacity: 0, filter: soft }}
                    animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                    transition={{
                      duration: motionTokens.duration.standard,
                      ease: enter,
                    }}
                  >
                    <ArrowUp className="size-5" />
                  </motion.span>
                </motion.span>
              )}
            </AnimatePresence>
          </motion.span>
          {editable ? (
            <div className="flex flex-col gap-1">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => input.current?.click()}
                >
                  Upload
                </Button>
                {src && onRemove && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    loading={busy === "remove"}
                    disabled={busy !== null}
                    onClick={() => void remove()}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <p
                className={`text-xs ${error ? "text-danger" : "text-muted-foreground"}`}
                aria-live="polite"
              >
                {error ??
                  (dragging
                    ? "Drop it to edit and upload."
                    : "Drop an image here. Square, up to 10MB.")}
              </p>
              <input
                ref={input}
                type="file"
                accept={ACCEPT.join(",")}
                className="hidden"
                onChange={(event) => take(event.target.files?.[0])}
              />
            </div>
          ) : (
            locked
          )}
        </div>
        {children}
      </div>

      <PhotoEditor
        image={editing}
        shape={shape}
        saving={busy === "upload"}
        onCancel={closeEditor}
        onSave={(file) => void save(file)}
      />
    </>
  )
}

/**
 * The photo editor: drag to move, zoom, straighten, and turn by quarters.
 * The crop is the circle (or rounded square) in the middle; the rest dims.
 *
 * ⚠ THE PREVIEW AND THE UPLOAD ARE THE SAME TRANSFORM. The image is drawn on
 * screen and onto the canvas with one translate, rotate and scale about its
 * centre, so what leaves is exactly what was shown - scaled from the 280px
 * square to 512px.
 *
 * ⚠ IT NEVER SHOWS AN EMPTY CORNER. The zoom floor covers the crop at any
 * angle, and a drag is held inside what the image can cover.
 */
function PhotoEditor({
  image,
  shape,
  saving,
  onCancel,
  onSave,
}: {
  image: { url: string; type: string } | null
  shape: "circle" | "square"
  saving: boolean
  onCancel: () => void
  onSave: (file: File) => void
}) {
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = React.useState(1)
  const [tilt, setTilt] = React.useState(0)
  const [turns, setTurns] = React.useState(0)
  const [pan, setPan] = React.useState({ x: 0, y: 0 })
  const [grabbing, setGrabbing] = React.useState(false)
  const img = React.useRef<HTMLImageElement>(null)
  const view = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<{
    id: number
    x: number
    y: number
    from: { x: number; y: number }
  } | null>(null)

  // A new image starts centred and unrotated.
  const [seen, setSeen] = React.useState(image?.url)
  if (image?.url !== seen) {
    setSeen(image?.url)
    setNatural(null)
    setZoom(1)
    setTilt(0)
    setTurns(0)
    setPan({ x: 0, y: 0 })
  }

  const angle = turns * 90 + tilt
  const rad = (angle * Math.PI) / 180
  /*
   * The square, seen from the image's own axes, spans VIEW x (|cos| + |sin|)
   * of the angle on each - the same at every quarter turn, wider when tilted.
   * The zoom floor makes the image's shorter side at least that.
   */
  const t = (Math.abs(tilt) * Math.PI) / 180
  const reach = VIEW * (Math.cos(t) + Math.sin(t))
  const base = natural ? reach / Math.min(natural.w, natural.h) : 1
  const scale = base * zoom

  /** Keeps the crop inside the image, measured along the image's own axes. */
  const clamp = React.useCallback(
    (next: { x: number; y: number }) => {
      const cos = Math.cos(-rad)
      const sin = Math.sin(-rad)
      // The pan, in the image's frame.
      const u = next.x * cos - next.y * sin
      const v = next.x * sin + next.y * cos
      const iw = (natural?.w ?? 1) * scale
      const ih = (natural?.h ?? 1) * scale
      const mu = Math.max(0, (iw - reach) / 2)
      const mv = Math.max(0, (ih - reach) / 2)
      const cu = Math.min(mu, Math.max(-mu, u))
      const cv = Math.min(mv, Math.max(-mv, v))
      return {
        x: cu * Math.cos(rad) - cv * Math.sin(rad),
        y: cu * Math.sin(rad) + cv * Math.cos(rad),
      }
    },
    [rad, natural, scale, reach],
  )

  // A zoom out or a turn can leave the old pan outside the image.
  const held = clamp(pan)

  React.useEffect(() => {
    const node = view.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      setZoom((z) => Math.min(4, Math.max(1, z * Math.exp(-event.deltaY * 0.002))))
    }
    node.addEventListener("wheel", wheel, { passive: false })
    return () => node.removeEventListener("wheel", wheel)
  }, [image])

  async function save() {
    const source = img.current
    if (!source || !natural) return
    const canvas = document.createElement("canvas")
    canvas.width = OUTPUT
    canvas.height = OUTPUT
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const k = OUTPUT / VIEW
    ctx.imageSmoothingQuality = "high"
    ctx.translate(OUTPUT / 2 + held.x * k, OUTPUT / 2 + held.y * k)
    ctx.rotate(rad)
    ctx.scale(scale * k, scale * k)
    ctx.drawImage(source, -natural.w / 2, -natural.h / 2)
    // A logo keeps its transparency; a photo goes as a JPEG.
    const type = image?.type === "image/jpeg" ? "image/jpeg" : "image/png"
    const blob = await new Promise<Blob | null>((done) =>
      canvas.toBlob(done, type, 0.92),
    )
    if (!blob) return
    onSave(
      new File([blob], type === "image/jpeg" ? "photo.jpg" : "photo.png", { type }),
    )
  }

  const mask = shape === "circle" ? "rounded-full" : "rounded-[22%]"
  return (
    <Dialog
      open={image !== null}
      onOpenChange={(open) => !open && !saving && onCancel()}
    >
      <DialogContent
        title="Edit photo"
        description="Drag to move it. Zoom and turn it until it sits right."
        className="max-w-sm"
      >
        <div className="flex flex-col gap-5">
          <div
            ref={view}
            tabIndex={0}
            role="group"
            aria-label="Photo crop. Use the arrow keys to move it."
            /*
             * ⚠ CLIPPED BY `clip-path`, NOT ONLY BY `overflow` + radius. While
             * the image's transform animates, the browser lifts it onto its
             * own layer, and `overflow: hidden` with a border radius stops
             * rounding that layer - the corners flashed square mid-turn. A
             * clip path clips composited layers too; `isolate` keeps the
             * dimmed mask inside the same clip, and the focus ring is drawn
             * inside the edge because the clip would cut one drawn outside.
             */
            className="relative isolate mx-auto touch-none overflow-hidden rounded-2xl bg-muted outline-none select-none [clip-path:inset(0_round_1rem)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{
              width: VIEW,
              height: VIEW,
              cursor: grabbing ? "grabbing" : "grab",
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              setGrabbing(true)
              drag.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                from: held,
              }
            }}
            onPointerMove={(event) => {
              const d = drag.current
              if (!d || d.id !== event.pointerId) return
              setPan(
                clamp({
                  x: d.from.x + event.clientX - d.x,
                  y: d.from.y + event.clientY - d.y,
                }),
              )
            }}
            onPointerUp={() => {
              drag.current = null
              setGrabbing(false)
            }}
            onPointerCancel={() => {
              drag.current = null
              setGrabbing(false)
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 20 : 4
              const by: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              }
              const move = by[event.key]
              if (!move) return
              event.preventDefault()
              setPan(clamp({ x: held.x + move[0], y: held.y + move[1] }))
            }}
          >
            {image && (
              // eslint-disable-next-line @next/next/no-img-element -- a local object URL, drawn and transformed by hand
              <img
                ref={img}
                src={image.url}
                alt=""
                draggable={false}
                onLoad={(event) =>
                  setNatural({
                    w: event.currentTarget.naturalWidth,
                    h: event.currentTarget.naturalHeight,
                  })
                }
                className="pointer-events-none absolute max-w-none origin-center"
                style={{
                  width: natural?.w,
                  height: natural?.h,
                  left: VIEW / 2 - (natural?.w ?? 0) / 2,
                  top: VIEW / 2 - (natural?.h ?? 0) / 2,
                  opacity: natural ? 1 : 0,
                  transform: `translate(${held.x}px, ${held.y}px) rotate(${angle}deg) scale(${scale})`,
                  transition: grabbing
                    ? "none"
                    : "transform 160ms var(--ease-out, ease-out)",
                }}
              />
            )}
            {/* The crop: everything outside it dims. */}
            <span
              aria-hidden
              className={`pointer-events-none absolute inset-3 ${mask} shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] ring-1 ring-white/50`}
            />
          </div>

          <Slider
            label="Zoom"
            value={zoom}
            onValueChange={setZoom}
            min={1}
            max={4}
            step={0.01}
            format={(value) => `${Math.round(value * 100)}%`}
          />
          <Slider
            label="Straighten"
            value={tilt}
            onValueChange={setTilt}
            min={-45}
            max={45}
            step={0.5}
            marks={[0]}
            format={(value) => `${value > 0 ? "+" : ""}${value}°`}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Turn left"
                onClick={() => setTurns((n) => (n + 3) % 4)}
              >
                <RotateCcw aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Turn right"
                onClick={() => setTurns((n) => (n + 1) % 4)}
              >
                <RotateCw aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setZoom(1)
                  setTilt(0)
                  setTurns(0)
                  setPan({ x: 0, y: 0 })
                }}
              >
                Reset
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                loading={saving}
                disabled={!natural}
                onClick={() => void save()}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
