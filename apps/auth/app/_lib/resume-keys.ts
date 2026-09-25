/**
 * The storage names `resume.tsx` writes, in a module with no `"use client"`.
 *
 * ⚠ SEPARATE SO THE SERVER CAN READ THEM. A constant exported from a client
 * module reaches a server component as a client reference, not as its value —
 * so the inline script below could not be built from `resume.tsx` itself.
 */

export const PREFIX = "i10:auth:"

/*
 * ⚠ ONE CLOCK FOR THE WHOLE FLOW, NOT ONE PER FIELD. A per-key timestamp let
 * the half written first expire first: a sign-up that took forty minutes came
 * back with its step but without the fact that it was a sign-up at all.
 */
export const TOUCHED = PREFIX + "touched"

/*
 * ⚠ RUNS AS THE HTML IS PARSED, BEFORE ANY OF THE FORM IS PAINTED. Without it a
 * reload on the password step shows the email step for as long as the
 * JavaScript takes to arrive, then snaps to the password step — which reads as
 * the page forgetting and then remembering. With it, a tab that has a step
 * stored shows nothing for that moment instead, and the right step once live.
 * A tab with nothing stored is not affected at all.
 */
export const HIDE_WHILE_RESUMING = `try{for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i)||"";if(k.indexOf(${JSON.stringify(PREFIX)})===0&&k!==${JSON.stringify(TOUCHED)}){document.documentElement.setAttribute("data-auth-resuming","");break}}}catch(e){}`
