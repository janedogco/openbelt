// A sandbox process confining itself once it has loaded what it needs (sandbox-process.ts): from then on it may read no file, write
// none, start no process, open no connection and signal no other process; what it has left is its stdin and stdout to the platform.
// macOS: sandbox_init with a deny-by-default profile. Linux: Landlock, every right its ABI knows handled and none granted, and
// no_new_privs, then a seccomp filter on every thread for what Landlock leaves open or confines only on newer kernels: sockets
// (UDP and Unix ones), signals to other processes, ptrace and reading other processes' memory. Code that escaped QuickJS's WASM
// would land here: no secrets (the platform starts it with a clean environment, as nobody when it is root), and nothing to reach.
import { dlopen, FFIType, ptr } from "bun:ffi"

const MAC_PROFILE = `(version 1)
(deny default)
(allow signal (target self))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (subpath "/usr/share/zoneinfo") (subpath "/private/var/db/timezone") (subpath "/usr/share/icu") (subpath "/System/Library") (subpath "/usr/lib") (literal "/dev/urandom") (literal "/dev/null"))
`

const confineMac = () => {
  const library = dlopen("/usr/lib/libsandbox.1.dylib", {
    sandbox_init: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  })

  const error = new BigUint64Array(1)
  const profile = Buffer.from(`${MAC_PROFILE}\0`)

  if (library.symbols.sandbox_init(ptr(profile), 0n, ptr(error)) !== 0)
    throw new Error("sandbox_init refused the profile")

  return "sandbox_init, deny by default"
}

/** Landlock's syscalls (the same numbers on x86-64 and arm64) and prctl's no_new_privs. */
const CREATE = 444

const RESTRICT = 446

const NO_NEW_PRIVS = 38

const VERSION = 1

/** The file rights each ABI added: execute, write, read, read a directory, remove and make every kind, refer, truncate, ioctl. */
const FILE_RIGHTS = (abi: number) =>
  (2 ** 13 - 1) | (abi >= 2 ? 2 ** 13 : 0) | (abi >= 3 ? 2 ** 14 : 0) | (abi >= 5 ? 2 ** 15 : 0)

/** The syscalls the filter names, by architecture: x86-64 and arm64 number them differently, except the newest. */
const SYSCALLS = {
  x64: {
    arch: 0xc000003e,
    socket: 41,
    kill: 62,
    tkill: 200,
    tgkill: 234,
    rt_sigqueueinfo: 129,
    rt_tgsigqueueinfo: 297,
    ptrace: 101,
    process_vm_readv: 310,
    process_vm_writev: 311,
    seccomp: 317,
  },
  arm64: {
    arch: 0xc00000b7,
    socket: 198,
    kill: 129,
    tkill: 130,
    tgkill: 131,
    rt_sigqueueinfo: 138,
    rt_tgsigqueueinfo: 240,
    ptrace: 117,
    process_vm_readv: 270,
    process_vm_writev: 271,
    seccomp: 277,
  },
} as const

/** The same on both: pidfd_send_signal, io_uring_setup, pidfd_open, pidfd_getfd. */
const SHARED = { pidfd_send_signal: 424, io_uring_setup: 425, pidfd_open: 434, pidfd_getfd: 438 }

const LOAD = 0x20

const EQUAL = 0x15

const AT_LEAST = 0x35

const RETURN = 0x06

const ALLOW = 0x7fff0000

const EPERM = 0x00050001

const KILL_PROCESS = 0x80000000

/** x86-64's x32 calls: the same syscalls under other numbers. */
const X32 = 0x40000000

type Step = {
  readonly code: number
  readonly k: number
  readonly yes?: string
  readonly no?: string
  readonly at?: string
}

/** A classic BPF program, its jumps by label (a jump is a count of steps forward, resolved here). */
const assemble = (steps: ReadonlyArray<Step>) => {
  const where = new Map(steps.flatMap((step, i) => (step.at === undefined ? [] : [[step.at, i]])))

  const jump = (from: number, label: string | undefined) => {
    if (label === undefined) return 0

    const to = where.get(label)

    if (to === undefined || to <= from) throw new Error(`seccomp: no step ${label} after ${from}`)

    return to - from - 1
  }

  const program = Buffer.alloc(steps.length * 8)

  steps.forEach((step, i) => {
    program.writeUInt16LE(step.code, i * 8)
    program.writeUInt8(jump(i, step.yes), i * 8 + 2)
    program.writeUInt8(jump(i, step.no), i * 8 + 3)
    program.writeUInt32LE(step.k >>> 0, i * 8 + 4)
  })

  return program
}

