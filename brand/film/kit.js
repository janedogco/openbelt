// K: the shared kit. Visual helpers are pure functions of their inputs (seeded), so draw(ctx, t) can be a
// pure function of t. Audio helpers work on any BaseAudioContext (live or OfflineAudioContext).
const K = (() => {
  const W = 1920, H = 1080;

  // ---------- math ----------
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const inv = (a, b, x) => clamp((x - a) / (b - a));            // progress of x through [a, b], clamped
  const smooth = (a, b, x) => { const t = inv(a, b, x); return t * t * (3 - 2 * t); };
  const ease = {
    linear: (t) => t,
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    out: (t) => 1 - Math.pow(1 - t, 3),
    in: (t) => t * t * t,
    outQuint: (t) => 1 - Math.pow(1 - t, 5),
    outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
  };
  const seg = (t, a, b, e = ease.inOut) => e(inv(a, b, t));      // eased progress of t through [a, b]
  // A damped spring's response at time dt after a step (0 → 1), for settle-with-overshoot motion.
  const spring = (dt, freq = 2.2, damp = 0.35) => (dt <= 0 ? 0 : 1 - Math.exp(-damp * 2 * Math.PI * freq * dt) * Math.cos(2 * Math.PI * freq * Math.sqrt(1 - damp * damp) * dt));

  // ---------- randomness ----------
  function rng(seed = 1) {
    let a = seed >>> 0 || 1;
    const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.range = (lo, hi) => lo + r() * (hi - lo);
    r.int = (lo, hi) => Math.floor(r.range(lo, hi + 1));
    r.pick = (arr) => arr[Math.floor(r() * arr.length)];
    r.gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return r;
  }
  const hash = (...n) => { let h = 2166136261; for (const x of n) { h ^= Math.floor(x * 1000) | 0; h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  // Smooth value noise in 1D and 2D, in [-1, 1].
  const noise1 = (x, seed = 0) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i, seed) * 2 - 1, hash(i + 1, seed) * 2 - 1, u); };
  const noise2 = (x, y, seed = 0) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(i, j, seed), b = hash(i + 1, j, seed), c = hash(i, j + 1, seed), d = hash(i + 1, j + 1, seed);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
  };

  // ---------- brand ----------
  const C = {
    ink: '#0c0b0a', paper: '#fffefb', surface: '#f8f7f3', subtle: '#f1efe9', border: '#e4e1d8', borderStrong: '#d1cdc1',
    muted: '#6f6a5f', success: '#2f7a55', warning: '#8a5f00', error: '#b8352a', highlight: '#856000',
    inkDark: '#f8f7f3', surfaceDark: '#181714', subtleDark: '#22201c', borderDark: '#2b2925', borderStrongDark: '#403d36',
    mutedDark: '#a39e91', successDark: '#67d29a', warningDark: '#f2c14e', errorDark: '#ff7a6b', highlightDark: '#ffd43b',
  };
  const FONT = { head: '"Inter Tight", Inter, system-ui, sans-serif', body: 'Inter, system-ui, sans-serif', mono: '"JetBrains Mono", ui-monospace, monospace' };
  const SLOT = new Path2D('M0 0H3V3H0V2H2V1H0Z'); // 3x3 units
  const WORDMARK = new Path2D('M0 -1490H1490V0H0V-496.7H993.3V-993.3H0ZM1986.7 0V-1490H2559.7Q2730.2 -1490 2848.2 -1425.8Q2966.2 -1361.5 3027.9 -1248.5Q3089.7 -1135.5 3089.7 -990Q3089.7 -844.5 3027.4 -732.2Q2965.2 -620 2845.4 -556.5Q2725.7 -493 2553.7 -493H2181.7V-730H2509.7Q2605.7 -730 2667.7 -763.2Q2729.7 -796.5 2759.7 -855.2Q2789.7 -914 2789.7 -990Q2789.7 -1067.5 2759.7 -1125.5Q2729.7 -1183.5 2667.4 -1215.8Q2605.2 -1248 2508.7 -1248H2278.7V0ZM3167.2 0V-1118H3444.2V-926H3456.2Q3486.7 -1027 3560.2 -1080Q3633.7 -1133 3728.2 -1133Q3750.7 -1133 3777.7 -1130.8Q3804.7 -1128.5 3824.2 -1124V-866Q3804.7 -872.5 3767.5 -876.8Q3730.2 -881 3697.2 -881Q3627.2 -881 3571.7 -850.8Q3516.2 -820.5 3484.7 -767.2Q3453.2 -714 3453.2 -644V0ZM4311.8 22Q4141.8 22 4018.3 -48.2Q3894.8 -118.5 3828.8 -247.8Q3762.8 -377 3762.8 -553Q3762.8 -725.5 3828.5 -855.8Q3894.3 -986 4014 -1059Q4133.8 -1132 4295.8 -1132Q4402.8 -1132 4497 -1097.8Q4591.3 -1063.5 4663 -993.8Q4734.8 -924 4775.3 -817.5Q4815.8 -711 4815.8 -566V-483H3885.8V-667H4675.3L4541.8 -616Q4541.8 -706 4514.3 -772.8Q4486.8 -839.5 4432.5 -876.8Q4378.3 -914 4297.8 -914Q4217.3 -914 4161 -876.5Q4104.8 -839 4075.3 -775.2Q4045.8 -711.5 4045.8 -631V-502Q4045.8 -405.5 4079.5 -337Q4113.3 -268.5 4174.3 -232.2Q4235.3 -196 4315.8 -196Q4369.8 -196 4414 -211.5Q4458.3 -227 4490.3 -257.8Q4522.3 -288.5 4538.8 -333L4804.8 -309Q4782.3 -209 4716.8 -134.5Q4651.3 -60 4548.5 -19Q4445.8 22 4311.8 22ZM5796.3 -810 5535.3 -789Q5522.3 -843 5473.3 -883.5Q5424.3 -924 5338.3 -924Q5261.3 -924 5209.3 -891Q5157.3 -858 5157.3 -805Q5157.3 -760.5 5191.3 -730.5Q5225.3 -700.5 5306.3 -683L5503.3 -643Q5663.3 -610 5742.3 -535.5Q5821.3 -461 5821.3 -341Q5821.3 -233 5758.8 -151.2Q5696.3 -69.5 5586.6 -23.8Q5476.8 22 5334.3 22Q5120.8 22 4992.8 -67.8Q4864.8 -157.5 4841.3 -314L5121.3 -334Q5137.3 -262.5 5192.6 -225.8Q5247.8 -189 5334.3 -189Q5421.8 -189 5475.6 -224.2Q5529.3 -259.5 5529.3 -312Q5529.3 -400.5 5382.3 -432L5190.3 -472Q5028.3 -506 4949.8 -585.2Q4871.3 -664.5 4871.3 -788Q4871.3 -894 4929.3 -971Q4987.3 -1048 5091.6 -1090Q5195.8 -1132 5334.3 -1132Q5538.8 -1132 5655.8 -1045Q5772.8 -958 5796.3 -810ZM6469.9 -1118V-899H5812.9V-1118ZM5967.9 -1384H6253.9V-340Q6253.9 -279 6280.9 -250Q6307.9 -221 6366.9 -221Q6384.4 -221 6405.9 -224Q6427.4 -227 6443.9 -231L6490.9 -12Q6444.4 2 6399.2 8.8Q6353.9 15.5 6309.4 15.5Q6147.9 15.5 6057.9 -67.5Q5967.9 -150.5 5967.9 -298ZM7032.5 22Q6866 22 6744.2 -50.2Q6622.5 -122.5 6556.5 -252.2Q6490.5 -382 6490.5 -554Q6490.5 -727.5 6556.5 -857.5Q6622.5 -987.5 6744.2 -1059.8Q6866 -1132 7032.5 -1132Q7199.5 -1132 7321.2 -1059.8Q7443 -987.5 7509.2 -857.5Q7575.5 -727.5 7575.5 -554Q7575.5 -382 7509.2 -252.2Q7443 -122.5 7321.2 -50.2Q7199.5 22 7032.5 22ZM7033.5 -205Q7117.5 -205 7173 -251Q7228.5 -297 7256.5 -376.5Q7284.5 -456 7284.5 -555Q7284.5 -655.5 7256.5 -734.5Q7228.5 -813.5 7173 -859.2Q7117.5 -905 7033.5 -905Q6950 -905 6893.7 -859.2Q6837.5 -813.5 6809.5 -734.5Q6781.5 -655.5 6781.5 -555Q6781.5 -456 6809.5 -376.5Q6837.5 -297 6893.7 -251Q6950 -205 7033.5 -205Z');
  // The slot (3x3 square, two left middle cells removed) with its top-left at (x, y), `size` px wide.
  function slot(ctx, x, y, size, color = C.ink) { ctx.save(); ctx.translate(x, y); ctx.scale(size / 3, size / 3); ctx.fillStyle = color; ctx.fill(SLOT); ctx.restore(); }
  // The wordmark, its left edge at x and baseline at y, cap height `cap` px. Width is about 5.08 × cap.
  function wordmark(ctx, x, y, cap, color = C.ink) { ctx.save(); ctx.translate(x, y); ctx.scale(cap / 1490, cap / 1490); ctx.fillStyle = color; ctx.fill(WORDMARK); ctx.restore(); }
  wordmark.ratio = 7575.5 / 1490;

  // ---------- text ----------
  function text(ctx, s, x, y, o = {}) {
    const { size = 48, weight = 650, font = 'head', color = C.ink, align = 'left', baseline = 'alphabetic', track = font === 'head' ? -0.03 : 0, alpha = 1, maxWidth } = o;
    ctx.save(); ctx.globalAlpha *= alpha;
    ctx.font = `${weight} ${size}px ${FONT[font] || font}`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${track * size}px`;
    ctx.fillText(s, x, y, maxWidth); ctx.restore();
  }
  function measure(ctx, s, o = {}) {
    const { size = 48, weight = 650, font = 'head', track = font === 'head' ? -0.03 : 0 } = o;
    ctx.save(); ctx.font = `${weight} ${size}px ${FONT[font] || font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = `${track * size}px`;
    const w = ctx.measureText(s).width; ctx.restore(); return w;
  }
  // The first n characters of s for a typing effect at progress p (0..1), with a caret flag.
  const typed = (s, p) => s.slice(0, Math.round(clamp(p) * s.length));
  function wrap(ctx, s, maxW, o = {}) {
    const words = s.split(' '), lines = []; let cur = '';
    for (const w of words) { const nx = cur ? cur + ' ' + w : w; if (measure(ctx, nx, o) > maxW && cur) { lines.push(cur); cur = w; } else cur = nx; }
    if (cur) lines.push(cur); return lines;
  }

  // ---------- shapes ----------
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  // Catmull-Rom through pts, sampled every `step` px.
  function spline(pts, step = 4) {
    if (pts.length < 3) return pts.slice();
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
      }
    }
    out.push(pts[pts.length - 1].slice()); return out;
  }
  // A hand-drawn stroke through pts: wobble (px), width (px), progress 0..1 draws it on from the start,
  // passes > 1 draws it again slightly off, like a pen going over a line twice. Pure in its inputs.
  function hand(ctx, pts, o = {}) {
    const { seed = 1, wobble = 2, width = 3, color = C.ink, progress = 1, passes = 1, taper = true, alpha = 1, smoothPts = true } = o;
    if (progress <= 0 || pts.length < 2) return;
    const base = smoothPts ? spline(pts, 3) : densify(pts, 3);
    const total = base.length - 1, upto = Math.max(1, Math.floor(total * clamp(progress)));
    ctx.save(); ctx.globalAlpha *= alpha; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let p = 0; p < passes; p++) {
      const s = seed * 31 + p * 7;
      let len = 0;
      for (let i = 1; i <= upto; i++) {
        const [x0, y0] = base[i - 1], [x1, y1] = base[i];
        len += Math.hypot(x1 - x0, y1 - y0);
        const off = (k, l) => [base[k][0] + noise1(l / 60, s) * wobble, base[k][1] + noise1(l / 60, s + 99) * wobble];
        const a = off(i - 1, len - Math.hypot(x1 - x0, y1 - y0)), b = off(i, len);
        const q = i / total, wt = taper ? 0.55 + 0.45 * Math.sin(Math.PI * clamp(q * 0.9 + 0.05)) : 1;
        ctx.lineWidth = width * wt * (1 + 0.15 * noise1(len / 25, s + 3));
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
    ctx.restore();
  }
  function densify(pts, step) { const out = [pts[0]]; for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step)); for (let k = 1; k <= n; k++) out.push([lerp(x0, x1, k / n), lerp(y0, y1, k / n)]); } return out; }
  // A hand-drawn rectangle outline (corners overshoot a little).
  function handRect(ctx, x, y, w, h, o = {}) {
    const s = o.seed || 1, j = (o.overshoot ?? 6), r = rng(s);
    const pts = [[x - r() * j, y + r() * 2], [x + w + r() * j, y - r() * 2], [x + w - r() * 2, y + h + r() * j], [x - r() * 2, y + h + r() * 2], [x + r() * 3, y - r() * j]];
    hand(ctx, pts, { smoothPts: false, ...o });
  }
  // Pencil-style hatching inside the current clip: parallel jittered lines at `angle`.
  function hatch(ctx, x, y, w, h, o = {}) {
    const { gap = 10, angle = -0.8, color = C.ink, width = 1.2, alpha = 0.5, seed = 3, progress = 1 } = o;
    const r = rng(seed); ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha *= alpha; ctx.lineCap = 'round';
    const cx = x + w / 2, cy = y + h / 2, R = Math.hypot(w, h) / 2, dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
    const n = Math.floor((2 * R) / gap);
    for (let i = 0; i < n * clamp(progress); i++) {
      const o2 = -R + i * gap + r.range(-gap * 0.3, gap * 0.3);
      const a = R * r.range(0.85, 1);
      ctx.beginPath(); ctx.moveTo(cx + nx * o2 - dx * a, cy + ny * o2 - dy * a); ctx.lineTo(cx + nx * o2 + dx * a, cy + ny * o2 + dy * a); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- textures (cached, deterministic) ----------
  const cache = new Map();
  function cached(key, w, h, paint) {
    if (cache.has(key)) return cache.get(key);
    const c = new OffscreenCanvas(w, h); paint(c.getContext('2d'), w, h); cache.set(key, c); return c;
  }
  // Warm paper with fibres and grain. tone: base colour. Draw with ctx.drawImage(K.paper(...), 0, 0).
  function paper(tone = C.paper, seed = 7, w = W, h = H, grain = 0.06) {
    return cached(`paper:${tone}:${seed}:${w}:${h}:${grain}`, w, h, (g) => {
      g.fillStyle = tone; g.fillRect(0, 0, w, h);
      const r = rng(seed), img = g.getImageData(0, 0, w, h), d = img.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, n = (r() - 0.5) * 255 * grain + noise2(x / 140, y / 140, seed) * 255 * grain * 0.5;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
      }
      g.putImageData(img, 0, 0);
      g.globalAlpha = 0.05; g.strokeStyle = '#6f6a5f';
      for (let k = 0; k < (w * h) / 900; k++) { const x = r() * w, y = r() * h, a = r() * Math.PI, l = 4 + r() * 18; g.lineWidth = 0.6; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
    });
  }
  // Film grain overlay that changes per frame index (pass Math.floor(t * 24)).
  function grain(ctx, frame, amount = 0.05, size = 256) {
    const tile = cached(`grain:${frame % 8}:${size}`, size, size, (g) => {
      const r = rng(frame % 8 + 11), img = g.createImageData(size, size);
      for (let i = 0; i < img.data.length; i += 4) { const v = r() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
      g.putImageData(img, 0, 0);
    });
    ctx.save(); ctx.globalAlpha = amount; ctx.globalCompositeOperation = 'overlay';
    for (let y = 0; y < H; y += size) for (let x = 0; x < W; x += size) ctx.drawImage(tile, x, y);
    ctx.restore();
  }
  function vignette(ctx, strength = 0.35, color = '0,0,0') {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
    g.addColorStop(0, `rgba(${color},0)`); g.addColorStop(1, `rgba(${color},${strength})`);
    ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
  }

  // ---------- audio ----------
  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const midi = (n) => (typeof n === 'number' ? n : 12 * (parseInt(n.slice(-1)) + 1) + NOTE[n[0]] + (n[1] === '#' ? 1 : n[1] === 'b' ? -1 : 0));
  const hz = (n) => 440 * Math.pow(2, (midi(n) - 69) / 12);
  const chord = (root, kind = 'maj') => { const r = midi(root), iv = { maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10], sus2: [0, 2, 7], sus4: [0, 5, 7], add9: [0, 4, 7, 14], min9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14] }[kind]; return iv.map((i) => r + i); };

  // A scheduler that maps film time to context time and skips what starts before the play offset.
  // const S = K.sched(ac, dest, when, offset); S(time, (t, out) => K.piano(ac, out, t, 'C4', 0.8, 1.2));
  // The player renders the score in short windows (K.window = { to }), so each render builds only the
  // notes near it: a whole film's graph at once is too heavy for the realtime audio thread.
  function sched(ac, dest, when, offset) {
    const win = K.window;
    const S = (time, fn, out = dest) => { if (time < offset - 0.001 || (win && time >= win.to)) return; fn(when + time - offset, out); };
    S.ac = ac; S.dest = dest; S.when = when; S.offset = offset;
    S.at = (time) => when + time - offset;          // context time for a film time (may be in the past)
    return S;
  }
  // Algorithmic reverb: a deterministic decaying-noise impulse. Returns { input, wet }: connect sources to input.
  function reverb(ac, dest, { seconds = 2.8, decay = 2.5, wet = 0.3, seed = 5, damp = 4500 } = {}) {
    const len = Math.floor(ac.sampleRate * seconds), buf = ac.createBuffer(2, len, ac.sampleRate), r = rng(seed);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, decay); }
    const input = ac.createGain(), conv = ac.createConvolver(), lp = ac.createBiquadFilter(), wg = ac.createGain(), dry = ac.createGain();
    conv.buffer = buf; lp.type = 'lowpass'; lp.frequency.value = damp; wg.gain.value = wet; dry.gain.value = 1;
    input.connect(dry); dry.connect(dest); input.connect(conv); conv.connect(lp); lp.connect(wg); wg.connect(dest);
    return { input, wet: wg };
  }
  // Gentle bus compressor + soft limiter in front of dest; route everything through bus.input.
  function bus(ac, dest, { gain = 0.8 } = {}) {
    const input = ac.createGain(), comp = ac.createDynamicsCompressor(), out = ac.createGain();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
    out.gain.value = gain; input.connect(comp); comp.connect(out); out.connect(dest);
    return { input };
  }
  function env(g, t, a, peak, d, sustain = 0) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.setTargetAtTime(sustain, t + a, d / 3); }
  function osc(ac, type, f, t, stop, dest, detune = 0) { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune; o.connect(dest); o.start(t); o.stop(stop); return o; }
  function panner(ac, dest, pan) { if (!pan) return dest; const p = ac.createStereoPanner(); p.pan.value = pan; p.connect(dest); return p; }

  // Piano: partials with stretch, upper partials decaying faster, a felt hammer thump, velocity-dependent brightness.
  function piano(ac, dest, t, note, vel = 0.7, dur = 1.5, pan = 0) {
    const f = hz(note), m = midi(note), out = ac.createGain(), lp = ac.createBiquadFilter(), o2 = panner(ac, dest, pan);
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(800 + vel * 5000 + (m - 48) * 30, t); lp.frequency.setTargetAtTime(600 + vel * 1200, t, 0.6); lp.Q.value = 0.3;
    out.connect(lp); lp.connect(o2);
    const len = Math.max(0.3, dur), tail = 2.2 * Math.max(0.35, 1.6 - (m - 40) / 40), stop = t + len + 1.2;
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(vel * 0.32, t + 0.004);
    out.gain.setTargetAtTime(vel * 0.32 * 0.45, t + 0.01, 0.35 * tail);
    out.gain.setTargetAtTime(0, t + len, 0.18);
    const parts = [[1, 1, 0], [2, 0.42, 3], [3, 0.2, -2], [4, 0.1, 4], [5, 0.05, 0], [6, 0.03, 0]];
    for (const [k, a, dt] of parts) {
      const fk = f * k * (1 + 0.0004 * k * k); if (fk > 12000) continue;
      const g = ac.createGain(); g.gain.setValueAtTime(a, t); g.gain.setTargetAtTime(0, t, tail / (k * 0.9)); g.connect(out);
      osc(ac, 'sine', fk, t, stop, g, dt);
    }
    const n = noiseBuf(ac), src = ac.createBufferSource(), bp = ac.createBiquadFilter(), ng = ac.createGain();
    src.buffer = n; bp.type = 'bandpass'; bp.frequency.value = Math.min(4000, f * 3); bp.Q.value = 1.2;
    ng.gain.setValueAtTime(vel * 0.05, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(bp); bp.connect(ng); ng.connect(out); src.start(t); src.stop(t + 0.06);
  }
  // Marimba / mallet: sine fundamental + 4th partial, quick decay.
  function mallet(ac, dest, t, note, vel = 0.7, pan = 0) {
    const f = hz(note), o = panner(ac, dest, pan), g = ac.createGain(), g2 = ac.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.35, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    g2.gain.setValueAtTime(0, t); g2.gain.linearRampToValueAtTime(vel * 0.08, t + 0.002); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    g.connect(o); g2.connect(o); osc(ac, 'sine', f, t, t + 1, g); osc(ac, 'sine', f * 3.93, t, t + 0.2, g2);
  }
  // Bell / glockenspiel: inharmonic partials, long ring.
  function bell(ac, dest, t, note, vel = 0.5, ring = 2.5, pan = 0) {
    const f = hz(note), o = panner(ac, dest, pan);
    for (const [r, a, d] of [[1, 1, 1], [2.76, 0.45, 0.5], [5.4, 0.25, 0.3], [8.93, 0.12, 0.18]]) {
      const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.12 * a, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + ring * d); g.connect(o);
      osc(ac, 'sine', f * r, t, t + ring * d + 0.05, g);
    }
  }
  // Plucked string (Karplus-Strong rendered into a buffer, so it works offline too).
  const ksCache = new Map();
  function pluck(ac, dest, t, note, vel = 0.6, bright = 0.5, pan = 0) {
    const f = hz(note), key = `${ac.sampleRate}:${midi(note)}:${bright}`;
    let buf = ksCache.get(key);
    if (!buf) {
      const sr = ac.sampleRate, len = Math.floor(sr * 2.5), N = Math.round(sr / f), d = new Float32Array(len), r = rng(midi(note));
      for (let i = 0; i < N; i++) d[i] = r() * 2 - 1;
      const k = 0.5 * (0.996 + bright * 0.003);
      for (let i = N; i < len; i++) d[i] = k * (d[i - N] + d[i - N + 1 < i ? i - N + 1 : i - N]);
      buf = ac.createBuffer(1, len, sr); buf.copyToChannel(d, 0); ksCache.set(key, buf);
    }
    const s = ac.createBufferSource(), g = ac.createGain(); s.buffer = buf; g.gain.value = vel * 0.5; s.connect(g); g.connect(panner(ac, dest, pan)); s.start(t);
  }
  // Warm pad: detuned saws through a slow lowpass. notes: array of notes.
  function pad(ac, dest, t, notes, dur = 4, vel = 0.3, { attack = 1.2, release = 1.5, cutoff = 1400 } = {}) {
    const out = ac.createGain(), lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(cutoff * 0.5, t); lp.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.6); lp.Q.value = 0.5;
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(vel * 0.09, t + attack); out.gain.setValueAtTime(vel * 0.09, t + dur); out.gain.linearRampToValueAtTime(0, t + dur + release);
    out.connect(lp); lp.connect(dest);
    for (const n of notes) for (const dt of [-7, 0, 7]) osc(ac, 'sawtooth', hz(n), t, t + dur + release + 0.1, out, dt);
  }
  // Round bass: sine + a little triangle.
  function bass(ac, dest, t, note, dur = 0.5, vel = 0.7) {
    const f = hz(note), g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.4, t + 0.01); g.gain.setTargetAtTime(vel * 0.25, t + 0.02, 0.15); g.gain.setTargetAtTime(0, t + dur, 0.06); g.connect(dest);
    osc(ac, 'sine', f, t, t + dur + 0.4, g); const g2 = ac.createGain(); g2.gain.value = 0.25; g2.connect(g); osc(ac, 'triangle', f * 2, t, t + dur + 0.4, g2);
  }
  // Soft synth lead (filtered square/triangle), for melodies.
  function lead(ac, dest, t, note, dur = 0.4, vel = 0.5, { type = 'triangle', cutoff = 2500, pan = 0 } = {}) {
    const g = ac.createGain(), lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.connect(panner(ac, dest, pan)); g.connect(lp);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.18, t + 0.015); g.gain.setTargetAtTime(vel * 0.12, t + 0.03, 0.1); g.gain.setTargetAtTime(0, t + dur, 0.05);
    osc(ac, type, hz(note), t, t + dur + 0.4, g); osc(ac, type, hz(note), t, t + dur + 0.4, g, 6);
  }
  let NB = null; function noiseBuf(ac) { if (NB && NB.sampleRate === ac.sampleRate) return NB; const len = ac.sampleRate * 2, b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0), r = rng(42); for (let i = 0; i < len; i++) d[i] = r() * 2 - 1; NB = b; return b; }
  function noise(ac, dest, t, dur, { type = 'highpass', freq = 6000, q = 0.7, vel = 0.3, attack = 0.001, sweepTo } = {}) {
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = noiseBuf(ac); s.loop = true;
    f.type = type; f.frequency.setValueAtTime(freq, t); if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur); f.Q.value = q;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest); s.start(t, Math.random() * 0); s.stop(t + dur + 0.05);
  }
  const kick = (ac, dest, t, vel = 0.9) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); g.gain.setValueAtTime(vel * 0.9, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4); o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.45); };
  const snare = (ac, dest, t, vel = 0.6) => { noise(ac, dest, t, 0.18, { type: 'bandpass', freq: 1800, q: 0.8, vel: vel * 0.5 }); const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08); g.gain.setValueAtTime(vel * 0.3, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.15); };
  const hat = (ac, dest, t, vel = 0.3, open = false) => noise(ac, dest, t, open ? 0.25 : 0.05, { freq: 8000, vel: vel * 0.25 });
  const clap = (ac, dest, t, vel = 0.5) => { for (const d of [0, 0.012, 0.024]) noise(ac, dest, t + d, d === 0.024 ? 0.2 : 0.02, { type: 'bandpass', freq: 1200, q: 1.5, vel: vel * 0.4 }); };
  // UI-ish sounds.
  const tick = (ac, dest, t, vel = 0.3, f = 3200) => { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(vel * 0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02); const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500; o.connect(hp); hp.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.03); };
  const key = (ac, dest, t, vel = 0.4) => { noise(ac, dest, t, 0.03, { type: 'bandpass', freq: 2500 + Math.floor(t * 997) % 1500, q: 2, vel: vel * 0.35 }); tick(ac, dest, t, vel * 0.4, 1800); };
  const pop = (ac, dest, t, vel = 0.5, f = 600) => { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.06); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.35, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.15); };
  const whoosh = (ac, dest, t, dur = 0.6, vel = 0.3, up = true) => noise(ac, dest, t, dur, { type: 'bandpass', freq: up ? 300 : 4000, sweepTo: up ? 4000 : 300, q: 1.2, vel, attack: dur * 0.6 });
  const riser = (ac, dest, t, dur = 2, vel = 0.25) => { noise(ac, dest, t, dur, { type: 'bandpass', freq: 200, sweepTo: 6000, q: 2, vel, attack: dur * 0.95 }); };

  return {
    window: null,
    W, H, clamp, lerp, inv, smooth, ease, seg, spring, rng, hash, noise1, noise2,
    C, FONT, SLOT, WORDMARK, slot, wordmark, text, measure, typed, wrap,
    rrect, spline, hand, handRect, hatch, cached, paper, grain, vignette,
    midi, hz, chord, sched, reverb, bus, env, osc, panner, piano, mallet, bell, pluck, pad, bass, lead, noise, noiseBuf,
    kick, snare, hat, clap, tick, key, pop, whoosh, riser,
  };
})();
