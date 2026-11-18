// A few slots for something the whole platform does at most N at a time, whatever process does it: a slot is an exclusive flock on
// a file in the data directory, taken without waiting and let go when done (or when the process ends: the kernel drops its locks).
// Several processes of one platform (one namespace of the data directory) share the slots; another platform on the same machine has
// its own, even on the same data directory (verify's platforms each have a namespace of .verify/data; sharing, one check's burst of
// pictures waited out another's).
import { dlopen, FFIType } from "bun:ffi"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import { hostNamespace } from "./actor.ts"
import { dataDir } from "./localdb.ts"

const LOCK_EX = 2

const LOCK_NB = 4

const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})

/** One of `count` slots named `name`, if one is free: a function that lets it go; undefined when all are taken. */
export const takeSlot = (name: string, count: number): (() => void) | undefined => {
  const where = join(dataDir(), ".slots", hostNamespace())

  mkdirSync(where, { recursive: true })

  for (let i = 0; i < count; i++) {
    const fd = openSync(join(where, `${name}-${i}`), "a")

    if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) {
      let held = true

      return () => {
        if (!held) return

        held = false
        // Closing the file lets go of its lock.
        closeSync(fd)
      }
    }

    closeSync(fd)
  }

  return undefined
}
