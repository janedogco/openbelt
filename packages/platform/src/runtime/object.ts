// A Durable Object: a named, single-threaded object with its own storage that other code reaches by name. `class AppDO extends
// DurableObject("AppDO", impl)` declares one; `yield* AppDO` gives its namespace; `.getByName(name)` a stub whose members are
// the methods `impl` returns, each now an Effect that crosses to wherever the object lives. A typed failure crosses as a plain
// `{ _tag, ... }`; a defect crosses with its message and stack.
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Effectable from "effect/Effectable"
import type * as Scope from "effect/Scope"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { currentWire, SPAN_HEADER } from "./observe.ts"
import { fromWire, toWire } from "./wire.ts"
import type { Browser } from "./browser.ts"
import type { Jobs } from "./jobs.ts"
import type { WorkerLoader } from "./sandbox.ts"
import type { DurableObjectState } from "./state.ts"

/** A call to an object failed outside its code: it could not be reached, or it died on the way. */
class RpcCallError extends Data.TaggedError("RpcCallError")<{
  readonly method: string
  readonly cause: unknown
}> {
  override get message() {
    return `RPC call to "${this.method}" failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`
  }
}

/** What an object's `impl` returns: its methods (each an Effect, or a function to one) and the events it handles. */
export type ObjectMembers = Record<string, unknown>

/** What an `impl` may need: the object's state, its jobs, a place to run functions, and a browser. */
export type ObjectServices = DurableObjectState | Jobs | WorkerLoader | Browser | Scope.Scope

export type ObjectImpl<Members extends ObjectMembers> = Effect.Effect<
  Effect.Effect<Members, never, ObjectServices>,
  unknown,
  ObjectServices
>

/** The members that are events the runtime delivers, not methods a caller invokes. */
export type EventName = "fetch" | "alarm" | "webSocketMessage" | "webSocketClose"

export type Stub<Members extends ObjectMembers> = {
  readonly [K in Exclude<keyof Members, EventName>]: Members[K] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, infer E, infer _R>
    ? (...args: Args) => Effect.Effect<A, E>
    : Members[K] extends Effect.Effect<infer A, infer E, infer _R>
      ? Effect.Effect<A, E>
      : never
} & {
  /** Hand the object an HTTP request; its `fetch` answers. */
  readonly fetch: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>
}

/** Objects of one class by key: `Key` is a branded string where only an id may name one (WorkspaceDO's WorkspaceId), else any string. */
export type Namespace<Members extends ObjectMembers, Key extends string = string> = {
  readonly name: string
  readonly getByName: (name: Key) => Stub<Members>
}

/** The object class as a value: an Effect that gives its namespace. */
export type ObjectClass<Members extends ObjectMembers, Key extends string = string> = {
  new (_: never): object
} & Effect.Effect<Namespace<Members, Key>>

/** An object class reached only by `Key` (a branded id): asking for a stub by any other string is a type error. */
export const keyedBy =
  <Key extends string>() =>
  <Members extends ObjectMembers>(cls: ObjectClass<Members>): ObjectClass<Members, Key> =>
    cls

/** Every declared object by class name: the actor looks its code up here. */
const declared = new Map<string, ObjectImpl<ObjectMembers>>()

export const implOf = (name: string): ObjectImpl<ObjectMembers> | undefined => declared.get(name)

/** How a stub reaches an object: set once by whoever hosts the actors (actor.ts). */
export type Transport = {
  readonly call: (
    cls: string,
    name: string,
    method: string,
    /** The arguments, as wire text (wire.ts). */
    args: string,
    /** The caller's span (observe.ts), so the callee's spans join its trace. */
    parent?: string,
  ) => Promise<unknown>
  readonly fetch: (cls: string, name: string, request: Request) => Promise<Response>
}

let transport: Transport | undefined

export const useTransport = (next: Transport) => {
  transport = next
}

const reached = (): Transport => {
  if (transport === undefined) throw new Error("no runtime is hosting Durable Objects here yet")

  return transport
}

/** What a method's exit crosses as (actor.ts encodes it, `decode` reads it). */
export type Envelope =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: string }
  | { readonly ok: false; readonly defect: { readonly message: string; readonly stack?: string } }

