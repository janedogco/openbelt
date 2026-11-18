// check_app's browser: a headless Chrome the platform starts itself, one per check, driven over the DevTools protocol (Playwright).
// Where Chrome is: OPENBELT_CHROME_PATH, else the usual places for the OS.
import { chownSync, existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Context from "effect/Context"
import { type Browser as Chrome, chromium } from "playwright-core"
import { startEgress } from "./egress.ts"
import { say } from "./observe.ts"
import { text } from "./settings.ts"

export type BrowserLauncher = {
  /** A fresh headless Chrome with a profile of its own, gone when it closes. */
  readonly launch: () => Promise<{ readonly browser: Chrome; readonly close: () => Promise<void> }>
}

export class Browser extends Context.Service<Browser, BrowserLauncher>()("openbelt/Browser") {}

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]

const chromePath = (): string => {
  const set = text("OPENBELT_CHROME_PATH", "")

  if (set !== "") return set

  const pinned = chromium.executablePath()
  const found = existsSync(pinned) ? pinned : CANDIDATES.find((path) => existsSync(path))

  if (found === undefined) {
    throw new Error(
      "check_app needs Chrome and none was found: install it, or set OPENBELT_CHROME_PATH to its executable",
    )
  }

  return found
}

let egress: Promise<number> | undefined

/** The uid Chrome runs as when the platform is root: its own, not the sandboxes' (65534), so neither can reach the other. */
const CHROME_UID = 990

const root = process.getuid?.() === 0

let wrapperPath: string | undefined

/**
 * Under root (a container), Chrome starts through a wrapper that hands Playwright's profile directory to CHROME_UID and becomes
 * CHROME_UID with nothing of the platform's environment. Chrome's own sandbox then works where the container's seccomp profile allows user namespaces (deploy/seccomp.json),
 * and a renderer that broke out of it is a user without the platform's secrets, its data directory (localdb.ts) or its processes'
 * internal servers (internal-key.ts).
 */
const wrapper = (): string => {
  if (wrapperPath !== undefined) return wrapperPath

  // Root's alone (0700): nothing else on the machine can change what root runs.
  const dir = mkdtempSync(join(tmpdir(), "openbelt-chrome-"))
  const home = mkdtempSync(join(tmpdir(), "openbelt-chrome-home-"))

  chownSync(home, CHROME_UID, CHROME_UID)

  const path = join(dir, "chrome")

  writeFileSync(
    path,
    `#!/bin/sh
for a in "$@"; do case "$a" in --user-data-dir=*) chown -R ${CHROME_UID}:${CHROME_UID} "\${a#--user-data-dir=}";; esac; done
exec setpriv --reuid=${CHROME_UID} --regid=${CHROME_UID} --clear-groups --inh-caps=-all --bounding-set=-all env -i HOME=${home} PATH=/usr/bin:/bin LANG=C.UTF-8 "${chromePath()}" "$@"
`,
    { mode: 0o700 },
  )

  wrapperPath = path

  return path
}

/** Whether Chrome's own sandbox starts here: under root it needs user namespaces, which Docker's default seccomp profile refuses (and Ubuntu 24.04's AppArmor, in a container run apparmor=unconfined). */
let sandboxWorks: boolean | undefined

/** The most JavaScript heap one page may hold, in MB. */
const PAGE_HEAP_MB = 512

const launchChrome = (proxy: number, sandbox: boolean) =>
  chromium.launchServer({
    host: "127.0.0.1",
    timeout: 10_000,
    executablePath: root ? wrapper() : chromePath(),
    headless: true,
    chromiumSandbox: sandbox,
    env: { PATH: "/usr/bin:/bin", HOME: tmpdir() },
    // Its own signal listeners only close Chrome, and swallowed the platform's exit (shutdown.ts).
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      // Chrome with a fresh profile asks macOS's keychain for its cookie key: not for a throwaway profile.
      "--use-mock-keychain",
      "--password-store=basic",
      // Every request through egress.ts, loopback names too (Chrome sends those straight out unless told not to), and no UDP
      // around it: WebRTC's. The image's managed policy says the same, which is what stopped it there (Dockerfile).
      `--proxy-server=http://127.0.0.1:${proxy}`,
      "--proxy-bypass-list=<-loopback>",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      // A page's JavaScript heap, at most (Chrome sets none): up to 6 browsers run at once (checks and pictures), and pages of 1.6 GB
      // each took a 4 GB container into swap. A page past it crashes, and the check says so.
      `--js-flags=--max-old-space-size=${PAGE_HEAP_MB}`,
    ],
  })

/** Chrome with its own sandbox, or, once that has failed to start here, without it (still as CHROME_UID under root). */
const startChrome = async (proxy: number) => {
  if (sandboxWorks !== false) {
    try {
      const server = await launchChrome(proxy, true)

      sandboxWorks = true

      return server
    } catch (error) {
      if (sandboxWorks === true || !root) throw error

      sandboxWorks = false
      say(
        "warn",
        "browser: Chrome's own sandbox can't start here (user namespaces are refused: the container's seccomp profile, or the host's AppArmor when the container runs unconfined), so check_app's Chrome runs without it, as its own user; deploy/seccomp.json allows it (docs/running.md, \"check_app's browser\")",
      )
    }
  }

  return await launchChrome(proxy, false)
}

export const browser: BrowserLauncher = {
  launch: async () => {
    egress ??= startEgress()

    const proxy = await egress

    const server = await startChrome(proxy)

    // Next in line after the sandboxes (1000) for the kernel's out-of-memory killer, before the platform's processes (0). Set
    // once it runs: Chrome sets its own at start (its renderers 300).
    if (root) {
      try {
        writeFileSync(`/proc/${server.process().pid}/oom_score_adj`, "800")
      } catch {
        // gone already, or not allowed: the kernel picks as it would
      }
    }

    const guard = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "browser-lifeline.ts"),
        String(server.process().pid),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      },
    )

    // Killed, not closed: its profile is thrown away, so nothing needs Chrome's own shutdown, which took 100-230 ms and now and then
    // hung until a kill at 5 s. A kill takes about 20 ms, ends its helper processes and its port, removes its profile, and runs no
    // page's unload handlers (a beacon the page would send as it closed).
    const close = async () => {
      try {
        await server.kill()
      } finally {
        guard.kill()
        await guard.exited
      }
    }

    try {
      const ready = guard.stdout.getReader()

      try {
        const signal = await ready.read()

        if (signal.done) throw new Error("browser watchdog exited before it was ready")
      } finally {
        ready.releaseLock()
      }

      return { browser: await chromium.connect(server.wsEndpoint(), { timeout: 5000 }), close }
    } catch (cause) {
      await close()
      throw cause
    }
  },
}
