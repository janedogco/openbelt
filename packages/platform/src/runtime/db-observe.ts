import { AsyncLocalStorage } from "node:async_hooks"
import * as Predicate from "effect/Predicate"
import * as Fiber from "effect/Fiber"
import type * as Tracer from "effect/Tracer"
import { oneOf } from "./settings.ts"

const mode = oneOf("OPENBELT_DB_TRACE", ["sampled", "all", "off"], "sampled")

export type DbContext = {
  readonly parent: Tracer.Span
  readonly enqueued: number
  dispatched: boolean
}

export type DbTiming = {
  readonly queueMs: number
  readonly executionMs: number
  readonly transportMs: number
  readonly sqlQueueMs: number
}

export type DbTotals = DbTiming & { readonly count: number; readonly errors: number }

export const dbTotals = new WeakMap<Tracer.Span, DbTotals>()

export const dbContext = new AsyncLocalStorage<DbContext | undefined>()

/** Epoch milliseconds from the monotonic clock, comparable between this process's worker threads. */
export const now = () => performance.timeOrigin + performance.now()

/** Capture the calling fiber before the database's promise queue can inherit another request's context. */
export const withDbContext = <A>(work: () => A): A => {
  const parent = Fiber.getCurrent()?.cache.span

  const selected =
    mode === "all" ||
    (mode === "sampled" &&
      parent !== undefined &&
      Number.parseInt(parent.traceId.slice(-2), 16) % 16 === 0)

  return dbContext.run(
    parent !== undefined && Predicate.isTagged(parent, "Span") && selected
      ? { parent, enqueued: now(), dispatched: false }
      : undefined,
    work,
  )
}
