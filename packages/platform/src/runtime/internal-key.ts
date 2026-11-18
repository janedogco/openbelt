// The key a machine's platform processes send each other's internal servers (actor.ts): the supervisor makes one per start and
// gives it to its processes, and nothing else on the machine has it. Those servers listen on loopback and run any object's
// methods, so without it anything that ran on the machine (a check_app browser that broke out) could act in any workspace.
import { timingSafeEqual } from "node:crypto"

const HEADER = "x-openbelt-internal"

const key = process.env["OPENBELT_INTERNAL_KEY"] ?? ""

/** What a request to another process's internal server carries. */
export const internalHeaders: Readonly<Record<string, string>> = { [HEADER]: key }

/** Whether a request to this process's internal server came from a process of this platform. */
export const fromPlatform = (request: Request) => {
  const want = new TextEncoder().encode(key)
  const got = new TextEncoder().encode(request.headers.get(HEADER) ?? "")

  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want)
}

/** A new key, for the supervisor to give the processes it starts (OPENBELT_INTERNAL_KEY). */
export const newInternalKey = () => crypto.randomUUID() + crypto.randomUUID()
