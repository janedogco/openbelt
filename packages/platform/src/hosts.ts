/**
 * An app's host is one label beside its workspace's: `<app>--<workspace>.<host>`, so one `*.<host>` wildcard certificate covers every
 * workspace and every app (a certificate per app, or per workspace, runs into Let's Encrypt's limit of 50 a week per domain). Neither an
 * app's name nor a workspace's holds "--", so the label splits one way only.
 */
export const APP_SEPARATOR = "--"

/** A DNS label holds at most 63 characters, and an app's host puts its name and its workspace's in one. */
export const MAX_LABEL = 63

/** Where the one label under the base host points: `<workspace>`, or `<app>--<workspace>`. A name two labels deep is nobody's. */
export type Place =
  | { readonly kind: "workspace"; readonly workspace: string }
  | { readonly kind: "app"; readonly workspace: string; readonly app: string }

export const placeOf = (label: string): Place | undefined => {
  if (label.includes(".")) return undefined

  const split = label.indexOf(APP_SEPARATOR)

  return split === -1
    ? { kind: "workspace", workspace: label }
    : {
        kind: "app",
        workspace: label.slice(split + APP_SEPARATOR.length),
        app: label.slice(0, split),
      }
}

/** A workspace's name can't hold "--", so `<app>--<workspace>` never reads as a workspace's. */
export const isWorkspaceLabel = (workspace: string) => !workspace.includes(APP_SEPARATOR)

/** Why `app` can't have a host in `workspace` (its label would pass 63 characters), or undefined. */
export const hostProblem = (app: string, workspace: string) => {
  const label = `${app}${APP_SEPARATOR}${workspace}`

  return label.length <= MAX_LABEL
    ? undefined
    : `"${app}" is too long for an app in ${workspace}: its address starts with "${label}", ${label.length} characters, and a DNS label holds ${MAX_LABEL}. Use an app name of at most ${MAX_LABEL - APP_SEPARATOR.length - workspace.length} characters`
}

export const appOrigin = (workspaceOrigin: string, app: string) => {
  const url = new URL(workspaceOrigin)

  url.hostname = `${app}${APP_SEPARATOR}${url.hostname}`

  return url.origin
}

/** The app whose host `host` is (`<app>--<workspace>...`), in the workspace at `workspaceHost` (both with their ports). */
export const appOfHost = (host: string, workspaceHost: string) => {
  if (!host.endsWith(`${APP_SEPARATOR}${workspaceHost}`)) return undefined

  const app = host.slice(0, -workspaceHost.length - APP_SEPARATOR.length)

  return app === "" || app.includes(".") || app.includes(APP_SEPARATOR) ? undefined : app
}

/** The workspace's origin of an app's (`<app>--<workspace>...`); a workspace's own origin is itself. */
export const workspaceOfApp = (app: URL) => {
  const split = app.host.indexOf(APP_SEPARATOR)
  const dot = app.host.indexOf(".")

  return split === -1 || (dot !== -1 && split > dot)
    ? new URL(app.origin)
    : new URL(`${app.protocol}//${app.host.slice(split + APP_SEPARATOR.length)}`)
}

/** Whether `url` is the workspace at `root` (a workspace's origin) or one of its apps. */
export const inWorkspace = (url: URL, root: URL) =>
  url.protocol === root.protocol &&
  (url.host === root.host || appOfHost(url.host, root.host) !== undefined)

/** A path a person opens as a page: a folder, an .html file, or a route with no extension (a file of any other kind isn't framed). */
export const isPagePath = (path: string) => {
  const last = path.slice(path.lastIndexOf("/") + 1)

  return last === "" || last.endsWith(".html") || !last.includes(".")
}

/** Where people open an app: its page in the workspace's frame, `<workspace>.<domain>/<app>`. */
export const frameUrl = (workspaceOrigin: string, app: string) =>
  `${new URL(workspaceOrigin).origin}/${app}`

export const appUrl = (workspaceOrigin: string, app: string, env?: string) =>
  `${appOrigin(workspaceOrigin, app)}/${env === undefined ? "" : `_preview/${env}/`}`
