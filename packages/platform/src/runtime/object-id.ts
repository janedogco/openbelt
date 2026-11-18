export const objectHash = (text: string) => {
  let h = 0x811c9dc5

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }

  return h >>> 0
}

export const objectFileId = (cls: string, name: string) =>
  `${cls}-${name.replace(/[^\w.-]/g, "_").slice(0, 48)}-${objectHash(`${cls}/${name}`).toString(16).padStart(8, "0")}`
