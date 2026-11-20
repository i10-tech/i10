import { describe, expect, test } from "bun:test"
import {
  TUNING,
  crossedHysteresis,
  decide,
  dropAllowed,
  freshMemory,
  planPress,
  project,
  velocityOf,
  type Carry,
  type Destination,
  type Frame,
  type Item,
  type Memory,
  type Plan,
  type Point,
  type Rect,
  type Sample,
  type Target,
} from "@/components/list/gesture/decide"

const rect = (left: number, top: number, w = 100, h = 100): Rect => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
})

// Row one: template t1, template t2, folder f1, template t3, with 10px gaps.
// Row two: folder g, which sits inside f1. Above them, the breadcrumb: All
// templates, then "up", a folder the page is inside.
const items: Item[] = [
  { key: "t1", rect: rect(0, 0) },
  { key: "t2", rect: rect(110, 0) },
  { key: "folder:f1", rect: rect(220, 0) },
  { key: "t3", rect: rect(330, 0) },
  { key: "folder:g", rect: rect(0, 110) },
]
const targets: Target[] = [
  { key: "f1", to: "f1", rect: rect(220, 0) },
  { key: "g", to: "g", rect: rect(0, 110) },
  { key: "root", to: null, rect: rect(0, -50, 80, 30) },
  { key: "up", to: "up", rect: rect(100, -50, 80, 30) },
]
const carry = (
  keys: string[],
  homes: (string | null)[],
  blocked: string[] = [],
): Carry => ({
  keys,
  homes,
  blocked: new Set(blocked),
})
const carryOne = (key: string): Carry => carry([key], [null])

const FRAME_MS = 16

/** Pointer positions, one per frame, as viewport samples. */
function path(points: Point[], startAt = 0): Sample[] {
  return points.map((p, i) => ({ ...p, t: startAt + i * FRAME_MS }))
}

const lifting = (extra: Partial<Frame> = {}): Partial<Frame> => ({
  carry: carryOne("t1"),
  ...extra,
})

/** Plays `samples` through `decide`, one frame each; returns every destination. */
function play(
  plan: Exclude<Plan, { kind: "ignore" }>,
  samples: Sample[],
  extra: Partial<Frame> = plan.kind === "lift" ? lifting() : {},
): { all: Destination[]; last: Destination; memory: Memory } {
  const press = samples[0]!
  let memory = freshMemory(press)
  const all: Destination[] = []
  for (let i = 1; i < samples.length; i++) {
    const out = decide(
      {
        plan,
        press,
        pointer: samples[i]!,
        samples: samples.slice(0, i + 1),
        released: false,
        items,
        targets,
        carry: null,
        base: new Set(),
        ...extra,
      },
      memory,
    )
    memory = out.memory
    all.push(out.destination)
  }
  return { all, last: all[all.length - 1]!, memory }
}

function release(
  plan: Exclude<Plan, { kind: "ignore" }>,
  samples: Sample[],
  memory: Memory,
  extra: Partial<Frame> = lifting(),
): Destination {
  return decide(
    {
      plan,
      press: samples[0]!,
      pointer: samples[samples.length - 1]!,
      samples,
      released: true,
      items,
      targets,
      carry: null,
      base: new Set(),
      ...extra,
    },
    memory,
  ).destination
}

const line = (from: Point, to: Point, steps: number): Point[] =>
  Array.from({ length: steps + 1 }, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
  }))

