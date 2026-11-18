// Player: fits the 1920x1080 canvas to the window, plays FILM with its score in sync, loops, scrubs.
// FILM contract (set by film.js): { title, duration, bg, draw(ctx, t), score(ac, dest, when, offset) }
//
// Sound: the score is rendered offline in SEG-second windows (each with PRE seconds of run-up, so notes
// ringing into the window are in it), in the background from load, and played as buffers. Building the
// whole score as one live graph is too heavy for the realtime audio thread: its clock stalls, and the
// picture, which follows that clock, freezes with it.
(function () {
  const W = 1920, H = 1080, SR = 44100, SEG = 4, PRE = 12;
  const cv = document.getElementById('film');
  const ctx = cv.getContext('2d');
  cv.width = W; cv.height = H;
  const $ = (id) => document.getElementById(id);
  const ui = { wrap: $('wrap'), start: $('start'), startLabel: document.querySelector('#start .btn'), play: $('play'), time: $('time'), scrub: $('scrub'), loop: $('loop'), mute: $('mute') };
  const F = () => window.FILM;
  const nseg = () => Math.ceil(F().duration / SEG);

  // ---------- the score, rendered in windows ----------
  // A window is film time [s0, end), rendered from s0 - PRE so notes ringing into it are in it. Windows come
  // in three kinds, by id:
  //   "k"     window k of a pass that started here: nothing before 0 (a clean start);
  //   "kw"    window k of a pass that follows a previous one (looping): the end of that pass is still ringing
  //           into the start, so the seam is seamless (only differs from "k" while s0 < PRE);
  //   "tail"  after the end, [D, D + TAIL): the last notes ringing out when the film doesn't loop.
  const TAIL = 8;
  const segs = new Map();  // id → Promise<[L, R]>
  const done = new Map();  // id → [L, R] once rendered
  const start = (id) => (id === 'tail' ? F().duration : parseInt(id) * SEG);
  function render(id) {
    if (segs.has(id)) return segs.get(id);
    const D = F().duration, tail = id === 'tail', wrap = id.endsWith('w');
    const s0 = start(id), end = tail ? D + TAIL : Math.min(D, s0 + SEG), from = s0 - PRE;
    const oac = new OfflineAudioContext(2, Math.max(1, Math.ceil((end - from) * SR)), SR);
    const g = oac.createGain(); g.connect(oac.destination);
    try {
      const off = Math.max(0, from);
      K.window = { to: Math.min(end, D) }; F().score(oac, g, off - from, off);
      if (wrap && from < 0) { K.window = { to: D }; F().score(oac, g, 0, D + from); }
    } catch (e) { (window.__errors ||= []).push('score: ' + e.message); console.error(e); } finally { K.window = null; }
    const p = oac.startRendering().then((buf) => {
      const a = Math.round(PRE * SR), n = Math.round((end - s0) * SR);
      const out = [buf.getChannelData(0).slice(a, a + n), buf.getChannelData(1).slice(a, a + n)];
      done.set(id, out);
      if (playing || tailing) for (const ps of passes) if (idsOf(ps).includes(id)) scheduleSeg(id, ps);
      return out;
    });
    segs.set(id, p); return p;
  }
  // The windows a pass plays, in order.
  function idsOf(p) {
    const ids = [];
    for (let k = 0; k < nseg(); k++) ids.push(p.wrap && k * SEG < PRE ? k + 'w' : String(k));
    if (p.tail) ids.push('tail');
    return ids;
  }
  // Renders the windows nearest the playhead first, PUMPS at a time: each OfflineAudioContext renders on its
  // own thread, so a heavy score still gets ahead of playback.
  const PUMPS = 3;
  let pumping = 0;
  function pump() {
    while (pumping < PUMPS) {
      const n = nseg(), here = Math.floor(now() / SEG), want = [];
      for (let i = 0; i < n; i++) want.push(String((here + i) % n));
      want.push('tail');
      for (let k = 0; k * SEG < PRE && k < n; k++) want.push(k + 'w');
      const id = want.find((w) => !segs.has(w));
      if (id === undefined) return;
      pumping++;
      render(id).finally(() => { pumping--; pump(); });
    }
  }
  async function renderAll() { await Promise.all(Array.from({ length: nseg() }, (_, k) => render(String(k)))); return Array.from({ length: nseg() }, (_, k) => done.get(String(k))); }

  // ---------- playback ----------
  // A pass is one play-through: context time `base` plays film time `from`. While looping, the next pass is
  // queued ahead of time so it starts on the exact sample the current one ends, and carries the end of this one
  // (wrap). A pass started by play or seek starts clean. Without looping, a pass ends with the tail, which keeps
  // ringing after the picture stops (tailing).
  let ac = null, master = null, sources = [], playing = false, tailing = false, startAt = 0, offset = 0, looping = true, muted = false, raf = 0;
  let passes = [], queued = false;

  function fit() { const s = Math.min(innerWidth / W, innerHeight / H); cv.style.width = W * s + 'px'; cv.style.height = H * s + 'px'; }
  addEventListener('resize', fit); fit();
  // Audio starts 80 ms after play is pressed, so the clock would read slightly negative until then.
  function now() { return playing ? Math.max(0, Math.min(F().duration, offset + (ac.currentTime - startAt))) : offset; }
  function fmt(t) { const s = Math.floor(t); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  function render2d(t) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = F().bg || '#0c0b0a'; ctx.fillRect(0, 0, W, H); ctx.restore();
    ctx.save(); try { F().draw(ctx, t); } catch (e) { (window.__errors ||= []).push('draw@' + t.toFixed(2) + ': ' + e.message); console.error(e); } ctx.restore();
    ui.time.textContent = fmt(t) + ' / ' + fmt(F().duration);
    ui.scrub.value = String(t / F().duration);
  }

  function scheduleSeg(id, p) {
    const s0 = start(id), [L, R] = done.get(id), dur = L.length / SR;
    if (s0 + dur <= p.from) return;
    let at = p.base + (s0 - p.from), off = 0;
    const minAt = Math.max(p.base, ac.currentTime + 0.02);
    if (at < minAt) { off = minAt - at; at = minAt; }
    if (off >= dur) return;
    const b = ac.createBuffer(2, L.length, SR); b.copyToChannel(L, 0); b.copyToChannel(R, 1);
    const src = ac.createBufferSource(); src.buffer = b; src.connect(master); src.start(at, off); sources.push(src);
  }
  function stopAudio() {
    for (const s of sources) { try { s.stop(); } catch {} } sources = [];
    if (master) { master.disconnect(); master = null; }
    passes = []; queued = false; tailing = false;
  }
  function addPass(p) { passes.push(p); for (const id of idsOf(p)) if (done.has(id)) scheduleSeg(id, p); }
  function startAudio(from) {
    stopAudio();
    master = ac.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ac.destination);
    startAt = ac.currentTime + 0.08; offset = from;
    addPass({ base: startAt, from, wrap: false, tail: !looping });
    pump();
  }

  function tick() {
    const D = F().duration;
    if (playing && looping && !queued && ac.currentTime >= startAt + (D - offset) - 2) { addPass({ base: startAt + (D - offset), from: 0, wrap: true, tail: false }); queued = true; }
    if (playing && now() >= D) {
      if (looping) { startAt += D - offset; offset = 0; passes.shift(); queued = false; }
      else { // the picture stops on its last frame; the sound rings out (the tail) until play or seek
        playing = false; tailing = true; offset = D; ui.play.textContent = '▶'; cancelAnimationFrame(raf); render2d(D); return;
      }
    }
    render2d(now());
    if (playing) raf = requestAnimationFrame(tick);
  }
  async function play() {
    if (!ac) ac = new AudioContext({ latencyHint: 'playback' });
    if (ac.state === 'suspended') await ac.resume();
    if (offset >= F().duration - 0.01) offset = 0;
    const first = String(Math.floor(offset / SEG));
    if (!done.has(first)) { ui.startLabel.textContent = 'Preparing sound…'; await render(first); }
    playing = true; ui.play.textContent = '❚❚'; ui.start.hidden = true;
    startAudio(offset); cancelAnimationFrame(raf); tick();
  }
  function pause() {
    if (!playing) return;
    offset = now(); playing = false; ui.play.textContent = '▶'; stopAudio(); cancelAnimationFrame(raf); render2d(offset);
  }
  function seek(t) {
    t = Math.max(0, Math.min(F().duration, t));
    if (playing) startAudio(t); else { if (tailing) stopAudio(); offset = t; render2d(t); }
  }

  ui.start.onclick = play;
  ui.play.onclick = () => (playing ? pause() : play());
  ui.scrub.oninput = () => seek(Number(ui.scrub.value) * F().duration);
  // Switching loop changes how this pass ends (tail or next pass), so the sound is re-laid from here.
  ui.loop.onclick = () => { looping = !looping; ui.loop.classList.toggle('off', !looping); if (playing) startAudio(now()); };
  ui.mute.onclick = () => { muted = !muted; ui.mute.classList.toggle('off', muted); if (master) master.gain.value = muted ? 0 : 1; };
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.code === 'ArrowRight') seek(now() + 5);
    else if (e.code === 'ArrowLeft') seek(now() - 5);
    else if (e.key === '0' || e.code === 'Home') seek(0);
    else if (e.key === 'm') ui.mute.onclick();
  });
  let idle = 0;
  addEventListener('mousemove', () => { ui.wrap.classList.add('show'); clearTimeout(idle); idle = setTimeout(() => ui.wrap.classList.remove('show'), 1800); });

  // ---------- hooks for the review tool ----------
  window.__state = () => ({ playing, tailing, looping, t: +now().toFixed(2), sources: sources.length, rendered: [...done.keys()].join(' '), passes: passes.map((p) => ({ from: p.from, wrap: p.wrap, tail: p.tail })) });
  window.__windowRms = async (id, secs = 1) => { const [L] = await render(id); const n = Math.min(L.length, Math.round(secs * SR)); let s = 0; for (let i = 0; i < n; i++) s += L[i] * L[i]; return +Math.sqrt(s / n).toFixed(4); };
  window.__seek = (t) => { pause(); offset = t; ui.start.hidden = true; render2d(t); return true; };
  const joined = async () => {
    const parts = await renderAll(), n = parts.reduce((s, p) => s + p[0].length, 0), L = new Float32Array(n), R = new Float32Array(n);
    let o = 0; for (const [a, b] of parts) { L.set(a, o); R.set(b, o); o += a.length; }
    return [L, R];
  };
  window.__audioStats = async (step = 0.5) => {
    const [L, R] = await joined(), n = Math.floor(step * SR), rms = [];
    let peak = 0, clipped = 0;
    for (let i = 0; i + n <= L.length; i += n) {
      let s = 0;
      for (let j = i; j < i + n; j++) { const v = (L[j] + R[j]) / 2; s += v * v; const a = Math.max(Math.abs(L[j]), Math.abs(R[j])); if (a > peak) peak = a; if (a >= 0.999) clipped++; }
      rms.push(Math.round(Math.sqrt(s / n) * 1000) / 1000);
    }
    return { duration: F().duration, step, peak: Math.round(peak * 1000) / 1000, clippedSamples: clipped, rms };
  };
  window.__wav = async () => {
    const [L, R] = await joined(), N = L.length, out = new DataView(new ArrayBuffer(44 + N * 4));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); out.setUint32(4, 36 + N * 4, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true);
    out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, SR, true); out.setUint32(28, SR * 4, true);
    out.setUint16(32, 4, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, N * 4, true);
    for (let i = 0; i < N; i++) { out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
    const bytes = new Uint8Array(out.buffer); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  // canvas-only fonts never load by themselves: ask for each face the films draw with, then start
  Promise.all(['650 88px Geist', '650 88px "Inter Tight"', '500 64px "JetBrains Mono"', '400 16px Inter'].map((f) => document.fonts.load(f).catch(() => null))).then(() => document.fonts.ready).then(() => {
    document.title = (F().title || 'Film') + ' · OpenBelt';
    $('title').textContent = F().title || '';
    $('logline').textContent = F().logline || '';
    render2d(Number(new URLSearchParams(location.hash.slice(1)).get('t')) || (F().poster ?? 0));
    pump();
  });
})();
