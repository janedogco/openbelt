// OpenBelt: the gateway answering HTTP, and the Durable Objects (WorkspaceDO, AppDO, McpDO), each a SQLite file in OPENBELT_DATA.
//   bun packages/platform/src/server.ts
// It runs as a supervisor (runtime/supervisor.ts) and OPENBELT_PROCESSES platform processes under it (platform.ts), all on one port:
// this file is both, told apart by OPENBELT_PROCESS, which the supervisor sets for the processes it starts.
// Configuration (environment):
//   OPENBELT_PORT               the port to serve on (default 1337)
//   OPENBELT_PROCESSES          platform processes (default 1; "auto": one per 2 CPUs, at most 4)
//   OPENBELT_DATA               where the objects' files are (default ~/.openbelt/data)
//   OPENBELT_NAMESPACE          the directory in it this instance's objects are in (default "openbelt")
// The rest (OPENBELT_HOST, OPENBELT_ADMIN_TOKEN, OPENBELT_SIGNIN, ...) is read where it is used (docs/running.md).
import { exitWithParent } from "./runtime/lifeline.ts"

// Started by a process that owns it (bun run dev, a check) with a pipe on stdin: it stops, as on SIGTERM, when that process ends,
// however it ended. Started by launch.ts, compose or a service, it has no pipe and runs on (runtime/lifeline.ts).
exitWithParent(() => process.kill(process.pid, "SIGTERM"))

if (process.env["OPENBELT_PROCESS"] === undefined) await import("./runtime/supervisor.ts")
else await import("./platform.ts")
