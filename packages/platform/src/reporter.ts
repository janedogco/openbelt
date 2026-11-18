import { createHash } from "node:crypto"
import type { Theme } from "./model.ts"
import { TIMING_JS } from "./timing.ts"

export type Inserted = { readonly line: number; readonly column: number; readonly length: number }

export const INSERTED_HEADER = "x-openbelt-reporter"

const LOCATION = /(https?:\/\/[^\s()]+?):(\d+):(\d+)/g

const REPORTER_JS = String.raw`(cfg) => {
  if (window.__openbelt) return;
  const parts = location.pathname.split("/");
  const base = parts[1] === "_preview" && parts[2] ? "/_preview/" + parts[2] : "";
  const root = location.origin + base + "/";
  const doc = location.href.split("#")[0];
  const fix = (url, line, col) => url === doc && line === cfg.at[0] && col >= cfg.at[1] + cfg.at[2] ? col - cfg.at[2] : col;
  const short = (url) => {
    const u = url.split(/[?#]/)[0];
    if (!u.startsWith(root)) return u.replace(location.origin, "");
    const file = u.slice(root.length);
    return file === "" || file.endsWith("/") ? file + "index.html" : file;
  };
  const place = (url, line, col) => short(url) + ":" + line + ":" + fix(url, +line, +col);
  const firstAt = (stack) => {
    const m = /(https?:\/\/[^\s()]+?):(\d+):(\d+)/.exec(String(stack || ""));
    return m ? place(m[1], m[2], m[3]) : "";
  };
  const text = (v) => {
    if (v instanceof Error) return v.name + ": " + v.message;
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  };
  const seen = new Set();
  const send = (kind, message, at, trace) => {
    const body = { kind: kind, message: String(message).slice(0, 1000), page: location.pathname + location.search, version: cfg.v };
    if (at) body.at = at;
    if (trace) body.trace = trace;
    const key = kind + " " + body.message + " " + at;
    if (seen.has(key) || seen.size >= 20) return;
    seen.add(key);
    try {
      fetch(base + "/_log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
    } catch (e) {}
  };
  window.__openbelt = { report: (message, trace) => send("sdk", message, "", trace) };
  addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) return send("load", "failed to load " + short(t.src || t.href), "");
    const at = e.filename ? place(e.filename, e.lineno, e.colno) : firstAt(e.error && e.error.stack);
    send("error", e.message || "Uncaught error", at);
  }, true);
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (r && r.openbeltReported) return;
    send("unhandledrejection", "Uncaught (in promise) " + text(r), firstAt(r && r.stack));
  });
  const original = console.error;
  console.error = function (...args) {
    original.apply(console, args);
    if (args.some((a) => a && a.openbeltReported)) return;
    const err = args.find((a) => a instanceof Error);
    const at = firstAt(err ? err.stack : String(new Error().stack).split("\n").slice(2).join("\n"));
    send("console.error", "console.error: " + args.map(text).join(" "), at);
  };
}`
  .split("\n")
  .map((line) => line.trim())
  .join(" ")

/**
 * Every app page a browser opens: a double tap doesn't zoom (a pinch still does), at zero specificity so the app's own CSS
 * (`touch-action: none` on a canvas, `auto` on html to opt out) wins.
 */
const PAGE_STYLE = `<style>/* OpenBelt: no double-tap zoom; not in your files */:where(html){touch-action:manipulation}</style>`

/**
 * In the workspace's frame (<workspace>/<app>/<path>), a page tells the frame where it is and its title, so the address bar follows it
 * (paths, query, hash, history) and the tab shows its title; only the workspace's own origin is sent it. A link to the workspace or
 * another app opens in the whole window, never inside this app's frame.
 */
const FRAME_JS = String.raw`() => {
  if (window.parent === window) return;
  const workspace = location.host.replace(/^[^.]*?--/, "");
  let sent = "";
  const page = () => {
    const at = location.pathname + location.search + location.hash;
    const title = document.title;
    if (at + "\n" + title === sent) return;
    sent = at + "\n" + title;
    parent.postMessage({ openbelt: "page", at: at, title: title }, location.protocol + "//" + workspace);
  };
  for (const k of ["pushState", "replaceState"]) {
    const original = history[k];
    history[k] = function (...args) { const r = original.apply(this, args); page(); return r; };
  }
  addEventListener("popstate", page);
  addEventListener("hashchange", page);
  addEventListener("pageshow", () => { sent = ""; page(); });
  new MutationObserver(page).observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
  page();
  addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (a === null || (a.target !== "" && a.target !== "_self")) return;
    const to = new URL(a.href, location.href);
    if (to.host === workspace || (to.host !== location.host && to.host.endsWith("--" + workspace))) a.target = "_top";
  }, true);
}`
  .split("\n")
  .map((line) => line.trim())
  .join(" ")

/**
 * The person's OpenBelt theme on the page's root before it paints: data-theme="light" or "dark", unless the page set its own data-theme
 * (then it's the page's), kept in step while "system" follows the device. The SDK's `theme` reads it (window.__openbeltTheme) and hears
 * its changes (openbelt:theme).
 */
