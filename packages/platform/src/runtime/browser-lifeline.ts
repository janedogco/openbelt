import * as Schema from "effect/Schema"
import { exitWithParent } from "./lifeline.ts"

const pid = Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThan(1)))(
  Number(process.argv[2]),
)

exitWithParent(() => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {}

  process.exit(0)
})

process.stdout.write("ready\n")

setInterval(() => {}, 60_000)
