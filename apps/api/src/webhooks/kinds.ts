/**
 * What a delivery row for a polling endpoint differs by (#301): no attempt is
 * owed, so the sweep never finds it and nothing queues it. It waits, pending,
 * until a poll acknowledges it. Every path that writes delivery rows spreads
 * this in: ingestion, health fan-out, test events.
 */
export const pollingRow = (kind: "http" | "polling" | "sqs") =>
  kind === "polling" ? { nextAttemptAt: null } : {}
