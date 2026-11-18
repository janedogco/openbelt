import { X509Certificate } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Certificate = {
  readonly serverName: string
  readonly cert: string
  readonly key: string
}

const DEV_ENV = join(homedir(), ".config", "openbelt", "dev.env")

export const SETUP =
  'To put it on your tailnet, every app needs a host of its own, which tailscale serve can\'t give: once, set up a domain for it (docs/tailnet.md, "A domain for the tailnet"), with OPENBELT_DEV_DOMAIN, OPENBELT_DEV_CERT and OPENBELT_DEV_KEY in ~/.config/openbelt/dev.env.'

export type Domain = {
  readonly domain: string
  readonly cert: string
  readonly key: string
  readonly from: string
}

const DEV_KEYS = ["OPENBELT_DEV_DOMAIN", "OPENBELT_DEV_CERT", "OPENBELT_DEV_KEY"] as const

const devEnv = (): Partial<Record<(typeof DEV_KEYS)[number], string>> => {
  if (!existsSync(DEV_ENV)) return {}

  const lines = readFileSync(DEV_ENV, "utf8")
    .split("\n")
    .map((line) => line.trim().replace(/^export\s+/, ""))

  return Object.fromEntries(
    DEV_KEYS.flatMap((key) => {
      const line = lines.find((l) => l.startsWith(`${key}=`))

      if (line === undefined) return []

      const value = line
        .slice(key.length + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .replace(/^~\//, `${homedir()}/`)

      return [[key, value]]
    }),
  )
}

export const domainOf = (fail: (message: string) => never): Domain | undefined => {
  const fromEnv = (process.env.OPENBELT_DEV_DOMAIN ?? "") !== ""
  const set = fromEnv ? process.env : devEnv()
  const from = fromEnv ? "the environment" : tilde(DEV_ENV)
  const domain = set.OPENBELT_DEV_DOMAIN ?? ""

  if (domain === "") return undefined

  const cert = set.OPENBELT_DEV_CERT ?? ""
  const key = set.OPENBELT_DEV_KEY ?? ""

  if (!existsSync(cert) || !existsSync(key))
    fail(
      `OPENBELT_DEV_DOMAIN is ${domain} (from ${from}), but its certificate files aren't there (OPENBELT_DEV_CERT="${cert}", OPENBELT_DEV_KEY="${key}"): docs/tailnet.md, "A domain for the tailnet"`,
    )

  return { domain, cert, key, from }
}

const tilde = (path: string) => path.replace(homedir(), "~")

const RENEW_DAYS = 14

const renewCommand = (domain: Domain) => {
  const path = dirname(dirname(domain.cert))
  const accounts = join(path, "accounts")

  const emails = existsSync(accounts)
    ? readdirSync(accounts).flatMap((server) => readdirSync(join(accounts, server)))
    : []

  const email = emails.length === 1 ? emails[0] : "<you>"

  return `lego run --env-file ${tilde(DEV_ENV)} --path ${tilde(path)} --dns cloudflare --dns.propagation.wait 60s --accept-tos --email ${email} -d ${domain.domain} -d '*.${domain.domain}'`
}

/** The names a certificate is for (its subject alternative names). */
const namesOf = (cert: X509Certificate) =>
  (cert.subjectAltName ?? "")
    .split(",")
    .map((name) => name.trim())
    .flatMap((name) => (name.startsWith("DNS:") ? [name.slice(4)] : []))

export const describeDomain = (domain: Domain): ReadonlyArray<string> => {
  const cert = new X509Certificate(readFileSync(domain.cert))
  const expires = new Date(cert.validTo)
  const days = Math.floor((expires.getTime() - Date.now()) / 86_400_000)
  const when = days < 0 ? `expired ${-days} days ago` : `expires in ${days} days`

  const about = `domain ${domain.domain} (from ${domain.from}), certificate ${tilde(domain.cert)}: ${when}, ${expires.toISOString().slice(0, 10)}`

  return [
    about,
    ...(days >= RENEW_DAYS
      ? []
      : [
          `WARNING: the certificate for *.${domain.domain} ${when}. Renew it, then restart: ${renewCommand(domain)}`,
        ]),
    ...(namesOf(cert).includes(`*.${domain.domain}`)
      ? []
      : [
          `WARNING: the certificate isn't for *.${domain.domain}, so workspaces' and apps' hosts (<app>--<workspace>.${domain.domain}) fail their TLS handshake. Get one that is, then restart: ${renewCommand(domain)}`,
        ]),
  ]
}

const machineCertificate = (machine: string, dir: string): Certificate | undefined => {
  mkdirSync(dir, { recursive: true })

  const cert = join(dir, `${machine}.crt`)
  const key = join(dir, `${machine}.key`)

  const made = Bun.spawnSync(
    ["tailscale", "cert", "--cert-file", cert, "--key-file", key, machine],
    { stdout: "ignore", stderr: "ignore" },
  )

  return made.exitCode === 0 ? { serverName: machine, cert, key } : undefined
}

export const tailnetAddress = () =>
  Bun.spawnSync(["tailscale", "ip", "-4"]).stdout.toString().trim().split("\n")[0] ?? ""

/** The domain's certificate once per wildcard it is for (*.<domain>: a server name matches one level), and the machine's. */
export const certificatesOf = (domain: Domain, machine: string, dir: string) => {
  const own = machineCertificate(machine, dir)

  const wildcards = namesOf(new X509Certificate(readFileSync(domain.cert)))
    .filter((name) => name.startsWith("*."))
    .map((serverName) => ({ serverName, cert: domain.cert, key: domain.key }))

  return own === undefined ? wildcards : [...wildcards, own]
}
