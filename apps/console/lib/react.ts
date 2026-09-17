"use client"

import * as React from "react"

/**
 * Two small hooks that exist to keep state synchronisation out of effects.
 *
 * ⚠ AN EFFECT IS THE WRONG TOOL FOR "THIS STATE FOLLOWS THAT PROP", AND THE
 * LINT RULE THAT FLAGS IT IS RIGHT. `useEffect(() => setX(prop), [prop])`
 * renders once with the stale value, commits it to the DOM, then re-renders
 * with the right one — so the wrong value is briefly painted, and on a
 * controlled input it can clobber a keystroke that arrived in between. React's
 * documented answer is to adjust the state DURING render: React discards the
 * in-progress output and re-runs the component before touching the DOM, so
 * nothing stale is ever committed.
 *
 * This is one of the very few places a `setState` call during render is correct.
 * It is legal only when it is guarded by a comparison that makes it run at most
 * once per change — an unguarded one is an infinite render loop.
 */

/**
 * Local state that follows an external value, while staying editable between
 * changes.
 *
 * The case it exists for: a search box whose value lives in the URL. It has to
 * be typeable (so it needs local state), it has to be debounced before it
 * reaches the URL (so it cannot be purely derived), and it has to follow the URL
 * when that changes from somewhere else — pressing back, or a "clear filters"
 * button elsewhere on the page.
 */
export function useSyncedState<T>(
  external: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [local, setLocal] = React.useState(external)
  const [seen, setSeen] = React.useState(external)

  if (external !== seen) {
    setSeen(external)
    setLocal(external)
  }

  return [local, setLocal]
}

/**
 * Runs `reset` during render, once, each time `token` changes.
 *
 * The case it exists for: clearing a form when a dialog opens. The alternative —
 * clearing on CLOSE — empties the fields while the dialog is still animating
 * out, which reads as the input being wiped from under you.
 *
 * ⚠ `reset` MUST ONLY CALL `setState` FROM THIS COMPONENT. It runs during
 * render, so anything else in it — a fetch, a toast, a router push — is a side
 * effect in a render phase that React is allowed to run twice, throw away, or
 * replay. If it needs to do more than set local state, it belongs in an event
 * handler.
 */
export function useResetWhen(token: unknown, reset: () => void): void {
  const [seen, setSeen] = React.useState(token)

  if (token !== seen) {
    setSeen(token)
    reset()
  }
}

/**
 * Runs `reset` when a dialog OPENS, and not when it closes.
 *
 * ⚠ THIS EXISTS BECAUSE `useResetWhen(open, …)` FIRES ON BOTH EDGES, WHICH IS
 * THE EXACT BUG ITS OWN DOC COMMENT WARNS ABOUT. `open` going true → false is a
 * change like any other, so the fields were being cleared on the way out — while
 * the dialog is still animating, in front of the person who is watching it. It
 * is most visible on a failed submit: the error message they were reading
 * disappears a frame before the panel does.
 *
 * ⚠ AND IT IS A SEPARATE HOOK RATHER THAN A CHANGE TO `useResetWhen`, because
 * that one is also used with a value token — a search string, a segment id —
 * where firing on EVERY change is the correct and only useful behaviour.
 *
 * Same render-phase rule as `useResetWhen`: `reset` may only set this
 * component's state.
 */
export function useResetOnOpen(open: boolean, reset: () => void): void {
  const [seen, setSeen] = React.useState(open)

  if (open !== seen) {
    setSeen(open)
    if (open) reset()
  }
}

/**
 * Whether we are past hydration.
 *
 * ⚠ `useSyncExternalStore` WITH A `false` SERVER SNAPSHOT, NOT
 * `useEffect(() => setMounted(true))`. They produce the same answer; this one
 * is not a state update at all, so it cannot cascade a render and does not
 * trip the effect rules. React calls the server snapshot during SSR and the
 * client snapshot afterwards, which is precisely the question being asked.
 *
 * ⚠ THE SUBSCRIBE FUNCTION IS A NO-OP THAT RETURNS A NO-OP, AND IT IS DECLARED
 * AT MODULE SCOPE ON PURPOSE. An inline arrow would be a new reference on every
 * render, and `useSyncExternalStore` re-subscribes whenever it changes.
 */
const noopSubscribe = () => () => {}

export function useMounted(): boolean {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
}
