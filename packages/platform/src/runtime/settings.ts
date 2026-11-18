// The environment settings the runtime reads (docs/running.md says what each does), read with Effect's Config and checked: a value
// that isn't one (OPENBELT_SANDBOX_PROCESSES=eight, OPENBELT_LOG_LEVEL=verbose) stops the platform when it starts, with a line naming the
// setting, where it used to become the default unnoticed. Unset or empty: the default.
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"

/** `config`'s value now, or an error that names `name` and what it holds. */
const setting = <A>(name: string, config: Config.Config<A>): A => {
  const exit = Effect.runSyncExit(
    Effect.gen(function* () {
      return yield* config
    }),
  )

  if (Exit.isSuccess(exit)) return exit.value

  const why = Cause.pretty(exit.cause).split("\n")[0] ?? ""

  throw new Error(
    `the setting ${name}=${JSON.stringify(process.env[name] ?? "")} isn't one OpenBelt can use: ${why}`,
  )
}

const Positive = Schema.Int.check(Schema.isGreaterThan(0))

/** A whole number above 0, or `fallback`. */
export const positive = (name: string, fallback: number) =>
  setting(name, Config.schema(Positive, name).pipe(Config.withDefault(fallback)))

/** A TCP port (1 to 65535), or `fallback`. */
export const port = (name: string, fallback: number) =>
  setting(name, Config.Port(name).pipe(Config.withDefault(fallback)))

/** Text, or `fallback`. */
export const text = (name: string, fallback: string) =>
  setting(name, Config.String(name).pipe(Config.withDefault(fallback)))

/** One of `values`, or `fallback`. */
export const oneOf = <const L extends ReadonlyArray<string>>(
  name: string,
  values: L,
  fallback: L[number],
) => setting(name, Config.Literals(values, name).pipe(Config.withDefault(fallback)))