describe("press classification: the press decides, as in Finder", () => {
  const base = { additive: false, touch: false } as const
  const card = (key: string, selected = false) =>
    ({ kind: "card", key, selected }) as const

  test("a control is left alone", () => {
    expect(planPress({ ...base, target: { kind: "control" } })).toEqual({
      kind: "ignore",
    })
  })

  test("empty space starts a box, plain or additive, and is a scroll on a finger", () => {
    expect(planPress({ ...base, target: { kind: "empty" } })).toEqual({
      kind: "box",
      additive: false,
    })
    expect(planPress({ ...base, additive: true, target: { kind: "empty" } })).toEqual({
      kind: "box",
      additive: true,
    })
    expect(planPress({ ...base, touch: true, target: { kind: "empty" } })).toEqual({
      kind: "ignore",
    })
  })

  test("a checkbox sweeps toward the state the click would have given it", () => {
    expect(
      planPress({ ...base, target: { kind: "checkbox", key: "t1", ticked: false } }),
    ).toEqual({ kind: "sweep", to: true })
    expect(
      planPress({ ...base, target: { kind: "checkbox", key: "t1", ticked: true } }),
    ).toEqual({ kind: "sweep", to: false })
  })

  test("a modifier on a card is a box from right there", () => {
    expect(planPress({ ...base, additive: true, target: card("t1") })).toEqual({
      kind: "box",
      additive: true,
    })
    expect(planPress({ ...base, additive: true, target: card("folder:f1") })).toEqual({
      kind: "box",
      additive: true,
    })
  })

  test("a template lifts, alone when it is not ticked and with the selection when it is", () => {
    expect(planPress({ ...base, target: card("t1") })).toEqual({
      kind: "lift",
      origin: "t1",
      carry: "origin",
    })
    expect(planPress({ ...base, target: card("t1", true) })).toEqual({
      kind: "lift",
      origin: "t1",
      carry: "selection",
    })
  })

  test("a folder lifts just the same, on a mouse and on a finger", () => {
    for (const touch of [false, true]) {
      expect(planPress({ ...base, touch, target: card("folder:f1") })).toEqual({
        kind: "lift",
        origin: "folder:f1",
        carry: "origin",
      })
      expect(planPress({ ...base, touch, target: card("folder:f1", true) })).toEqual({
        kind: "lift",
        origin: "folder:f1",
        carry: "selection",
      })
    }
  })
})

describe("hysteresis", () => {
  test("a press has to travel before it is a gesture", () => {
    const down = { x: 50, y: 50 }
    expect(crossedHysteresis(down, { x: 50 + TUNING.HYSTERESIS - 1, y: 50 })).toBe(
      false,
    )
    expect(crossedHysteresis(down, { x: 50 + TUNING.HYSTERESIS, y: 50 })).toBe(true)
  })
})

