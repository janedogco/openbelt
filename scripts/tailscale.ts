import { Option, Schema } from "effect"

const Status = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      BackendState: Schema.String,
      Self: Schema.Struct({ DNSName: Schema.String, UserID: Schema.Number }),
      User: Schema.Record(
        Schema.String,
        Schema.Struct({ LoginName: Schema.String, DisplayName: Schema.String }),
      ),
    }),
  ),
)

export const tailscale = (fail: (message: string) => never) => {
  if (Bun.which("tailscale") === null)
    fail("tailscale isn't on your PATH: install Tailscale (https://tailscale.com/download)")

  const status = Option.getOrElse(
    Status(Bun.spawnSync(["tailscale", "status", "--json"]).stdout.toString()),
    () => fail("tailscale status --json didn't answer: is Tailscale running?"),
  )

  if (status.BackendState !== "Running")
    fail(`Tailscale is ${status.BackendState}: run tailscale up`)

  return {
    host: status.Self.DNSName.replace(/\.$/, ""),
    login: status.User[String(status.Self.UserID)]?.LoginName ?? "",
    name: status.User[String(status.Self.UserID)]?.DisplayName ?? "",
  }
}

const Served = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      TCP: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      Web: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            Handlers: Schema.Record(
              Schema.String,
              Schema.Struct({ Proxy: Schema.optional(Schema.String) }),
            ),
          }),
        ),
      ),
    }),
  ),
)

const served = () =>
  Bun.which("tailscale") === null
    ? Option.none()
    : Served(Bun.spawnSync(["tailscale", "serve", "status", "--json"]).stdout.toString())

export const servedPorts = () =>
  Option.match(served(), {
    onNone: () => new Set<number>(),
    onSome: (s) => new Set(Object.keys(s.TCP ?? {}).map(Number)),
  })

export const servedTo = (host: string, port: number) =>
  Option.match(served(), {
    onNone: () => undefined,
    onSome: (s) => s.Web?.[`${host}:${port}`]?.Handlers["/"]?.Proxy,
  })

export const serves = () =>
  Option.match(served(), {
    onNone: () => [],
    onSome: (s) =>
      Object.entries(s.Web ?? {}).flatMap(([hostPort, web]) => {
        const proxy = web.Handlers["/"]?.Proxy

        return proxy === undefined ? [] : [{ https: Number(hostPort.split(":").pop()), proxy }]
      }),
  })
