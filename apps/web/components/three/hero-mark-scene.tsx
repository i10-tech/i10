"use client"

/* eslint-disable react/no-unknown-property -- R3F JSX: `geometry`, `intensity`, `position` and the rest are three.js props, not DOM attributes */

import { Environment, Lightformer } from "@react-three/drei"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js"
import { MARK_PATH } from "@/components/brand/mark"
import { prefersReducedMotion } from "@/lib/gsap"

/*
 * The hero object: the i10 mark, extruded from the exact path the logo uses.
 *
 * Post yellow, faces and sides alike. Lighting is built from
 * Lightformers - no HDR file is fetched, so the scene has no network
 * dependency and looks the same offline.
 *
 * Interaction: the mark leans toward the pointer, and dragging spins it with
 * inertia that decays back into a slow idle drift.
 */
function useMarkGeometry() {
  return useMemo(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-17.7 0 155.4 100"><path transform="skewX(-10)" fill-rule="evenodd" d="${MARK_PATH}"/></svg>`
    const data = new SVGLoader().parse(svg)
    const shapes = data.paths.flatMap((p) => SVGLoader.createShapes(p))
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: 26,
      bevelEnabled: true,
      bevelThickness: 3,
      bevelSize: 2.2,
      bevelSegments: 12,
      curveSegments: 96,
    })
    geometry.center()
    // SVG's y axis points down. Turn it over with a ROTATION, not scale(1, -1):
    // a negative scale mirrors the winding, and every face then lights from
    // the inside.
    geometry.rotateX(Math.PI)
    geometry.scale(0.024, 0.024, 0.024)
    // ⚠ NO computeVertexNormals(). ExtrudeGeometry is not indexed, so
    // recomputing gives every triangle its own flat normal: the curved walls
    // of the 0 and the bevels turned into visible stripes. The normals it
    // builds itself are smooth along the walls and sharp at the corners.
    return geometry
  }, [])
}

function MarkMesh({ drag }: { drag: React.RefObject<{ vx: number; vy: number; dragging: boolean }> }) {
  const group = useRef<THREE.Group>(null)
  const geometry = useMarkGeometry()
  // Fit the mark to the canvas: 3.8 units wide at scale 1, kept inside 96% of
  // the visible width and 82% of the height, whichever binds first.
  const viewport = useThree((state) => state.viewport)
  const fit = Math.min(1.4, (viewport.width * 0.96) / 3.8, (viewport.height * 0.82) / 2.5)
  const spin = useRef({ y: -0.35, x: 0.12 })
  // Under reduced motion the mark holds still until it is dragged: no idle
  // drift, no bob. Dragging is the reader's own motion, so it stays.
  const [still] = useState(prefersReducedMotion)
  // The mark's own velocity. `drag` is the pointer's input and is only ever
  // read here: while dragging the mark takes the pointer's speed, once let go
  // it keeps that speed and decays it locally, which is the inertia.
  const vel = useRef({ x: still ? 0 : 0.12, y: 0 })

  // Post yellow on every surface, not just the extruded sides: the faces
  // are the same lacquer as the rims, a shade lighter and glossier, so the
  // glyph reads as one solid yellow object that still shows its depth.
  const materials = useMemo(
    () => [
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color("#f7d63f"),
        metalness: 0.25,
        roughness: 0.28,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
        emissive: new THREE.Color("#3a2c00"),
      }),
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color("#f2cf3c"),
        metalness: 0.35,
        roughness: 0.3,
        clearcoat: 0.6,
        emissive: new THREE.Color("#3a2c00"),
      }),
    ],
    [],
  )

  useFrame((state, delta) => {
    const g = group.current
    if (!g) return
    const input = drag.current
    const v = vel.current
    const s = spin.current
    if (input.dragging) {
      v.x = input.vx
      v.y = input.vy
    } else {
      // Inertia decays toward a slow idle drift.
      v.x = THREE.MathUtils.damp(v.x, still ? 0 : 0.12, 1.6, delta)
      v.y = THREE.MathUtils.damp(v.y, 0, 2.2, delta)
    }
    s.y += v.x * delta
    s.x = THREE.MathUtils.clamp(s.x + v.y * delta, -0.5, 0.5)
    s.x = THREE.MathUtils.damp(s.x, 0.12, 0.8, delta)

    const px = state.pointer.x
    const py = state.pointer.y
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, s.y + px * 0.25, 6, delta)
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, s.x - py * 0.18, 6, delta)
    g.position.y = still ? 0 : Math.sin(state.clock.elapsedTime * 0.8) * 0.06
  })

  return (
    <group ref={group} scale={fit}>
      <mesh geometry={geometry} material={materials} castShadow />
    </group>
  )
}

export default function HeroMarkScene() {
  const wrap = useRef<HTMLDivElement>(null)
  const drag = useRef({ vx: 0.12, vy: 0, dragging: false })
  const last = useRef<{ x: number; y: number; t: number } | null>(null)
  const [visible, setVisible] = useState(true)

  // Render only while on screen: an idle WebGL loop is a battery tax.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: "80px" })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={wrap}
      className="relative size-full cursor-grab touch-pan-y active:cursor-grabbing"
      onPointerDown={(e) => {
        drag.current.dragging = true
        last.current = { x: e.clientX, y: e.clientY, t: performance.now() }
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        const l = last.current
        if (!drag.current.dragging || !l) return
        const now = performance.now()
        const dt = Math.max(8, now - l.t) / 1000
        drag.current.vx = THREE.MathUtils.clamp(((e.clientX - l.x) / dt) * 0.006, -14, 14)
        drag.current.vy = THREE.MathUtils.clamp(((e.clientY - l.y) / dt) * 0.004, -6, 6)
        last.current = { x: e.clientX, y: e.clientY, t: now }
      }}
      onPointerUp={() => {
        drag.current.dragging = false
        last.current = null
      }}
      onPointerCancel={() => {
        drag.current.dragging = false
        last.current = null
      }}
    >
      <Canvas
        frameloop={visible ? "always" : "never"}
        dpr={[1, 2]}
        camera={{ position: [0, 0, 9], fov: 30 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      >
        <ambientLight intensity={0.15} />
        <directionalLight position={[4, 6, 5]} intensity={1.2} />
        <pointLight position={[-4, -2, 3]} intensity={18} color="#f2cf3c" distance={12} />
        <MarkMesh drag={drag} />
        <Environment resolution={256}>
          <Lightformer form="rect" intensity={3} position={[0, 4, -6]} scale={[12, 2, 1]} />
          <Lightformer form="rect" intensity={1.6} position={[-6, 0, 2]} rotation-y={Math.PI / 2} scale={[8, 3, 1]} />
          <Lightformer form="rect" intensity={2.2} color="#f2cf3c" position={[6, -1, 1]} rotation-y={-Math.PI / 2} scale={[6, 2, 1]} />
          <Lightformer form="ring" intensity={1.4} position={[0, 0, 8]} scale={4} />
        </Environment>
      </Canvas>
    </div>
  )
}