describe("lift", () => {
  const lift = { kind: "lift", origin: "t1", carry: "origin" } as const

  test("over a folder it moves there; released elsewhere it cancels", () => {
    const onto = play(lift, path([...line({ x: 50, y: 50 }, { x: 270, y: 50 }, 14)]))
    expect(onto.last).toMatchObject({ kind: "move", to: "f1", reason: "MoveByDrop" })

    const away = play(lift, path([...line({ x: 50, y: 50 }, { x: 160, y: 250 }, 14)]))
    expect(away.last).toEqual({ kind: "none", reason: "NotOverTarget" })
  })

  test("a folder lifts onto another folder, and the move names the folder", () => {
    const folder = { kind: "lift", origin: "folder:g", carry: "origin" } as const
    const run = play(folder, path(line({ x: 50, y: 160 }, { x: 270, y: 50 }, 14)), {
      carry: carry(["folder:g"], ["f1"], ["g"]),
    })
    // g is already inside f1, so f1 refuses it; the top level takes it.
    expect(run.last).toEqual({ kind: "none", reason: "NotOverTarget" })
    const up = play(folder, path(line({ x: 50, y: 160 }, { x: 30, y: -35 }, 14)), {
      carry: carry(["folder:g"], ["f1"], ["g"]),
    })
    expect(up.last).toMatchObject({ kind: "move", keys: ["folder:g"], to: null })

    const f1 = { kind: "lift", origin: "folder:f1", carry: "origin" } as const
    const into = play(f1, path(line({ x: 270, y: 50 }, { x: 50, y: 160 }, 14)), {
      carry: carry(["folder:f1"], [null], ["f1", "g"]),
    })
    // f1 holds g, so g is no place to put f1: that would be a cycle.
    expect(into.last).toEqual({ kind: "none", reason: "NotOverTarget" })
  })

  test("a selection of folders and templates lifts together", () => {
    const load = carry(["t1", "folder:g", "t3"], [null, "f1", null], ["g"])
    const selection = { kind: "lift", origin: "t1", carry: "selection" } as const
    const run = play(selection, path(line({ x: 50, y: 50 }, { x: 270, y: 50 }, 14)), {
      carry: load,
    })
    expect(run.last).toMatchObject({
      kind: "move",
      keys: ["t1", "folder:g", "t3"],
      to: "f1",
    })
  })

  test("it is refused on a carried folder and on any folder inside one", () => {
    const folder = { kind: "lift", origin: "folder:f1", carry: "origin" } as const
    const load = carry(["folder:f1"], [null], ["f1", "g"])
    const onItself = play(folder, path(line({ x: 230, y: 20 }, { x: 270, y: 50 }, 8)), {
      carry: load,
    })
    expect(onItself.all.every((d) => d.kind === "none")).toBe(true)
    const onChild = play(folder, path(line({ x: 270, y: 50 }, { x: 50, y: 160 }, 14)), {
      carry: load,
    })
    expect(onChild.all.every((d) => d.kind === "none")).toBe(true)
    expect(dropAllowed(load, targets[0]!)).toBe(false)
    expect(dropAllowed(load, targets[1]!)).toBe(false)
    // A folder beside them is fine, and so is the top level once it is inside another.
    expect(dropAllowed(load, { key: "z", to: "z", rect: rect(0, 0) })).toBe(true)
    expect(dropAllowed(carry(["folder:f1"], ["up"], ["f1", "g"]), targets[2]!)).toBe(
      true,
    )
  })

  test("every crumb above is a target, and the place everything already is is not", () => {
    // Two levels deep: in `deep`, inside `up`. The crumbs are All templates
    // and `up`; `deep` has no crumb to drop on.
    const load = carry(["t1"], ["deep"])
    expect(dropAllowed(load, targets[2]!)).toBe(true)
    expect(dropAllowed(load, targets[3]!)).toBe(true)
    expect(dropAllowed(load, { key: "deep", to: "deep", rect: rect(0, 0) })).toBe(false)
    const toRoot = play(
      { kind: "lift", origin: "t1", carry: "origin" },
      path(line({ x: 50, y: 50 }, { x: 40, y: -35 }, 10)),
      { carry: load },
    )
    expect(toRoot.last).toMatchObject({ kind: "move", to: null, target: "root" })
    const toUp = play(
      { kind: "lift", origin: "t1", carry: "origin" },
      path(line({ x: 50, y: 50 }, { x: 140, y: -35 }, 10)),
      { carry: load },
    )
    expect(toUp.last).toMatchObject({ kind: "move", to: "up", target: "up" })
  })

  test("a load is never dropped where all of it already is", () => {
    const inF1 = carry(["t1"], ["f1"])
    expect(dropAllowed(inF1, targets[0]!)).toBe(false)
    expect(dropAllowed(carry(["t1", "t2"], ["f1", null]), targets[0]!)).toBe(true)
  })

  test("a fast release whose flight lands on a folder moves there", () => {
    // Leaving t1 at about 440px/s: it coasts about 220px on.
    const samples = path(line({ x: 62, y: 50 }, { x: 90, y: 50 }, 4))
    const v = velocityOf(samples)
    expect(v.x).toBeGreaterThan(TUNING.FLICK_MIN_VELOCITY)
    expect(90 + project(v.x)).toBeGreaterThan(220)
    const { memory } = play(lift, samples)
    expect(release(lift, samples, memory)).toMatchObject({
      kind: "move",
      to: "f1",
      reason: "MoveByFlick",
    })
  })

  test("a flick onto a folder that cannot take the load cancels", () => {
    const folder = { kind: "lift", origin: "folder:f1", carry: "origin" } as const
    const samples = path(line({ x: 62, y: 50 }, { x: 90, y: 50 }, 4))
    const extra = { carry: carry(["folder:f1"], [null], ["f1", "g"]) }
    const { memory } = play(folder, samples, extra)
    expect(release(folder, samples, memory, extra)).toMatchObject({ kind: "none" })
  })

  test("a slow release does not coast anywhere", () => {
    const samples = path(line({ x: 90, y: 50 }, { x: 105, y: 50 }, 8))
    const { memory } = play(lift, samples)
    expect(release(lift, samples, memory)).toMatchObject({ kind: "none" })
  })

  test("it lets go only after the pointer is well outside the folder", () => {
    const onto = line({ x: 50, y: 50 }, { x: 270, y: 50 }, 8)
    // 8px past the edge is inside the 12px margin.
    const near = play(
      lift,
      path([...onto, ...line({ x: 270, y: 50 }, { x: 328, y: 50 }, 6)]),
    )
    expect(near.last.kind).toBe("move")
    const far = play(
      lift,
      path([...onto, ...line({ x: 270, y: 50 }, { x: 345, y: 50 }, 6)]),
    )
    expect(far.last.kind).not.toBe("move")
  })
})

