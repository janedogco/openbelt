// Values as text. A call's arguments and answer cross to an actor as one JSON string each: a structured codec would turn a key like
// `__proto__` into a prototype on the other side, and JSON.parse keeps it a key (which the input contracts refuse, as they should).
// Bytes are tagged; `undefined` (a method that returns nothing) is the empty string, and an undefined argument is tagged too (JSON
// would make it `null`, and `null` is not "left out").
//
// A tag is an object with one key, `bytes64` (a string) or `missing` (true). The values crossing are the user's too (a function's
// result, a document), and one of theirs shaped like a tag came out as bytes or as nothing: `{ missing: [4, 5] }` returned by a
// function was `undefined` on the other side. So a user's object whose key could be read as a tag's, or starts with ESCAPE, has
// those keys sent with ESCAPE in front, and the reading side takes one ESCAPE off.
const bytesTag = "bytes64"

const missingTag = "missing"

const ESCAPE = "\u0000"

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Uint8Array) &&
  !(v instanceof ArrayBuffer)

const collides = (key: string) => key === bytesTag || key === missingTag || key.startsWith(ESCAPE)

const escaped = (v: Record<string, unknown>) =>
  Object.keys(v).some(collides)
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [collides(k) ? ESCAPE + k : k, x]))
    : v

export const toWire = (value: unknown): string =>
  value === undefined
    ? ""
    : JSON.stringify(value, function replacer(this: unknown, _key: string, v: unknown) {
        if (v === undefined && Array.isArray(this)) return { [missingTag]: true }

        if (v instanceof Uint8Array || v instanceof ArrayBuffer)
          return {
            [bytesTag]: Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v).toString(
              "base64",
            ),
          }

        return plain(v) ? escaped(v) : v
      })

const only = (v: Record<string, unknown>, key: string) => {
  const keys = Object.keys(v)

  return keys.length === 1 && keys[0] === key
}

const unescaped = (v: Record<string, unknown>) =>
  Object.keys(v).some((k) => k.startsWith(ESCAPE))
    ? Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k.startsWith(ESCAPE) ? k.slice(1) : k, x]),
      )
    : v

export const fromWire = (text: string): unknown =>
  text === ""
    ? undefined
    : JSON.parse(text, (_key, v: unknown) => {
        if (!plain(v)) return v

        if (only(v, bytesTag) && typeof v[bytesTag] === "string")
          return new Uint8Array(Buffer.from(v[bytesTag], "base64"))

        if (only(v, missingTag) && v[missingTag] === true) return undefined

        return unescaped(v)
      })
