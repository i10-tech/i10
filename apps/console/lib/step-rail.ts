/**
 * A line of script for a server component to render right after a following
 * `StepRail` (components/steps.tsx): it scrolls the rail's current step to the
 * top as the HTML is parsed, before the first paint, unless it is the first
 * step. Not in steps.tsx, because that is a client module: a constant
 * imported from one into a server component is a client reference, not the
 * string, and a script rendered by a client component makes React complain.
 */
export const OPEN_RAIL_ON_CURRENT = `(function(){var l=document.querySelectorAll("[data-step-rail=follow]");for(var i=0;i<l.length;i++){var c=l[i].querySelector("[data-step-state=current]");if(c&&c!==l[i].querySelector("[data-step-state]"))c.scrollIntoView({block:"start"})}})()`
