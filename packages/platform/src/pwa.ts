import { INSTALL_SCRIPT } from "./install.ts"
import { TIMING_JS } from "./timing.ts"
import { TOAST_CSS } from "./toast.ts"
import tileSvg from "../../../brand/logo/tile-dark.svg" with { type: "text" }
import wordmarkSvg from "../../../brand/logo/openbelt.svg" with { type: "text" }
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

const root = new URL("./", import.meta.url)

const hash = createHash("sha256")

for (const name of readdirSync(root)
  .filter((entry) => entry.endsWith(".ts"))
  .toSorted()) {
  hash.update(name).update(readFileSync(new URL(name, root)))
}

for (const name of ["tokens", "base", "components"]) {
  hash.update(readFileSync(new URL(`../../../brand/css/${name}.css`, import.meta.url)))
}

const VERSION = hash.digest("hex").slice(0, 20)

// iOS takes the full square apple-touch-icon and rounds it itself; Android masks the maskable one.
const icons = new Map(
  ["icon-192", "icon-512", "icon-maskable-512", "apple-touch-icon"].map((name) => [
    `/_pwa/${name}.png`,
    new Uint8Array(readFileSync(new URL(`../../../brand/logo/png/${name}.png`, import.meta.url))),
  ]),
)

export const PWA_HEAD = `<link rel="manifest" href="/_pwa/manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="/_pwa/apple-touch-icon.png">
<meta name="openbelt-version" content="${VERSION}">
<script defer src="/_pwa/client.js"></script>`

/** Lucide icons for toasts (brand/css/components.css "toast"). */
const lucide = (paths: string) =>
  `<svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`

const BELL = lucide(
  '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
)