const decode = (envelope: Envelope) => {
  if (envelope.ok) return Effect.succeed(fromWire(envelope.json))

  if ("defect" in envelope) {
    const error = new Error(envelope.defect.message)

    if (envelope.defect.stack !== undefined) error.stack = envelope.defect.stack

    return Effect.die(error)
  }

  return Effect.fail(fromWire(envelope.error))
}

const callOf = (cls: string, name: string, method: string, args: ReadonlyArray<unknown>) =>
  Effect.flatMap(currentWire, (parent) =>
    Effect.tryPromise({
      try: async (): Promise<Envelope> => {
        // SAFETY: the actor's `call` answers an Envelope (actor.ts).
        return (await reached().call(cls, name, method, toWire(args), parent)) as Envelope
      },
      catch: (cause) => new RpcCallError({ method, cause }),
    }),
  ).pipe(
    // An object that can't be reached is a defect, not a failure a caller handles.
    Effect.orDie,
    Effect.flatMap(decode),
  )

const DENIED = new Set(["then", "asEffect", "pipe", "toJSON", "toString", "valueOf", "constructor"])

const stubOf = <Members extends ObjectMembers>(cls: string, name: string): Stub<Members> =>
  // SAFETY: members are made on demand from the property name; the Stub type is what the object's impl returned.
  new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string" || DENIED.has(property)) return undefined

        if (property === "fetch") {
          return (request: HttpServerRequest.HttpServerRequest) =>
            HttpServerRequest.toWeb(request).pipe(
              Effect.map((web) =>
                sameHeaders(web.headers, request.headers)
                  ? web
                  : new Request(web, { headers: request.headers }),
              ),
              Effect.flatMap((web) =>
                Effect.map(currentWire, (parent) => {
                  if (parent !== undefined) web.headers.set(SPAN_HEADER, parent)

                  return web
                }),
              ),
              Effect.flatMap((web) =>
                Effect.tryPromise({
                  try: () => reached().fetch(cls, name, web),
                  catch: (cause) => new RpcCallError({ method: "fetch", cause }),
                }),
              ),
              Effect.orDie,
              // The object's answer arrives whole (actor.ts responseOf): kept as bytes, not a stream, so serve.ts can compress it.
              Effect.flatMap((response) =>
                Effect.promise(async () => {
                  const answer = HttpServerResponse.fromWeb(response)

                  if (response.body === null) return answer

                  const bytes = new Uint8Array(await response.arrayBuffer())

                  return HttpServerResponse.setBody(
                    answer,
                    HttpBody.uint8Array(bytes, response.headers.get("content-type") ?? undefined),
                  )
                }),
              ),
            )
        }

        return (...args: Array<unknown>) => callOf(cls, name, property, args)
      },
    },
  ) as Stub<Members>

/** Whether a web request's headers and an Effect request's (modified, perhaps) carry the same entries. */
const sameHeaders = (web: Headers, effect: Readonly<Record<string, string>>): boolean => {
  const keys = Object.keys(effect)

  let count = 0

  for (const _ of web.keys()) count++

  return count === keys.length && keys.every((key) => web.get(key) === effect[key])
}

/** A namespace for objects of one class by name, for code that can't import the class (a cycle). */
export const namespaceOf = <Members extends ObjectMembers, Key extends string = string>(
  cls: string,
): Namespace<Members, Key> => ({
  name: cls,
  getByName: (name) => stubOf<Members>(cls, name),
})

/** Declare a Durable Object class. `impl`'s outer Effect runs when an object starts, its inner Effect once its state is ready. */
export const DurableObject = <Members extends ObjectMembers>(
  name: string,
  impl: ObjectImpl<Members>,
): ObjectClass<Members> => {
  // SAFETY: the registry holds shapes by name; the actor treats every one as an ObjectMembers.
  declared.set(name, impl)

  // SAFETY: a class made an Effect: its constructor never runs (`new (_: never)`).
  return Object.assign(
    class {},
    Effectable.Prototype({
      label: `openbelt/DurableObject/${name}`,
      evaluate: () => Effect.succeed(namespaceOf<Members>(name)),
    }),
    // SAFETY: a class made an Effect: its constructor never runs (`new (_: never)`).
  ) as unknown as ObjectClass<Members>
}
