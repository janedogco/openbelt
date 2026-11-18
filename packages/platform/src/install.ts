export const INSTALL_SCRIPT = `(() => {
  const mode = matchMedia('(display-mode: standalone)');
  const installed = () => mode.matches || navigator.standalone === true;
  if (installed()) return;
  const wordmark = __OPENBELT_WORDMARK__;
  const tile = __OPENBELT_TILE__;
  const menu = document.querySelector('#you-menu');
  const side = document.querySelector('#side');
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const mobile = ios || /Android/.test(navigator.userAgent);
  const read = key => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
  const remember = key => { try { localStorage.setItem(key, '1'); } catch {} };
  if (/^[/][a-z0-9]/.test(location.pathname)) remember('openbelt-install-used');
  if (!menu && !side) return;
  let nativePrompt = null, lastFocus = null, offered = false, step = 0;
  const css = document.createElement('style');
  css.dataset.pwaInstall = '';
  css.textContent = \`
    .pwa-install-trigger { display: flex; align-items: center; gap: 8px; cursor: pointer; font: inherit; }
    .pwa-install-trigger[hidden] { display: none; }
    .pwa-install-trigger svg { width: 16px; height: 16px; flex: none; }
    .side > .pwa-install-trigger { margin: auto 8px 16px; padding: 10px; border: 0; border-radius: var(--openbelt-radius-sm); background: transparent; color: var(--openbelt-color-muted); font-size: 13px; }
    .pwa-install-trigger:hover { background: var(--openbelt-color-subtle); }
    .pwa-install-guide { background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-lg); font: var(--openbelt-type-body-md); }
    .pwa-install-guide { width: min(400px, calc(100% - 32px)); max-height: calc(100dvh - 32px); padding: 24px; overflow: auto; }
    .pwa-install-guide::backdrop { background: color-mix(in srgb, var(--openbelt-color-primary) 35%, transparent); }
    .pwa-install-guide header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 20px; }
    .pwa-install-guide h2 { margin: 0; flex: 1; font: var(--openbelt-type-h5); overflow-wrap: anywhere; }
    .pwa-install-guide button { cursor: pointer; font: var(--openbelt-type-label); padding: 10px 12px; border-radius: var(--openbelt-radius-sm); border: 1px solid var(--openbelt-color-border); background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); }
    .pwa-install-guide button:focus-visible, .pwa-install-trigger:focus-visible { outline: 2px solid var(--openbelt-color-primary); outline-offset: 3px; }
    .pwa-install-guide button:disabled { opacity: .4; cursor: default; }
    .pwa-install-guide .install-close { padding: 0 4px; border: 0; background: transparent; color: var(--openbelt-color-muted); font-size: 24px; line-height: 24px; }
    .pwa-install-guide footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 24px; }
    .pwa-install-guide .install-next { background: var(--openbelt-color-primary); color: var(--openbelt-color-on-primary); border-color: var(--openbelt-color-primary); }
    .install-progress { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); white-space: nowrap; }
    .install-instruction { margin-top: 20px; min-height: 64px; }
    .install-instruction strong { display: block; font-weight: 600; }
    .install-instruction p { margin: 5px 0 0; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
    .install-stage { display: grid; place-items: center; height: 330px; overflow: hidden; border-radius: var(--openbelt-radius-lg); background: var(--openbelt-color-subtle); }
    .install-phone { --ios-bar: #1c1c1e; --ios-pill: #3a3a3cee; --ios-menu: #2c2c2ef2; --ios-menu-ink: #f5f5f5; --ios-menu-line: #ffffff1f; --ios-sheet: #3a3a3c; --ios-dark: #1c1c1e; --ios-field: #2c2c2e; --ios-key: #48484b; --ios-blue: #0a84ff; --ios-green: #30d158; --ios-gray: #8e8e93; position: relative; width: 238px; height: 322px; margin-top: 16px; overflow: hidden; border: 1px solid var(--openbelt-color-border-strong); border-bottom: 0; border-radius: 28px 28px 0 0; background: var(--openbelt-color-surface); color: var(--openbelt-color-primary); box-shadow: 0 8px 24px #00000014; font: 10px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; }
    :root[data-theme="light"] .install-phone { --ios-bar: #f5f5f3; --ios-pill: #ffffffed; --ios-menu: #f9f9f7ee; --ios-menu-ink: #252623; --ios-menu-line: #dddddd; --ios-sheet: #494a49; }
    @media (prefers-color-scheme: light) { :root[data-theme="system"] .install-phone { --ios-bar: #f5f5f3; --ios-pill: #ffffffed; --ios-menu: #f9f9f7ee; --ios-menu-ink: #252623; --ios-menu-line: #dddddd; --ios-sheet: #494a49; } }
    .install-phone svg { width: 14px; height: 14px; flex: none; }
    .guide-status { display: flex; align-items: center; justify-content: space-between; height: 28px; padding: 0 15px; font-size: 8px; }
    .guide-island { width: 70px; height: 12px; border-radius: 20px; background: #111; }
    .guide-page { padding: 8px 12px; }
    .guide-brand { display: flex; align-items: center; height: 22px; margin: 6px 0 14px; color: var(--openbelt-color-primary); }
    .guide-brand svg { width: auto; height: 17px; }
    .guide-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px 10px; }
    .guide-tiles div { text-align: center; font-size: 7px; color: var(--openbelt-color-muted); }
    .guide-tiles i { display: block; aspect-ratio: 1; margin-bottom: 4px; border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-tile-radius); background: var(--openbelt-color-neutral); }
    .guide-toolbar { position: absolute; bottom: 0; left: 0; right: 0; display: flex; align-items: center; gap: 6px; padding: 10px 7px; background: linear-gradient(transparent, var(--ios-bar) 30%); }
    .guide-toolbar > span { display: grid; place-items: center; height: 28px; border-radius: 20px; background: var(--ios-pill); color: var(--ios-menu-ink); box-shadow: 0 1px 5px #0000000a; }
    .guide-toolbar > span:first-child { width: 28px; font-size: 22px; color: var(--ios-gray); }
    .guide-toolbar > .guide-host { display: block; flex: 1; min-width: 0; padding: 0 8px; font-size: 9px; line-height: 28px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .guide-menu-button { position: relative; width: 29px; letter-spacing: 1px; }
    .guide-safari-menu { position: absolute; right: 7px; bottom: 48px; width: 156px; padding: 6px; border-radius: 20px; background: var(--ios-menu); color: var(--ios-menu-ink); backdrop-filter: blur(16px); box-shadow: 0 8px 30px #0003; opacity: 0; transform: translateY(8px) scale(0.94); transform-origin: bottom right; transition: opacity 220ms ease, transform 350ms cubic-bezier(0.22, 0.8, 0.25, 1); }
    .guide-menu-row { position: relative; display: flex; align-items: center; gap: 9px; padding: 7px 6px; font-size: 9px; border-radius: 8px; }
    .guide-menu-row > span { width: 14px; flex-shrink: 0; text-align: center; }
    .guide-menu-divider { margin-top: 5px; padding-top: 12px; border-top: 1px solid var(--ios-menu-line); border-radius: 0; }
    .guide-menu-bottom { display: flex; justify-content: space-around; margin-top: 5px; padding: 8px 0 2px; border-top: 1px solid var(--ios-menu-line); text-align: center; }
    .guide-menu-bottom svg { display: block; margin: auto; }
    .guide-menu-bottom small { display: block; margin-top: 2px; font-size: 6px; }
    .guide-sheet { position: absolute; inset: 52px 5px 5px; padding: 12px 9px 9px; border: 1px solid #ffffff20; border-radius: 24px; background: var(--ios-sheet); color: #fff; box-shadow: 0 -12px 40px #0003; transform: translateY(115%); transition: transform 550ms cubic-bezier(0.22, 0.8, 0.25, 1); }
    .guide-share-head { display: flex; gap: 8px; align-items: center; }
    .guide-app-icon { display: block; width: 32px; height: 32px; border-radius: 8px; object-fit: cover; }
    .guide-share-head strong { font-size: 9px; font-weight: 600; }
    .guide-share-head small { display: block; max-width: 160px; overflow: hidden; white-space: nowrap; color: #bcbcbc; font-size: 7px; }
    .guide-options { display: inline-block; margin-top: 3px; padding: 2px 6px; border: 1px solid #ffffff25; border-radius: 12px; font-size: 7px; }
    .guide-contacts, .guide-apps, .guide-actions { display: flex; justify-content: space-between; gap: 5px; margin-top: 15px; text-align: center; }
    .guide-contacts > div, .guide-apps > div { width: 44px; }
    .guide-contacts i { display: grid; place-items: center; width: 31px; height: 31px; margin: auto; border-radius: 50%; background: #7d91ac; color: #fff; }
    .guide-contacts > div:nth-child(2) i { background: #aa8a75; }
    .guide-contacts > div:nth-child(3) i { background: #858e7d; }
    .guide-contacts > div:nth-child(4) i { background: #8a7da8; }
    .guide-contacts small, .guide-apps small { display: block; margin-top: 3px; font-size: 7px; }
    .guide-apps i { display: grid; place-items: center; width: 32px; height: 32px; margin: auto; border-radius: 8px; background: #168cf7; color: #fff; }
    .guide-apps svg { width: 20px; height: 20px; }
    .guide-apps .guide-app-1 { background: #34c759; }
    .guide-apps .guide-app-3 { background: linear-gradient(#ffd85a 28%, #fff 28%); color: #999; }
    .guide-actions { gap: 3px; margin-top: 14px; }
    .guide-action { position: relative; width: 47px; border-radius: 12px; font-size: 6.5px; line-height: 1.25; }
    .guide-action-circle { display: grid; place-items: center; width: 33px; height: 33px; margin: 0 auto 4px; border-radius: 50%; background: #ffffff21; }
    .guide-action-circle svg { width: 18px; height: 18px; }
    .guide-confirm { position: absolute; inset: 28px 0 0; padding: 10px 8px; border-radius: 22px 22px 0 0; background: var(--ios-dark); color: #f5f5f5; opacity: 0; transform: translateY(32px); pointer-events: none; transition: opacity 300ms ease, transform 500ms cubic-bezier(0.22, 0.8, 0.25, 1); }
    .guide-confirm-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-bottom: 13px; font-size: 8px; }
    .guide-confirm-head > strong { font-size: 9px; font-weight: 600; }
    .guide-cancel { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid #ffffff24; border-radius: 50%; font-size: 15px; }
    .guide-confirm-head > b { position: relative; padding: 6px 10px; border-radius: 20px; background: var(--ios-blue); font-size: 10px; font-weight: 500; }
    .guide-name { display: flex; align-items: center; gap: 8px; padding: 7px; border-radius: 10px; background: var(--ios-field); }
    .guide-name > div { flex: 1; min-width: 0; }
    .guide-name span { display: block; padding-bottom: 7px; border-bottom: 1px solid #ffffff15; }
    .guide-name small { display: block; padding-top: 5px; overflow: hidden; white-space: nowrap; color: #777; font-size: 7px; }
    .guide-caret { display: inline-block; height: 10px; margin-left: 1px; border-left: 1px solid var(--ios-blue); vertical-align: middle; }
    .guide-webapp { display: flex; align-items: center; justify-content: space-between; margin-top: 15px; padding: 7px; border-radius: 10px; background: var(--ios-field); font-size: 9px; }
    .guide-switch { position: relative; width: 29px; height: 17px; border-radius: 20px; background: var(--ios-green); }
    .guide-switch::after { content: ''; position: absolute; top: 2px; right: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; }
    .guide-confirm-note { margin: 5px 0; color: var(--ios-gray); font-size: 7px; line-height: 1.3; }
    .guide-keyboard { position: absolute; left: 0; right: 0; bottom: 0; padding: 7px 3px 10px; background: var(--ios-field); }
    .guide-keyboard > div { display: flex; justify-content: center; gap: 3px; margin-top: 4px; }
    .guide-keyboard i { display: grid; place-items: center; min-width: 18px; height: 23px; border-radius: 4px; background: var(--ios-key); font-size: 12px; font-style: normal; }
    .guide-keyboard .guide-space { width: 125px; font-size: 8px; }
    .guide-keyboard .guide-key-done { width: 33px; background: var(--ios-blue); }
    .install-phone[data-step="1"] .guide-safari-menu { opacity: 1; transform: none; }
    .install-phone[data-step="2"] .guide-sheet, .install-phone[data-step="3"] .guide-sheet { transform: none; }
    .install-phone[data-step="3"] .guide-confirm { opacity: 1; transform: none; pointer-events: auto; }
    .install-phone[data-step="0"] .guide-page, .install-phone[data-step="1"] .guide-page, .install-phone[data-step="2"] .guide-share-head, .install-phone[data-step="2"] .guide-contacts, .install-phone[data-step="2"] .guide-apps, .install-phone[data-step="3"] .guide-name, .install-phone[data-step="3"] .guide-keyboard { opacity: 0.5; }
    .install-phone[data-step="1"] .guide-menu-row:not(.guide-share), .install-phone[data-step="1"] .guide-menu-bottom, .install-phone[data-step="2"] .guide-action:not(.guide-target) { opacity: 0.45; }
    .install-phone[data-step="0"] .guide-menu-button, .install-phone[data-step="1"] .guide-share, .install-phone[data-step="2"] .guide-action.guide-target, .install-phone[data-step="3"] .guide-confirm-head .guide-target { outline: 2px solid var(--ios-blue); outline-offset: 2px; box-shadow: 0 0 0 6px #0a84ff26; }
    .install-phone .guide-target { cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .install-phone .guide-pointer { display: none; position: absolute; left: 50%; bottom: calc(100% + 5px); width: 32px; height: 44px; overflow: visible; pointer-events: none; transform: translateX(-50%); filter: drop-shadow(0 2px 2px #0003); }
    .guide-pointer path { fill: var(--ios-blue); stroke: #fff; stroke-width: 1.5; stroke-linejoin: round; }
    .install-phone[data-step="0"] .guide-menu-button > .guide-pointer, .install-phone[data-step="1"] .guide-share > .guide-pointer, .install-phone[data-step="2"] .guide-action.guide-target > .guide-pointer, .install-phone[data-step="3"] .guide-confirm-head .guide-target > .guide-pointer { display: block; }
    .install-phone[data-step="3"] .guide-confirm-head .guide-target > .guide-pointer { left: auto; right: calc(100% + 12px); top: 50%; bottom: auto; transform: translateY(-50%) rotate(-90deg); }
    @media (prefers-reduced-motion: reduce) { .guide-safari-menu, .guide-sheet, .guide-confirm { transition: none; } }
    .install-dots { display: flex; gap: 8px; }
    .pwa-install-guide .install-dots button { position: relative; flex: 1; height: 32px; padding: 0; border: 0; background: transparent; }
    .install-dots button::before { content: ''; position: absolute; left: 0; right: 0; top: 14px; height: 3px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-border); }
    .install-dots button[data-complete="true"]::before { background: var(--openbelt-color-primary); }
    .install-steps { display: grid; gap: 20px; margin: 0; padding: 0; list-style: none; }
    .install-steps li { display: flex; align-items: flex-start; gap: 14px; }
    .install-steps li > span { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-subtle); color: var(--openbelt-color-muted); }
    .install-steps svg { width: 20px; height: 20px; }
    .install-steps strong { display: block; font-weight: 600; }
    .install-steps p { margin: 3px 0 0; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
  \`;
  document.head.append(css);
  const paths = {
    share: 'M12 16V2m-4 4 4-4 4 4M7 9H4v13h16V9h-3',
    home: 'M4 3h16v18H4V3ZM8 12h8M12 8v8',
    note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 12h8M8 16h5',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    box: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
    wifi: 'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01',
    mail: 'M3 5h18v14H3V5Zm0 0 9 7 9-7',
    book: 'M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4V4Zm16 0h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6V4Z',
    tabs: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
    check: 'M20 6 9 17l-5-5',
  };
  const icon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + paths[name] + '"/></svg>';
  const pointer = '<svg class="guide-pointer" viewBox="0 0 32 44"><path d="M12 3H20V25H29L16 41L3 25H12Z"/></svg>';
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.dataset.pwaInstall = '';
  trigger.className = menu ? 'menu-item pwa-install-trigger' : 'pwa-install-trigger';
  trigger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M9 10h6m-3-3v6m-1 5h2"/></svg><span></span>';
  trigger.querySelector('span').textContent = mobile ? 'Add to Home Screen' : 'Install app';
  if (menu) { trigger.setAttribute('role', 'menuitem'); menu.prepend(trigger); }
  else side.append(trigger);
  const dialog = document.createElement('dialog');
  dialog.dataset.pwaInstall = ''; dialog.className = 'pwa-install-guide';
  dialog.setAttribute('aria-labelledby', 'pwa-install-title');
  dialog.innerHTML = '<header><h2 id="pwa-install-title"></h2><button type="button" class="install-close" aria-label="Close install guide">×</button></header><div class="install-body"></div><footer><button type="button" class="install-previous">Back</button><span class="install-progress"></span><button type="button" class="install-next">Next</button></footer>';
  dialog.querySelector('h2').textContent = mobile ? 'Add OpenBelt to your Home Screen' : 'Install OpenBelt';
  document.body.append(dialog);
  const body = dialog.querySelector('.install-body');
  const previous = dialog.querySelector('.install-previous');
  const next = dialog.querySelector('.install-next');
  const progress = dialog.querySelector('.install-progress');
  const steps = [
    ['Open the Safari menu', 'Tap ••• at the bottom right. Share already in your toolbar? Tap it and skip ahead.'],
    ['Tap Share', 'Choose Share at the top of the menu.'],
    ['Add to Home Screen', 'Tap the + action along the bottom of the share sheet.'],
    ['Tap Add', 'Leave Open as Web App on, then tap Add. Launch OpenBelt from its new icon.'],
  ];
  function showStep(value) {
    step = value;
    body.querySelector('.install-phone').dataset.step = String(step);
    body.querySelector('.install-instruction strong').textContent = steps[step][0];
    body.querySelector('.install-instruction p').textContent = steps[step][1];
    previous.disabled = step === 0; next.textContent = step === steps.length - 1 ? 'Done' : 'Next';
    progress.textContent = (step + 1) + ' of ' + steps.length;
    body.querySelectorAll('.install-dots button').forEach((dot, i) => {
      dot.dataset.complete = String(i <= step);
      dot.setAttribute('aria-current', i === step ? 'step' : 'false');
    });
  }
  function phone() {
    const row = (name, label, extra) => '<div class="guide-menu-row' + (extra || '') + '">' + icon(name) + label + (extra ? pointer : '') + '</div>';
    const action = (name, label, target) => '<div class="guide-action' + (target ? ' guide-target' : '') + '"><span class="guide-action-circle">' + icon(name) + '</span>' + label + (target ? pointer : '') + '</div>';
    const keys = ['qwertyuiop', 'asdfghjkl', '⇧zxcvbnm⌫'].map(keys => '<div>' + [...keys].map(key => '<i>' + key + '</i>').join('') + '</div>').join('');
    return '<div class="install-stage"><div class="install-phone" aria-hidden="true">'
      + '<div class="guide-status"><b>9:41</b><i class="guide-island"></i><span>•••</span></div>'
      + '<div class="guide-page"><div class="guide-brand">' + wordmark + '</div><div class="guide-tiles">' + ['Team notes', 'Time off', 'Expenses', 'Standup', 'Hiring', 'Roadmap'].map(name => '<div><i></i>' + name + '</div>').join('') + '</div></div>'
      + '<div class="guide-toolbar"><span>‹</span><span class="guide-host"></span><span class="guide-menu-button guide-target">•••' + pointer + '</span></div>'
      + '<div class="guide-safari-menu">' + row('share', 'Share', ' guide-share guide-target') + row('book', 'Add to Bookmarks') + row('list', 'Add Bookmark to…') + '<div class="guide-menu-row guide-menu-divider"><span>+</span>New Tab</div>' + row('box', 'New Private Tab')
      + '<div class="guide-menu-bottom"><span>' + icon('book') + '<small>Bookmarks</small></span><span>' + icon('tabs') + '<small>All Tabs</small></span></div></div>'
      + '<div class="guide-sheet"><div class="guide-share-head"><img class="guide-app-icon" src="/_pwa/icon-192.png" alt=""><div><strong>OpenBelt</strong><small class="guide-host"></small><span class="guide-options">Options ›</span></div></div>'
      + '<div class="guide-contacts">' + '<div><i></i><small>Contact</small></div>'.repeat(4) + '</div>'
      + '<div class="guide-apps">' + [['wifi', 'AirDrop'], ['note', 'Messages'], ['mail', 'Mail'], ['list', 'Notes']].map(([name, label], i) => '<div><i class="guide-app-' + i + '">' + icon(name) + '</i><small>' + label + '</small></div>').join('') + '</div>'
      + '<div class="guide-actions">' + action('note', 'Copy') + action('book', 'Add Bookmark') + action('home', 'Add to Home Screen', true) + action('list', 'Edit Actions') + '</div></div>'
      + '<div class="guide-confirm"><div class="guide-confirm-head"><span class="guide-cancel">×</span><strong>Add to Home Screen</strong><b class="guide-target">Add' + pointer + '</b></div>'
      + '<div class="guide-name"><img class="guide-app-icon" src="/_pwa/icon-192.png" alt=""><div><span class="guide-name-text"><i class="guide-caret"></i></span><small class="guide-url"></small></div></div>'
      + '<div class="guide-webapp"><span>Open as Web App</span><i class="guide-switch"></i></div>'
      + '<p class="guide-confirm-note">An icon will be added to your Home Screen so you can open it quickly.</p>'
      + '<div class="guide-keyboard">' + keys + '<div><i>123</i><i class="guide-space">space</i><i class="guide-key-done">✓</i></div></div></div>'
      + '</div></div><div class="install-instruction" aria-live="polite"><strong></strong><p></p></div><div class="install-dots"></div>';
  }
  function instructions() {
    lastFocus = document.activeElement;
    document.querySelector('#you-button')?.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
    if (ios) {
      body.innerHTML = phone();
      body.querySelectorAll('.guide-host').forEach(node => { node.textContent = location.host; });
      body.querySelector('.guide-name-text').prepend('OpenBelt');
      body.querySelector('.guide-url').textContent = location.origin;
      body.querySelectorAll('.install-phone .guide-target').forEach((target, i) => target.addEventListener('click', () => {
        if (step === i && i < steps.length - 1) showStep(i + 1);
      }));
      const dots = body.querySelector('.install-dots');
      steps.forEach(([title], i) => {
        const dot = document.createElement('button');
        dot.type = 'button'; dot.setAttribute('aria-label', 'Step ' + (i + 1) + ': ' + title);
        dot.addEventListener('click', () => showStep(i));
        dots.append(dot);
      });
      previous.hidden = progress.hidden = false; showStep(0);
    } else {
      body.innerHTML = '<ol class="install-steps"><li><span>' + icon('home') + '</span><div><strong>Open your browser menu</strong><p>Choose Install app or Add to Home Screen.</p></div></li><li><span>' + icon('check') + '</span><div><strong>Confirm installation</strong><p>Then launch OpenBelt from its app icon.</p></div></li></ol>';
      previous.hidden = progress.hidden = true; next.textContent = 'Done';
    }
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.install-close').focus();
  }
  previous.addEventListener('click', () => showStep(Math.max(0, step - 1)));
  next.addEventListener('click', () => {
    if (!ios || step === steps.length - 1) dialog.close();
    else showStep(step + 1);
  });
  dialog.querySelector('.install-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    const target = lastFocus?.isConnected && lastFocus.getClientRects().length ? lastFocus : document.querySelector('#you-button');
    target?.focus();
  });
  const invite = document.createElement('aside');
  invite.dataset.pwaInstall = ''; invite.className = 'toast pwa-install-invite'; invite.hidden = true;
  invite.setAttribute('aria-label', 'Install OpenBelt');
  invite.innerHTML = '<span class="toast-logo" aria-hidden="true">' + tile + '</span><h2 class="toast-title"></h2><div class="toast-actions"><button type="button" class="btn btn-primary install-now"></button><button type="button" class="btn btn-ghost install-later">Not now</button></div>';
  invite.querySelector('.toast-title').textContent = mobile ? 'Add to Home Screen' : 'Install OpenBelt';
  invite.querySelector('.install-now').textContent = mobile ? 'Add' : 'Install app';
  document.body.append(invite);
  function dismiss() { invite.hidden = true; remember('openbelt-install-dismissed'); }
  function hide() {
    invite.hidden = trigger.hidden = true;
    if (dialog.open) dialog.close();
  }
  async function install() {
    if (!nativePrompt) { invite.hidden = true; instructions(); return; }
    const pending = nativePrompt; nativePrompt = null; invite.hidden = true;
    try {
      await pending.prompt();
      const choice = await pending.userChoice;
      if (choice.outcome === 'accepted') { dismiss(); hide(); }
    } catch { instructions(); }
  }
  trigger.addEventListener('click', install);
  invite.querySelector('.install-now').addEventListener('click', install);
  invite.querySelector('.install-later').addEventListener('click', dismiss);
  addEventListener('beforeinstallprompt', event => { event.preventDefault(); if (!ios) { nativePrompt = event; setTimeout(offer, 1200); } });
  addEventListener('appinstalled', () => { dismiss(); hide(); });
  mode.addEventListener('change', () => { if (installed()) hide(); });
  document.querySelector('#grid')?.addEventListener('click', event => {
    if (event.target.closest('a[data-app]')) remember('openbelt-install-used');
  });
  function offer() {
    if (offered || installed() || location.pathname !== '/' || !read('openbelt-install-used') || read('openbelt-install-dismissed')) return;
    if (!ios && !nativePrompt) return;
    if (document.hidden || document.querySelector('dialog[open]') || document.documentElement.classList.contains('drawer-open')) return;
    try { if (sessionStorage.getItem('openbelt-install-offered') === '1') return; sessionStorage.setItem('openbelt-install-offered', '1'); } catch {}
    offered = true; invite.hidden = false;
  }
  addEventListener('pageshow', () => setTimeout(offer, 1200));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(offer, 1200); });
  setTimeout(offer, 1200);
})();
`