/**
 * Sockets are refused outright (it talks to the platform over pipes): Landlock has no say over UDP, and ABI 4 and 5 none over
 * abstract Unix sockets. Signals go to this process only (Landlock scopes them from ABI 6; before, another workspace's sandbox, running
 * as the same nobody, could be killed). ptrace, other processes' memory, pidfds and new io_uring rings (whose operations seccomp
 * doesn't see) are refused. Another architecture's calls end the process.
 */
const filter = () => {
  const arch =
    process.arch === "x64" || process.arch === "arm64" ? SYSCALLS[process.arch] : undefined

  if (arch === undefined)
    throw new Error(`no seccomp filter for ${process.arch}: the sandbox runs on x86-64 and arm64`)

  const refused = [
    arch.socket,
    arch.tkill,
    arch.ptrace,
    arch.process_vm_readv,
    arch.process_vm_writev,
    SHARED.pidfd_send_signal,
    SHARED.pidfd_open,
    SHARED.pidfd_getfd,
    SHARED.io_uring_setup,
  ]

  // Their first argument is the process the signal is for: allowed when that is this one.
  const toSelf = [arch.kill, arch.tgkill, arch.rt_sigqueueinfo, arch.rt_tgsigqueueinfo]

  const program = assemble([
    { code: LOAD, k: 4 },
    { code: EQUAL, k: arch.arch, no: "kill" },
    { code: LOAD, k: 0 },
    ...(process.arch === "x64" ? [{ code: AT_LEAST, k: X32, yes: "deny" }] : []),
    ...refused.map((nr) => ({ code: EQUAL, k: nr, yes: "deny" })),
    ...toSelf.map((nr) => ({ code: EQUAL, k: nr, yes: "self" })),
    { code: RETURN, k: ALLOW },
    // BPF jumps only forward: the answers come last.
    { code: LOAD, k: 16, at: "self" },
    { code: EQUAL, k: process.pid, no: "deny" },
    { code: LOAD, k: 20 },
    { code: EQUAL, k: 0, yes: "allow", no: "deny" },
    { code: RETURN, k: ALLOW, at: "allow" },
    { code: RETURN, k: EPERM, at: "deny" },
    { code: RETURN, k: KILL_PROCESS, at: "kill" },
  ])

  const libc = dlopen("libc.so.6", {
    syscall: {
      args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
      returns: FFIType.i64,
    },
  })

  const fprog = Buffer.alloc(16)

  fprog.writeUInt16LE(program.length / 8, 0)
  fprog.writeBigUInt64LE(BigInt(ptr(program)), 8)

  // SECCOMP_SET_MODE_FILTER with SECCOMP_FILTER_FLAG_TSYNC: every thread, not only this one (Landlock confines only this one).
  const set = Number(libc.symbols.syscall(arch.seccomp, 1, 1, Number(ptr(fprog))))

  if (set !== 0)
    throw new Error(
      set > 0
        ? `seccomp couldn't filter thread ${set} of this process`
        : "seccomp refused the filter",
    )
}

const confineLinux = () => {
  const libc = dlopen("libc.so.6", {
    syscall: {
      args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
      returns: FFIType.i64,
    },
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  })

  const abi = Number(libc.symbols.syscall(CREATE, 0, 0, VERSION))

  if (abi < 1)
    throw new Error(
      "this kernel has no Landlock (it needs Linux 5.13 or later, with Landlock enabled)",
    )

  // TCP bind and connect from ABI 4; abstract Unix sockets and signals to other processes from ABI 6.
  const network = abi >= 4 ? 3 : 0
  const scoped = abi >= 6 ? 3 : 0
  const attributes = new BigUint64Array([BigInt(FILE_RIGHTS(abi)), BigInt(network), BigInt(scoped)])
  const size = abi >= 6 ? 24 : abi >= 4 ? 16 : 8
  const ruleset = Number(libc.symbols.syscall(CREATE, Number(ptr(attributes)), size, 0))

  if (ruleset < 0) throw new Error(`Landlock refused the ruleset (${ruleset})`)

  if (libc.symbols.prctl(NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0)
    throw new Error("prctl(PR_SET_NO_NEW_PRIVS) failed")

  if (Number(libc.symbols.syscall(RESTRICT, ruleset, 0, 0)) !== 0)
    throw new Error("Landlock couldn't restrict the process")

  filter()

  return `Landlock ABI ${abi}: no files${network === 0 ? "" : ", no TCP"}${scoped === 0 ? "" : ", no signals or abstract sockets out"}; seccomp on every thread: no sockets, signals to itself only, no ptrace or other processes' memory`
}

/** Confine this process, saying how; throws when it can't (the sandbox process then exits, and its runs fail saying why). */
export const confine = () => (process.platform === "darwin" ? confineMac() : confineLinux())
