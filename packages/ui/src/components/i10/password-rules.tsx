"use client"

import { useState } from "react"
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react"
import { cn } from "cn"
import { motionTokens } from "../lib/motion-tokens"
import {
  createPasswordRules,
  estimateStrength,
  type PasswordRule,
} from "../password-strength/password-strength"
import styles from "../password-strength/password-strength.module.css"

/**
 * Arc's password rule checklist, under a password field we already have.
 *
 * Arc ships the list inside its own PasswordStrength field. The product keeps
 * its floating password input, so this renders the same rules (Arc's
 * `createPasswordRules`), the same stylesheet and the same drawn tick beside
 * it. Guidance only: Clerk enforces the actual policy on submit.
 *
 * ⚠ AND ARC'S STRENGTH METER ABOVE THE LIST (2026-10-12), lifted the same way:
 * four segments that fill in a wave and change tone, and the strength word
 * that rises as it improves and drops as it falls. Our input stays ours.
 *
 * ⚠ THE METER SCORES AGAINST ARC'S FOUR RULES, NOT ONLY THE ONES THE POLICY
 * ENFORCES. An instance that requires nothing but length would otherwise have
 * a meter that jumps from "Too short" straight to "Strong"; scored on variety
 * it reads like a meter. Its "Too short" ends where the policy's length does,
 * so the meter and the first rule always agree about length.
 */
const enter = [...motionTokens.ease.enter] as [number, number, number, number]
const standard = [...motionTokens.ease.standard] as [number, number, number, number]

function RuleMark({
  met,
  delay,
  reduced,
}: {
  met: boolean
  delay: number
  reduced: boolean
}) {
  return (
    <span className={styles.mark} aria-hidden="true">
      <motion.span
        className={styles.markFill}
        initial={false}
        animate={{ scale: met ? 1 : 0.5, opacity: met ? 1 : 0 }}
        transition={
          reduced
            ? { duration: 0 }
            : {
                scale: { ...motionTokens.spring.snappy, delay },
                opacity: {
                  duration: met
                    ? motionTokens.duration.fast
                    : motionTokens.duration.instant,
                  delay,
                },
              }
        }
      />
      <svg
        className={styles.tick}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <motion.path
          d="M4.75 8.25 7 10.5l4.25-4.75"
          initial={false}
          animate={{ pathLength: met ? 1 : 0, opacity: met ? 1 : 0 }}
          transition={
            reduced
              ? { duration: 0 }
              : met
                ? {
                    pathLength: {
                      duration: motionTokens.duration.standard,
                      ease: enter,
                      delay: delay + 0.06,
                    },
                    opacity: { duration: 0.05, delay: delay + 0.06 },
                  }
                : {
                    pathLength: {
                      duration: motionTokens.duration.fast,
                      ease: standard,
                    },
                    opacity: { duration: motionTokens.duration.fast, delay: 0.06 },
                  }
          }
        />
      </svg>
    </span>
  )
}

const RULES = createPasswordRules({ minLength: 12 })

/** The word rises when strength improves and drops when it falls - Arc's own variants. */
const rise: Variants = {
  enter: (direction: number) => ({
    opacity: 0,
    y: `${0.3 * direction}em`,
    filter: `blur(${motionTokens.blur.soft}px)`,
  }),
  center: {
    opacity: 1,
    y: "0em",
    filter: "blur(0px)",
    transition: { duration: motionTokens.duration.standard, ease: enter },
  },
  exit: (direction: number) => ({
    opacity: 0,
    y: `${-0.3 * direction}em`,
    filter: `blur(${motionTokens.blur.subtle}px)`,
    transition: { duration: motionTokens.duration.fast, ease: standard },
  }),
}
const fade: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { duration: motionTokens.duration.fast } },
  exit: { opacity: 0, transition: { duration: motionTokens.duration.instant } },
}

/** Arc's four-segment meter and strength word, for a password field we own. */
function StrengthMeter({
  value,
  minLength,
  reduced,
}: {
  value: string
  minLength: number
  reduced: boolean
}) {
  const strength = estimateStrength(value, createPasswordRules({ minLength }), {
    shortLength: minLength,
  })
  // Which way the word moves, and where a pasted password's wave starts.
  const rank = strength.short ? 0.5 : strength.level
  const [track, setTrack] = useState({
    rank,
    level: strength.level,
    previousLevel: strength.level,
    direction: 1,
  })
  if (track.rank !== rank)
    setTrack({
      rank,
      level: strength.level,
      previousLevel: track.level,
      direction: rank > track.rank ? 1 : -1,
    })

  return (
    <div className={styles.field} data-level={strength.level}>
      <div className={cn(styles.meterRow, "mt-0!")}>
        <div
          className={styles.meter}
          role="meter"
          aria-label="Password strength"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={strength.level}
          aria-valuetext={strength.level ? strength.label : "No password yet"}
        >
          {[0, 1, 2, 3].map((index) => {
            const on = index < strength.level
            // A pasted password fills left to right; clearing empties right to left.
            const wave = on
              ? index - track.previousLevel
              : track.previousLevel - 1 - index
            return (
              <span key={index} className={styles.segment}>
                <motion.span
                  className={styles.fill}
                  initial={false}
                  animate={{ x: on ? "0%" : "-101%" }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : {
                          ...motionTokens.spring.smooth,
                          delay: Math.max(0, wave) * (on ? 0.05 : 0.03),
                        }
                  }
                />
              </span>
            )
          })}
        </div>
        <span className={styles.word} aria-hidden="true">
          <AnimatePresence mode="popLayout" initial={false} custom={track.direction}>
            {strength.level ? (
              <motion.span
                key={strength.label}
                className={styles.wordText}
                custom={track.direction}
                variants={reduced ? fade : rise}
                initial="enter"
                animate="center"
                exit="exit"
              >
                {strength.label}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </span>
      </div>
    </div>
  )
}

export function PasswordRules({
  value,
  rules = RULES,
  id,
  className,
  meter = true,
}: {
  value: string
  rules?: PasswordRule[]
  id?: string
  className?: string
  /** Arc's strength meter above the list. */
  meter?: boolean
}) {
  const reduced = !!useReducedMotion()
  // The policy's length, read back off its own rule: what is missing from "".
  const minLength = rules.find((rule) => rule.id === "length")?.remaining?.("") ?? 8
  let order = 0
  return (
    <div className={className}>
      {meter && <StrengthMeter value={value} minLength={minLength} reduced={reduced} />}
      <ul
        id={id}
        className={cn(styles.rules, !meter && "mt-0!")}
        aria-label="Password requirements"
      >
        {rules.map((rule) => {
          const met = rule.test(value)
          const delay = met ? order++ * 0.05 : 0
          return (
            <li key={rule.id} className={styles.rule} data-met={met || undefined}>
              <RuleMark met={met} delay={delay} reduced={reduced} />
              <span className={styles.ruleLabel}>{rule.label}</span>
              <span className={styles.srOnly}>{met ? ", met" : ", not met"}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
