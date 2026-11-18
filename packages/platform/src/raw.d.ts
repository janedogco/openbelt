// Bun inlines `import text from "./file" with { type: "text" }` as a string.
declare module "*.md" {
  const text: string
  export default text
}

declare module "*.css" {
  const text: string
  export default text
}

declare module "*.svg" {
  const text: string
  export default text
}
