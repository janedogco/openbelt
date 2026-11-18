import * as Schema from "effect/Schema"

export const EventsQuery = Schema.Struct({
  q: Schema.String,
  person: Schema.String,
  tool: Schema.String,
  app: Schema.String,
  source: Schema.Literals(["all", "tools", "connections"]),
  outcome: Schema.Literals(["all", "ok", "errors", "refused"]),
  page: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 110 })),
})

export type EventsQuery = typeof EventsQuery.Type

export type WorkspaceEvent = {
  readonly source: "tools" | "connections"
  readonly at: string
  readonly tool: string
  readonly person: string
  readonly client: string
  readonly app: string
  readonly trace: string
  readonly outcome: string
  readonly ms: number
  readonly args: string
  readonly error: string
}

export type EventsData = {
  readonly shown: EventsQuery
  readonly events: ReadonlyArray<WorkspaceEvent>
  readonly total: number
  readonly people: ReadonlyArray<string>
  readonly tools: ReadonlyArray<string>
  readonly apps: ReadonlyArray<string>
  readonly retained: number
}
