import * as Cron from "effect/Cron"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Result from "effect/Result"

const EXAMPLE = '"0 9 * * 1-5" (9:00 on weekdays)'

/**
 * A schedule's time zone (default UTC): any name the runtime's Intl.DateTimeFormat takes ("GMT"
 * too, which Cron.parse alone reads as a broken "GMT+hh:mm" offset).
 */
const zoneOf = (timezone: string | undefined) => DateTime.zoneMakeNamed(timezone ?? "UTC")

export const cronProblem = (cron: string, timezone: string | undefined) => {
  const fields = cron.trim().split(/\s+/).length

  if (fields !== 5)
    return `the cron "${cron}" has ${fields} fields; use 5: minute hour day-of-month month day-of-week, e.g. ${EXAMPLE} (a minute is the shortest step)`

  const zone = zoneOf(timezone)

  if (Option.isNone(zone))
    return `the time zone "${timezone ?? ""}" isn't one the runtime knows (Intl.DateTimeFormat refuses it): use an IANA name like "America/Denver", "Europe/London" or "UTC"`

  const parsed = Cron.parse(cron, zone.value)

  if (Result.isFailure(parsed))
    return `the cron "${cron}" isn't one: ${parsed.failure.message}. Use 5 fields: minute hour day-of-month month day-of-week, e.g. ${EXAMPLE}`

  try {
    Cron.next(parsed.success)
  } catch {
    return `the cron "${cron}" never comes round (a date that doesn't exist, like February 31)`
  }

  return undefined
}

const MINUTE = 60_000

/** The longest a zone's clocks go back (Antarctica/Troll: 2 hours; elsewhere 1 hour or less). */
const LONGEST_FALL_BACK = 120 * MINUTE

const repeatsInFold = (cron: string) => {
  const [minute = "", hour = ""] = cron.trim().split(/\s+/)

  return minute.startsWith("*") || hour.startsWith("*")
}

const offset = (zone: DateTime.TimeZone, at: number) =>
  DateTime.zonedOffset(DateTime.makeZonedUnsafe(at, { timeZone: zone }))

export const nextRun = (cron: string, timezone: string | undefined, after: Date) => {
  const zone = DateTime.zoneMakeNamedUnsafe(timezone ?? "UTC")
  const parsed = Cron.parseUnsafe(cron, zone)
  const candidate = Cron.next(parsed, after)
  // Cron.next takes a repeated wall time as its first pass only, so a second-pass run is missed
  // just when it's at most one fall-back after `after`: scan those minutes with Cron.match.
  const at = after.getTime()
  const back = offset(zone, at - LONGEST_FALL_BACK) - offset(zone, at + LONGEST_FALL_BACK)

  if (back <= 0 || !repeatsInFold(cron)) return candidate

  const end = Math.min(candidate.getTime() - MINUTE, at + back)

  for (let minute = Math.floor(at / MINUTE) * MINUTE + MINUTE; minute <= end; minute += MINUTE)
    if (Cron.match(parsed, minute)) return new Date(minute)

  return candidate
}