const THEME_JS = String.raw`(chosen) => {
  const device = matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;
  const of = () => (chosen === "light" || chosen === "dark" ? chosen : device.matches ? "dark" : "light");
  let theme = of();
  let shown = root.hasAttribute("data-theme") ? null : theme;
  if (shown !== null) root.dataset.theme = shown;
  window.__openbeltTheme = () => theme;
  device.addEventListener("change", () => {
    if (of() === theme) return;
    theme = of();
    if (shown !== null && root.dataset.theme === shown) root.dataset.theme = shown = theme;
    dispatchEvent(new CustomEvent("openbelt:theme", { detail: theme }));
  });
}`
  .split("\n")
  .map((line) => line.trim())
  .join(" ")

/**
 * A route with no file of its own gets the nearest index.html above it (app.ts routed), whose relative links then need a <base>. With
 * one, a link within the page ("#notes", "#") would go to the base's page: it stays on this one, as it would without a <base>.
 */
const ROUTE_JS = String.raw`() => {
  addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    const href = a === null ? null : a.getAttribute("href");
    if (href === null || !href.startsWith("#") || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (a.target !== "" && a.target !== "_self")) return;
    e.preventDefault();
    location.hash = href;
  });
}`
  .split("\n")
  .map((line) => line.trim())
  .join(" ")

/** The browser fetches /sdk.js beside the page's own scripts, not only once one of them imports it: a round trip less. */
const SDK_PRELOAD = `<link rel="modulepreload" href="/sdk.js">`

/** How a page is served: the person's theme, and for a route served its folder's index.html, the <base> its relative links need. */
export type PageServed = { readonly theme: Theme; readonly base: string | null }

const baseTag = (base: string | null) =>
  base === null ? "" : `<base href="${base}"><script>(${ROUTE_JS})()</script>`

const tagFor = (
  version: string,
  served: PageServed,
  line: number,
  column: number,
  length: number,
) =>
  `${baseTag(served.base)}${SDK_PRELOAD}<script>/* OpenBelt: reports this page's errors to app_logs and how long it took to load, shows the person's theme, and keeps the frame's address and title in step; not in your files */(${REPORTER_JS})(${JSON.stringify({ v: version, at: [line, column, length] })});(${THEME_JS})(${JSON.stringify(served.theme)});(${FRAME_JS})();(${TIMING_JS})()</script>${PAGE_STYLE}`

/** Where OpenBelt's tags go: first in <head>, else after the doctype, else first. */
const headEnd = (html: string) => {
  const head = /<head(?:\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html)

  return head === null ? 0 : head.index + head[0].length
}

/** A page's own <base> wins: a route's isn't added to one that has it. */
const servedTo = (html: string, served: PageServed): PageServed =>
  served.base !== null && /<base[\s>]/i.test(html) ? { ...served, base: null } : served

/** A page opened on the public host: the page style and the device's theme, no reporter (the public host takes no /_log) and no frame. */
export const withPageStyle = (html: string, base: string | null) => {
  const index = headEnd(html)
  const served = servedTo(html, { theme: "system", base })

  return `${html.slice(0, index)}${baseTag(served.base)}${SDK_PRELOAD}<script>(${THEME_JS})("system")</script>${PAGE_STYLE}${html.slice(index)}`
}

/** What OpenBelt adds to a page, as a tag for its ETag: a browser holding the page from before a change to them gets the new tags, not a 304. */
export const PAGE_TAGS_VERSION = createHash("sha256")
  .update(
    [SDK_PRELOAD, PAGE_STYLE, REPORTER_JS, THEME_JS, ROUTE_JS, FRAME_JS, TIMING_JS].join("\n"),
  )
  .digest("hex")
  .slice(0, 12)

/** A page a person opens on the workspace host (in its frame, or a check_app or screenshot tab): the reporter, the theme, the frame script and the page style, and where they went (to fix error columns). */
export const withReporter = (html: string, version: string, asked: PageServed) => {
  const index = headEnd(html)
  const before = html.slice(0, index)
  const line = before.split("\n").length
  const column = index - before.lastIndexOf("\n")
  const served = servedTo(html, asked)
  let tag = tagFor(version, served, line, column, 0)

  for (let i = 0; i < 3 && !tag.includes(`,${tag.length}]`); i += 1) {
    tag = tagFor(version, served, line, column, tag.length)
  }

  return {
    html: before + tag + html.slice(index),
    inserted: { line, column, length: tag.length } satisfies Inserted,
  }
}

export const insertedOf = (header: string | undefined): Inserted | undefined => {
  const match = /^(\d+):(\d+):(\d+)$/.exec(header ?? "")

  return match === null
    ? undefined
    : { line: Number(match[1]), column: Number(match[2]), length: Number(match[3]) }
}

export const appLocations = (text: string, root: string, pages: ReadonlyMap<string, Inserted>) =>
  text.replaceAll(LOCATION, (_, url: string, line: string, column: string) => {
    const at = pages.get(url)
    const col = Number(column)

    const fixed =
      at !== undefined && Number(line) === at.line && col >= at.column + at.length
        ? col - at.length
        : col

    const path = url.split(/[?#]/)[0] ?? url

    if (!path.startsWith(root)) return `${path.replace(new URL(root).origin, "")}:${line}:${fixed}`

    const file = path.slice(root.length)

    return `${file === "" || file.endsWith("/") ? `${file}index.html` : file}:${line}:${fixed}`
  })