/** The update notice's icon for each of its messages. */
const NOTICE_ICONS = {
  update: lucide('<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/><path d="M12 16V8"/>'),
  editing: lucide(
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  ),
  failed: lucide('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
  offline: lucide(
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  ),
  done: lucide('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
}

/**
 * Notifications, one app at a time (push.ts). `window.openbeltNotify` says where the viewer stands with an app's notifications on this
 * device and answers for them; turning one on asks the browser's permission and subscribes this device first (GET /_push for the
 * workspace's key, POST /_push). In an app's frame, an app that tried to notify the viewer (state "asked") gets a toast: Allow or Not now.
 * Where a browser can't take a push (Safari on an iPhone before the workspace is on the Home Screen), none of it shows.
 */
const NOTIFY_SCRIPT = `(() => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  const send = (method, path, body) => fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async response => { const answer = await response.json(); if (!response.ok) throw Error(answer.error || 'refused'); return answer; });
  const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
  const subscription = async () => { const registration = await navigator.serviceWorker.getRegistration('/'); return registration ? registration.pushManager.getSubscription() : null; };
  const deviceOn = async () => { if (Notification.permission !== 'granted') return false; const current = await subscription(); return current !== null && (await send('POST', '/_push/status', current)).on; };
  const turnOnDevice = async () => {
    if ((await Notification.requestPermission()) !== 'granted') return false;
    const registration = await navigator.serviceWorker.register('/_pwa/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready);
    const { key } = await send('GET', '/_push');
    let current = await registration.pushManager.getSubscription();
    if (current && current.options.applicationServerKey && b64(current.options.applicationServerKey) !== key) { await current.unsubscribe(); current = null; }
    current ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) });
    return (await send('POST', '/_push', current)).on;
  };
  const state = async app => {
    const { state } = await send('GET', '/_push/apps/' + encodeURIComponent(app));
    return { state, on: state === 'on' && (await deviceOn()), blocked: Notification.permission === 'denied' };
  };
  const answer = async (app, on) => {
    if (on && !(await turnOnDevice())) return state(app);
    await send('POST', '/_push/apps/' + encodeURIComponent(app), { on });
    const now = await state(app);
    dispatchEvent(new CustomEvent('openbelt:notify', { detail: now }));
    return now;
  };
  window.openbeltNotify = { state, answer };
  const frame = document.querySelector('main.stage > .frame');
  const app = decodeURIComponent(location.pathname.split('/')[1] || '');
  if (!frame || app === '') return;
  state(app).then(now => {
    if (now.state !== 'asked' || now.blocked) return;
    const ask = document.createElement('aside');
    ask.className = 'toast notify-ask'; ask.setAttribute('role', 'dialog'); ask.setAttribute('aria-labelledby', 'notify-ask-title');
    ask.innerHTML = ${JSON.stringify(BELL)} + '<h2 class="toast-title" id="notify-ask-title">Get notifications from this app?</h2><div class="toast-actions"><button type="button" class="btn btn-primary allow">Allow</button><button type="button" class="btn btn-ghost later">Not now</button></div>';
    document.body.append(ask);
    const title = ask.querySelector('.toast-title');
    const pick = async (button, on) => {
      ask.querySelectorAll('button').forEach(b => { b.disabled = true; });
      button.setAttribute('aria-busy', 'true');
      try {
        const now = await answer(app, on);
        if (!on || now.on) { ask.remove(); return; }
        title.textContent = now.blocked ? 'Notifications are blocked in the browser settings' : 'Could not turn on notifications. Try again';
      } catch { title.textContent = 'Could not save. Try again'; }
      button.removeAttribute('aria-busy');
      ask.querySelectorAll('button').forEach(b => { b.disabled = false; });
    };
    ask.querySelector('.allow').addEventListener('click', event => pick(event.currentTarget, true));
    ask.querySelector('.later').addEventListener('click', event => pick(event.currentTarget, false));
  }).catch(() => {});
})();`

/** The toast component, for the app frame: the workspace's own pages load it with components.css, and an injected copy is the same rules. */
const TOAST_STYLE = `(() => {
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(TOAST_CSS)};
  document.head.append(style);
})();`

const SCRIPT =
  TOAST_STYLE +
  INSTALL_SCRIPT.replace("__OPENBELT_WORDMARK__", JSON.stringify(wordmarkSvg)).replace(
    "__OPENBELT_TILE__",
    JSON.stringify(tileSvg.trim()),
  ) +
  `(${TIMING_JS})();` +
  `(() => {
  const mode = matchMedia('(display-mode: standalone)');
  if (!mode.matches && navigator.standalone !== true) return;
  const current = document.querySelector('meta[name="openbelt-version"]').content;
  const menu = document.getElementById('you-menu');
  const side = document.querySelector('#side');
  if (!menu && !side) return;
  const style = document.createElement('style');
  style.textContent = \`
    .pwa-refresh { font: inherit; cursor: pointer; }
    .side > .pwa-refresh { display: flex; align-items: center; gap: 8px; margin: auto 8px 16px; padding: 10px; border: 0; border-radius: var(--openbelt-radius-sm); background: transparent; color: var(--openbelt-color-muted); font-size: 13px; }
    .side > .pwa-refresh:hover { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
    .pwa-refresh svg { width: 16px; height: 16px; flex: none; }
    .pwa-refresh:focus-visible { outline: 2px solid var(--openbelt-color-primary); outline-offset: 3px; }
  \`;
  document.head.append(style);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = menu ? 'menu-item pwa-refresh' : 'pwa-refresh';
  refresh.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5"/></svg><span>Refresh app</span>';
  if (menu) { refresh.setAttribute('role', 'menuitem'); menu.prepend(refresh); }
  else side.append(refresh);
  const notice = document.createElement('aside');
  notice.className = 'toast toast-status pwa-notice'; notice.hidden = true; notice.setAttribute('role', 'status');
  const icons = ${JSON.stringify(NOTICE_ICONS)};
  const label = document.createElement('span'); label.className = 'toast-title';
  const actions = document.createElement('div'); actions.className = 'toast-actions';
  const action = document.createElement('button'); action.type = 'button'; action.className = 'btn btn-primary'; action.textContent = 'Refresh';
  actions.append(action); notice.append(label, actions); document.body.append(notice);
  let checking = null, lastCheck = 0, refreshing = false, changed = false;
  const show = (icon, text, retry = true) => { notice.querySelector('.toast-icon')?.remove(); notice.insertAdjacentHTML('afterbegin', icons[icon]); label.textContent = text; action.hidden = !retry; notice.hidden = false; };
  const dirty = new Set();
  const inset = document.querySelector('.inset');
  document.addEventListener('input', event => {
    if (event.target.matches('input:not([type="search"]), textarea, select, [contenteditable="true"]')) dirty.add(event.target);
  });
  const busy = () => [...dirty].some(element => element.isConnected) || document.querySelector('dialog[open]');
  async function check(force = false) {
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 30000) return null;
    lastCheck = Date.now();
    checking = (async () => {
      if (!navigator.onLine) throw Error('offline');
      const response = await fetch('/_pwa/version', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
      const version = await response.text();
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/plain') || !/^[a-f0-9]{20}$/.test(version)) throw Error('version unavailable');
      changed = version !== current;
      if (changed) show('update', 'Update available');
      return version;
    })();
    try { return await checking; } finally { checking = null; }
  }
  async function reload() {
    if (refreshing) return;
    if (busy()) { show('editing', 'Save your work, then reopen this page to refresh.', false); return; }
    refreshing = true; refresh.disabled = action.disabled = true; action.setAttribute('aria-busy', 'true');
    try {
      const version = await check(true);
      if (busy()) { show('editing', 'Finish editing before refreshing.', false); return; }
      try {
        sessionStorage.setItem('openbelt-pwa-refresh', JSON.stringify({ path: location.pathname + location.search + location.hash, scroll: scrollY, insetScroll: inset?.scrollTop ?? 0, version }));
      } catch {}
      location.reload();
    } catch { if (navigator.onLine) show('failed', 'Could not refresh. Try again.'); else show('offline', 'You are offline. Reconnect to refresh.'); }
    finally { refreshing = false; refresh.disabled = action.disabled = false; action.removeAttribute('aria-busy'); }
  }
  refresh.addEventListener('click', reload); action.addEventListener('click', reload);
  try {
    const saved = JSON.parse(sessionStorage.getItem('openbelt-pwa-refresh'));
    sessionStorage.removeItem('openbelt-pwa-refresh');
    if (saved && saved.path === location.pathname + location.search + location.hash && typeof saved.scroll === 'number' && saved.version === current) {
      requestAnimationFrame(() => {
        scrollTo(0, saved.scroll);
        if (inset && Number.isFinite(saved.insetScroll)) inset.scrollTop = saved.insetScroll;
      });
      show('done', 'Up to date', false);
      setTimeout(() => { if (!changed) notice.hidden = true; }, 4000);
    }
  } catch {}
  const quiet = () => { if (!document.hidden) check().catch(() => {}); };
  document.addEventListener('visibilitychange', quiet);
  addEventListener('pageshow', quiet); addEventListener('online', quiet);
  setInterval(quiet, 300000); quiet();
})();` +
  NOTIFY_SCRIPT

/** The worker that shows a push (push.ts) and opens its page on a tap. No fetch handler: pages load as they did without it. */
const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let sent = {};
  try { sent = event.data ? event.data.json() : {}; } catch {}
  const shown = sent.notification || {};
  const navigate = typeof shown.navigate === 'string' && new URL(shown.navigate, location.origin).origin === location.origin ? shown.navigate : '/';
  event.waitUntil(self.registration.showNotification(shown.title || 'OpenBelt', { body: shown.body || '', icon: '/_pwa/icon-192.png', data: { navigate } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.navigate || '/', location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = open.find(client => new URL(client.url).origin === location.origin);
    if (page) {
      await page.focus();
      if (page.url !== url) await page.navigate(url).catch(() => self.clients.openWindow(url));
      return;
    }
    await self.clients.openWindow(url);
  })());
});`

export const pwaResponse = (path: string) => {
  const headers = { "cache-control": "private, no-store" }

  if (path === "/_pwa/version") return HttpServerResponse.text(VERSION, { headers })

  if (path === "/_pwa/sw.js")
    return HttpServerResponse.text(SERVICE_WORKER, {
      contentType: "text/javascript; charset=utf-8",
      headers: { ...headers, "service-worker-allowed": "/" },
    })

  if (path === "/_pwa/client.js")
    return HttpServerResponse.text(SCRIPT, {
      contentType: "text/javascript; charset=utf-8",
      headers,
    })

  if (path === "/_pwa/manifest.webmanifest")
    return HttpServerResponse.text(
      JSON.stringify({
        id: "/",
        name: "OpenBelt",
        short_name: "OpenBelt",
        start_url: "/",
        scope: "/",
        display: "standalone",
        icons: [
          ...[192, 512].map((size) => ({
            src: `/_pwa/icon-${size}.png`,
            sizes: `${size}x${size}`,
            type: "image/png",
            purpose: "any",
          })),
          {
            src: "/_pwa/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      }),
      { contentType: "application/manifest+json", headers },
    )
  const icon = icons.get(path)

  return icon === undefined
    ? null
    : HttpServerResponse.uint8Array(icon, { contentType: "image/png", headers })
}