describe("checkbox sweep", () => {
  const across = path(line({ x: 50, y: 50 }, { x: 160, y: 50 }, 10))

  test("ticks everything the pointer passes over, the first checkbox included", () => {
    const run = play({ kind: "sweep", to: true }, across, { base: new Set(["t3"]) })
    expect(run.last).toMatchObject({ kind: "select", reason: "SweepTick" })
    if (run.last.kind === "select") {
      expect([...run.last.keys].sort()).toEqual(["t1", "t2", "t3"])
    }
  })

  test("unticks the same way when the first checkbox was ticked", () => {
    const run = play({ kind: "sweep", to: false }, across, {
      base: new Set(["t1", "t2", "t3"]),
    })
    expect(run.last).toMatchObject({ kind: "select", reason: "SweepUntick" })
    if (run.last.kind === "select") {
      expect([...run.last.keys]).toEqual(["t3"])
    }
  })

  test("a fast pointer cannot skip a card between two frames", () => {
    const jump = path([
      { x: 50, y: 50 },
      { x: 400, y: 50 },
    ])
    const run = play({ kind: "sweep", to: true }, jump)
    if (run.last.kind === "select") {
      expect([...run.last.keys].sort()).toEqual(["folder:f1", "t1", "t2", "t3"])
    }
  })
})

describe("box", () => {
  test("a modifier box keeps the rest and toggles what it covers", () => {
    const run = play(
      { kind: "box", additive: true },
      path(line({ x: 50, y: 50 }, { x: 160, y: 60 }, 6)),
      { base: new Set(["t1", "t3"]) },
    )
    expect(run.last.kind === "select" && [...run.last.keys].sort()).toEqual([
      "t2",
      "t3",
    ])
  })

  test("a plain box starts afresh and selects what it covers, selected before or not", () => {
    const run = play(
      { kind: "box", additive: false },
      path(line({ x: 50, y: 50 }, { x: 160, y: 60 }, 6)),
      { base: new Set(["t1", "t3"]) },
    )
    expect(run.last.kind === "select" && [...run.last.keys].sort()).toEqual([
      "t1",
      "t2",
    ])
  })

  test("a plain box over nothing selected selects what it covers", () => {
    const run = play(
      { kind: "box", additive: false },
      path(line({ x: 50, y: 50 }, { x: 160, y: 60 }, 6)),
    )
    expect(run.last.kind === "select" && [...run.last.keys].sort()).toEqual([
      "t1",
      "t2",
    ])
  })
})
