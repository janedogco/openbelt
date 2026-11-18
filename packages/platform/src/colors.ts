// The colour a name gives something that has none of its own: an app (its gallery card, its link preview card) or a connection
// with no logo (its mark). Twelve hues 30° apart, so two names land on colours people can tell apart; any hue on the wheel put six of
// ten seeded apps in one purple. The same name is the same colour everywhere.

/** One of twelve hues (in degrees) for `name`, from an FNV-1a hash of it. */
export const hueOf = (name: string) => {
  let hash = 2166136261

  for (const ch of name) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0

  return (hash % 12) * 30 + 8
}

/** `name`'s colour as CSS, at the saturation and lightness the link preview card draws it with. */
export const colorOfName = (name: string) => `hsl(${hueOf(name)} 62% 52%)`
