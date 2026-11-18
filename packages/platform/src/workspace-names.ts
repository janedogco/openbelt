// The workspace directory as each process holds it (ApexDO keeps it, apex.ts): which workspace a host's name is for (its id, what its objects
// are keyed by) and that workspace's current name (what its addresses say). Only renamed workspaces are in it, so it stays small: the whole of
// it is held here, and a name not in it is a workspace never renamed, whose id is its name. A host's name is looked up here with no
// call, made-up ones too; once DIRECTORY_FRESH_MS have passed, the next request asks ApexDO whether the directory changed (one
// call, "same" when it didn't), so a rename reaches the other processes within DIRECTORY_FRESH_MS. The process that renamed reads
// it again at once (`reread`). A name no workspace has (no file, not in the copy) may be one another process just gave a workspace, so it is
// checked against ApexDO first (`unknown`): before a workspace is made under it (tailscale sign-in makes one on a first visit), always;
// before a made-up host is told there's no such workspace (email sign-in), once per MISS_FRESH_MS at most, however many names.
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type Workspace, WorkspaceId, WorkspaceName } from "./model.ts"

/** How long a process serves from its copy of the directory before checking it is current: how late a rename can reach it. */
const DIRECTORY_FRESH_MS = 2000

/** How often, at most, a host's name no workspace has makes a process read the directory again (email sign-in: strangers' made-up hosts). */
export const MISS_FRESH_MS = 250

const Answer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("same") }),
  Schema.Struct({
    kind: Schema.Literal("changed"),
    version: Schema.Number,
    names: Schema.Array(Schema.Struct({ name: WorkspaceName, workspace: WorkspaceId })),
    current: Schema.Array(Schema.Struct({ workspace: WorkspaceId, name: WorkspaceName })),
  }),
])

const decodeAnswer = Schema.decodeUnknownEffect(Answer)

const decodeId = Schema.decodeSync(WorkspaceId)

/** The id of a workspace made now under `name`, or of one never renamed: its name. */
export const idOfNewWorkspace = (name: WorkspaceName): WorkspaceId => decodeId(name)

type Held = {
  readonly version: number
  readonly byName: ReadonlyMap<string, WorkspaceId>
  readonly current: ReadonlyMap<string, WorkspaceName>
}

const EMPTY: Held = { version: -1, byName: new Map(), current: new Map() }

const workspaceOf = (directory: Held, name: WorkspaceName): Workspace => {
  const id = directory.byName.get(name)

  return id === undefined
    ? { id: idOfNewWorkspace(name), name }
    : { id, name: directory.current.get(id) ?? name }
}

export const openWorkspaceNames = Effect.fnUntraced(function* (
  read: (known: number) => Effect.Effect<unknown>,
) {
  let held = EMPTY
  let readAt = 0

  const check = Effect.gen(function* () {
    const answer = yield* decodeAnswer(yield* read(held.version)).pipe(Effect.orDie)

    readAt = Date.now()

    if (answer.kind === "changed")
      held = {
        version: answer.version,
        byName: new Map(answer.names.map((n) => [n.name, n.workspace])),
        current: new Map(answer.current.map((c) => [c.workspace, c.name])),
      }

    return held
  }).pipe(
    // ApexDO out of reach: a process that has read the directory goes on with it; one that never has can't tell an old name
    // from a new workspace, so the request fails.
    Effect.catchCause((cause) =>
      held.version < 0
        ? Effect.failCause(cause)
        : Effect.logWarning(
            "workspace directory: ApexDO didn't answer; serving the copy held",
            cause,
          ).pipe(Effect.as(held)),
    ),
  )

  const [current, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    check,
    Duration.millis(DIRECTORY_FRESH_MS),
  )

  return {
    /**
     * The workspace a name is for: its id and current name. An old name gives the workspace it was, under its new one; an id is a name its
     * workspace had, so a token's `<workspace>~` finds it too.
     */
    named: Effect.fnUntraced(function* (name: WorkspaceName) {
      return workspaceOf(yield* current, name)
    }),

    /** Read the directory again now: after this process renamed a workspace, so its next request already knows. */
    reread: Effect.fnUntraced(function* () {
      yield* invalidate
      yield* current
    }),

    /** A name no workspace has here: asked again of the directory, unless it was read within `withinMs` (0: always). */
    unknown: Effect.fnUntraced(function* (name: WorkspaceName, withinMs: number) {
      if (Date.now() - readAt >= withinMs) yield* invalidate

      return workspaceOf(yield* current, name)
    }),
  }
})
