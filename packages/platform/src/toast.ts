import componentsCss from "../../../brand/css/components.css" with { type: "text" }

const START = "/* toast: start */"

const END = "/* toast: end */"

const from = componentsCss.indexOf(START)

const to = componentsCss.indexOf(END)

if (from === -1 || to < from)
  throw new Error(
    `toast.ts: brand/css/components.css has no toast section between ${START} and ${END}`,
  )

/** The toast component (brand/css/components.css), for what doesn't load that file: the app frame and the SDK's sheet. */
export const TOAST_CSS = componentsCss.slice(from, to + END.length)
