"use client";
import type { MouseEvent } from "react";
import { ChevronRight as NavArrowRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bone } from "../bone/bone";
import { ArcLink } from "../lib/arc-provider";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./breadcrumb.module.css";
export interface BreadcrumbItem {
  label: string;
  href?: string;
  /** Runs when the crumb is chosen. Without an href the crumb renders as a button, for paths that live in local state. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /**
   * i10: THE CRUMB NAMES DATA (a record's title). Set, the label is a Bone: `true` draws a bar the height of the crumb
   * while the record loads, `false` draws the label. Unset, the crumb is plain text.
   */
  loading?: boolean;
}
export interface BreadcrumbProps { items: BreadcrumbItem[]; ariaLabel?: string }
/** A crumb's words; a crumb that names data wraps them in a Bone (inline, so the bar is the crumb's own box). */
/*
 * i10: A CRUMB'S WORDS CHANGE IN ONE FRAME, WITH THE PAGE (2026-11-09). They
 * used to letter-morph, which ran about half a second through unreadable states
 * ("Domains" to "o  s" to "Webhooks") and restarted when the page committed.
 * The crumb names the page, and the page now lands in one frame as its
 * skeleton; a crumb that arrives or leaves still slides.
 */
function label(item: BreadcrumbItem) {
  const words = item.label;
  if (item.loading === undefined) return words;
  return <Bone id="crumb" loading={item.loading} inline width={96} lineHeight={20}>{words}</Bone>;
}
/**
 * Crumbs present on first render stay still; crumbs added later slide in from the path before them.
 *
 * ⚠ i10 CHANGE: A CRUMB IS KEYED BY ITS PLACE IN THE PATH, NOT BY ITS LABEL, AND ITS LABEL CHANGES IN PLACE. Keyed by label,
 * moving between sibling pages (workspace > Overview to workspace > Domains) replaced the whole second crumb, and the
 * separator inside it, with a fresh one sliding in - so the part of the path that had not changed animated as if it
 * were new. Keyed by place, what stays stays: the separator holds still, the words change, and only a crumb at a new
 * place slides in or out.
 *
 * ⚠ AND A CRUMB WITH AN HREF STAYS A LINK WHEN IT BECOMES THE CURRENT PAGE (marked `aria-current`). Arc swapped it
 * for a <span>, a different element, so React rebuilt it and the crumb re-entered as if new.
 */
export function Breadcrumb({ items, ariaLabel = "Breadcrumb" }: BreadcrumbProps) {
  const reduced = useReducedMotion() ?? false;
  const still = { duration: 0 };
  const path = items.map(item => item.label).join("/");
  return <nav aria-label={ariaLabel}><ol className={styles.list}><AnimatePresence mode="popLayout" initial={false}>{items.map((item, index) => {
    const current = index === items.length - 1;
    return <motion.li key={`crumb-${index}`}
      layout={reduced ? false : "position"} layoutDependency={path}
      initial={reduced ? false : { opacity: 0, x: -8, filter: `blur(${motionTokens.blur.subtle}px)` }} animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={reduced ? { opacity: 0, transition: still } : { opacity: 0, x: -4, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] } }}
      transition={reduced ? still : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter], layout: motionTokens.spring.smooth }}
    >
      {index > 0 && <NavArrowRight width={14} height={14} aria-hidden="true"/>}
      {item.href ? <ArcLink href={item.href} data-label={item.label} aria-current={current ? "page" : undefined} onClick={item.onClick}>{label(item)}</ArcLink>
        : !current && item.onClick ? <button type="button" data-label={item.label} onClick={item.onClick}>{label(item)}</button>
        : <span aria-current={current ? "page" : undefined} data-label={item.label}>{label(item)}</span>}
    </motion.li>;
  })}</AnimatePresence></ol></nav>;
}
