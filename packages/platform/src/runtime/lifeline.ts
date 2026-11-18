// A helper process's lifeline to the process that started it. macOS has no parent-death signal, and a parent that dies hard
// (SIGKILL, a crash, an agent stopped mid-run, a verify run killed) runs no cleanup of its own, so what it started kept running:
// 240 headless Chromes and 15 test MCP servers were found days later, holding most of a Mac's memory. A parent that owns a child
// spawns it with stdin: "pipe" and never writes to or closes it; the kernel closes the parent's end when the parent ends, however
// it ended, and the child sees its stdin end. (Bun.spawn's "pipe" is a socket pair, a shell's `|` a FIFO: both count.)
// scripts/guard.ts holds every spawn of a bun script to it.
import { fstatSync } from "node:fs"

/**
 * End this process when the one that started it ends: `end` runs then (by default, exit at once; the platform stops as on
 * SIGTERM, a verify check stops the platform it launched first). A process started without a pipe on stdin (one meant to outlive
 * its parent, as `bun run world --keep`'s providers, or one started from a terminal or a service) is left alone. It doesn't keep
 * the process alive by itself.
 */
export const exitWithParent = (end: () => void = () => process.exit(0)) => {
  const stdin = fstatSync(0)

  if (!stdin.isFIFO() && !stdin.isSocket()) return

  process.stdin.on("end", end)
  process.stdin.resume()
  process.stdin.unref()
}
