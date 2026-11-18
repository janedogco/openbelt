/* GRID 8: Maya's story on dark, in pixel art. She connects her tools once, her agents can use them, one
   builds her an app, she shares it with a link, her team uses it live, apps build on each other, the field of
   apps blooms into patterns that resolve into a butterfly, it flies, and lands as the team's app store; the
   place it all ran through was OpenBelt all along.

STYLE    Light on dark: pure black ground (#000), paper-white squares and type, #ffd43b for what is new. Pixel
         sprites on the construction grid; only the big Inter Tight statements, no small text. The hub is a
         ring of eight squares (the slot, one square short); the slot appears only at the end.

TEMPO    12/8, dotted quarter = 120: beat 0.5 s, pulse 1/6 s, bar 2 s. 36 bars = 72 s.

BEATS
   0  bar 0   Close on Maya; she waves. 0.83 the camera pulls back; her five tools fly out of her to the top;
              the ring builds; one line from each tool into it.   "Connect your tools once."
   6  bar 3   Robots drop in, one trunk into the ring; a pulse lights their eyes; a fifth plugs into a spare
              port.   "Every agent can use them."
  11.3        Maya asks (a bubble with a list app); her first robot works; files fold into a tile; it lifts and
              snaps into the grid, live (16.0); she cheers.   "Your agents build apps."  "Live the moment ..."
  20  bar 10  She walks over, the team drops in. 21.0 a link pops out of the app into her hand; 21.9 she sends
              it: a chat bubble with the link flies to each teammate; they tap it; their screens open with the
              app.   "Share it with a link."
  23.7        Posts go up and come down on every screen at once; 31.67 the same tools appear on every screen.
              "Your whole team uses them."  "Every change shows up live."
  34  bar 17  Apps drop in and link to each other. Every tile is a page of 12 x 12 pixels (its list, chart,
              calendar), the gaps between them drawn.   "Apps can build on each other."  "Each one makes the next easier."
  42  bar 21  The camera slides onto the apps; the links fade, the ring steps aside. 43.0: the page pixels ARE the
              field, cell for cell (no zoom, no resolution switch, no fade). Rings rise from each app's centre on
              every beat; 44.5 a quasicrystal opens from the middle, stepping on the pulse.
  46          Convergence, every cell changing only in palette steps on the pulse: rings rise from the eye-spots;
              inside the wings, cells ripple out from the eye-spots and the body, each stepping through four
              palette colours from what it held to its butterfly colour; outside, rings close in from the edges
              and step cells to dark, carving the wing outline. 50.0 bar 25: every cell holds the butterfly; the
              three.js render takes over on the same cells (its camera views exactly the field's cells).
  50.5        One slow beat; 52.0 lift-off; it flies the frame with depth and banking, no trails; 55.3 it turns and
              comes straight at the camera; 56.0 bar 28, the last downbeat: its open wings fill the frame.
  56.0        Bloom: a shockwave from the centre runs through the wing; behind it every cell is a living app tile
              in the wing's colours (lists ticking, charts growing, calendars filling, a pulse shimmer), lights
              running between them. Maya, her team and her robots are tiles in it; the ring is made of cells, its
              middle beating. 58 the camera pulls back over the whole city.   "Your team's own app store."
  62.3 bar 31 The city folds into the ring; 64.0 the biggest chord: its left square slides out, the slot. Wordmark;
              "An app store for you and your agents."; the slot breaks into pixels that fly into Maya (frame 0).

THE BUTTERFLY  three.js (// @lib three): four wing planes hinged at the body, each with a top and an underside
         texture painted on canvas (radial gradient from deep ochre to yellow, scale bands, veins, a discal cell,
         a dark margin with cream dots, apex spots, a ringed eye-spot on the hindwing), a furry body, antennae
         with clubs, lit by a hemisphere light, a key and a warm rim. Rendered at 192 x 108 (one pixel per
         10 px cell), read back, ordered-dithered (Bayer 4 x 4) and quantised through a 32k lookup table to an
         18-colour palette, then drawn as grid cells. Flap angle, heading, bank, pitch and position are all
         functions of t.

MUSIC    D major, Reich-style phasing as in Grid. The share: a pop and bells as the link appears, a whoosh as it
         is sent, plucks as it lands, bells as each screen opens. The field: whooshes on the zoom steps, a
         growth voice on Life's births, a bell for each beat's rings, ticks and hats shimmering on the pulse, a
         sweep under the palette. The butterfly: a glockenspiel climbing as it forms, a chord when it is whole,
         breaths on every downstroke, a rising lead over the flight, mallets falling as the store's wave runs.
*/
window.FILM = (() => {
  const P = 1 / 6, OX = 960, OY = 470, DUR = 73, CUTS = [22, 32, 34], INTRO = 3; // bars cut at old real 22 .. 24 and 34 .. 36; the intro, then the film
  // Light on dark: INK is the colour of every mark (paper-white on the dark), PAPER the ground.
  const C = K.C, INK = C.inkDark, PAPER = '#000000', YEL = '#ffd43b', HAIR = '#302d28', MUTED = C.mutedDark, GLOW = 'rgba(248,247,243,';
  const REG = [120, 150, 1800, 790];
  const q = (x) => Math.round(x / P) * P;
  const ph = (t, a, n = 2, e = K.ease.inOut) => K.seg(t, a, a + n * P, e);
  const lerpLog = (a, b, u) => Math.exp(K.lerp(Math.log(a), Math.log(b), u));
  const kk = (i, j) => i + ',' + j;

  // ---------------------------------------------------------------- polylines
  function polyCut(pts, a, b) {
    const out = []; let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0), s0 = acc, s1 = acc + L;
      if (L > 0 && s1 >= a && s0 <= b) {
        const u0 = Math.max(0, (a - s0) / L), u1 = Math.min(1, (b - s0) / L);
        if (!out.length) out.push([x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0]);
        out.push([x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1]);
      }
      acc = s1;
    }
    return out;
  }
  const polyLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
  const polyAt = (pts, d) => { const c = polyCut(pts, 0, Math.max(0.001, d)); return c[c.length - 1] || pts[0]; };
  function strokePts(ctx, pts, w, col = INK) {
    if (pts.length < 2) return;
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke(); ctx.restore();
  }
  // wires are quiet: thin and dim; only a pulse travelling along one lights it
  const WIRE = '#525252', WW = 2; // opaque, so runs that share a path look the same as runs that don't
  function partial(ctx, pts, a, b, w = WW, col = WIRE) { const L = polyLen(pts); if ((b - a) * L > 0.5) strokePts(ctx, polyCut(pts, a * L, b * L), w, col); }
  function pulse(ctx, pts, u, z = 12, dim = false) { // a bright run along the wire, the dot at its head
    const L = polyLen(pts), d = u * L;
    if (d > 1) strokePts(ctx, polyCut(pts, Math.max(0, d - 110), d), 3, dim ? 'rgba(160,160,160,0.9)' : INK);
    const [x, y] = polyAt(pts, d); if (dim) { ctx.fillStyle = '#a0a0a0'; ctx.fillRect(x - z / 3, y - z / 3, z / 1.5, z / 1.5); } else dot(ctx, x, y, z);
  }
  function arrow(ctx, pts, s = 9) {
    const L = polyLen(pts), [ex, ey] = polyAt(pts, L), [px, py] = polyAt(pts, L - 6), a = Math.atan2(ey - py, ex - px);
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(a); ctx.fillStyle = '#737373'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-s * 1.3, -s); ctx.lineTo(-s * 1.3, s); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  function dot(ctx, x, y, z = 16) { ctx.fillStyle = YEL; ctx.fillRect(x - z / 2, y - z / 2, z, z); }
  const sq = (ctx, x, y, s, col = INK) => { if (s <= 0.3) return; ctx.fillStyle = col; ctx.fillRect(x - s / 2, y - s / 2, s, s); };
  const osq = (ctx, x, y, s, col = HAIR, w = 1.5) => { if (s <= 1) return; ctx.strokeStyle = col; ctx.lineWidth = w; ctx.strokeRect(x - s / 2, y - s / 2, s, s); };

  // ---------------------------------------------------------------- the statements: the only words in the film
  const WIPE_V = 4600, sine = (u) => 0.5 - 0.5 * Math.cos(Math.PI * K.clamp(u)); // px/s at the fastest point; a sine ease has no dead stop inside it
  const wipeDur = (L) => K.clamp((1.571 * L) / WIPE_V, 0.3, 0.75); // the travel's duration from its length, so every line moves alike
  // in: a bar grows over the line's box to its full width, holds, then its left edge sweeps right, uncovering the words.
  // out: the bar grows over the words to full width, holds, and sweeps right, leaving nothing. Every phase moves its edge at the
  // same peak speed whatever the line's width; the start shifts so the words are readable, and gone, when they were before.
  const WHOLD = 0.12;
  function wipe(ctx, t, a, b, x, w, top, bot, draw, minA = -1e9) {
    const D = wipeDur(w), old = wipeDur(w + Math.min(220, 0.35 * w)), shift = old - (2 * D + WHOLD), A = Math.max(a + shift, minA), Bt = b + shift, ph3 = (t0) => {
      const k = t - t0; return k < D ? ['grow', sine(k / D)] : k < D + WHOLD ? ['hold', 1] : ['sweep', sine((k - D - WHOLD) / D)];
    };
    if (t < A || t >= Bt + 2 * D + WHOLD) return;
    if (t >= A + 2 * D + WHOLD && t < Bt) { draw(); return; }
    const inn = t < Bt, [phase, u] = ph3(inn ? A : Bt);
    let bar, vis = null;
    if (phase === 'grow') { bar = [x, x + w * u]; if (!inn) vis = [x + w * u, x + w]; }
    else if (phase === 'hold') bar = [x, x + w];
    else { bar = [x + w * u, x + w]; if (inn) vis = [x, x + w * u]; }
    if (vis && vis[1] > vis[0]) { ctx.save(); ctx.beginPath(); ctx.rect(vis[0], top - 80, vis[1] - vis[0], bot - top + 160); ctx.clip(); draw(); ctx.restore(); }
    if (bar[1] - bar[0] >= 1) { ctx.fillStyle = INK; ctx.fillRect(bar[0], top, bar[1] - bar[0], bot - top); }
  }

  function statement(ctx, t, L, x = 120, y = 962, size = 92) {
    if (L.s.includes('\n')) { // two lines, the last on the usual baseline; the highlight in whichever line holds it
      const ls = L.s.split('\n'), sz = L.size || 84;
      ls.forEach((s, k) => statement(ctx, t, { ...L, s, hi: s.includes(L.hi) ? L.hi : null, a: L.a + k * P, b: L.b + k * P * 0.5 }, x, y + 24 - (ls.length - 1 - k) * sz * 1.1, sz));
      return;
    }
    const o = { size, track: -0.035, color: INK }, w = K.measure(ctx, L.s, o);
    if (x === 'center') x = OX - w / 2;
    const top = y - size * 0.8, bot = y + size * 0.24;
    const pv = LINES[LINES.indexOf(L) - 1], pw = pv ? K.measure(ctx, pv.s, o) + 24 : 0, prevEnd = pv && pv.b < L.a ? pv.b + wipeDur(pw + Math.min(220, 0.35 * pw)) + 0.03 : -1e9; // the line before has gone
    wipe(ctx, t, L.a, L.b, x - 12, w + 24, top, bot, () => {
      K.text(ctx, L.s, x, y, o);
      if (!L.hi) return;
      const i0 = L.s.indexOf(L.hi), x0 = x + (i0 > 0 ? K.measure(ctx, L.s.slice(0, i0), o) : 0), wh = K.measure(ctx, L.hi, o);
      const h0 = L.h ?? L.a + 4 * P, u = sine((t - h0) / wipeDur(wh + 16)); // the highlight grows at the same speed rule
      if (t < h0) return;
      const bx = x0 - 8, by = y - size * 0.8, bw = (wh + 16) * u, bh = size * 1.04;
      ctx.fillStyle = YEL; ctx.fillRect(bx, by, bw, bh);
      ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip(); K.text(ctx, L.s, x, y, { ...o, color: PAPER }); ctx.restore();
    }, prevEnd);
  }
  const LINES = [
    { s: 'Connect your tools once.', hi: null, a: 2.0, h: 4.33, b: 5.33 },
    { s: 'Every agent can use them.', hi: null, a: 6.33, h: 8.33, b: 11.17 },
    { s: 'You decide what they can touch.', hi: null, a: 11.83, h: 12.5, b: 14.67 },
    { s: 'Your agents build apps.', hi: null, a: 16.33, h: 17, b: 19.33 },
    { s: 'Share it with a link.', hi: null, a: 24.67, h: 25.33, b: 27.33 },
    { s: 'Collaborate with others.', hi: null, a: 27.67, h: 28.33, b: 31.33 },
    { s: 'Apps can build on each other.', hi: null, a: 38.33, h: 39.67, b: 42 },
    { s: 'Each can make the next one better.', hi: null, a: 42.33, h: 43, b: 46.33 },
    { s: 'Your tools form an ecosystem.', hi: null, a: 47, h: 48, b: 53.67 },
    { s: 'Your own tool belt.', hi: null, a: 63.33, h: 64, b: 66 },
    { s: 'Always within reach.', hi: null, a: 66.17, h: 66.83, b: 69.33 },
  ];

  // ---------------------------------------------------------------- pixel sprites ('#' ink, 'm' muted, 'y' yellow, 'e' eyes: yellow when lit)
  const COLS = { '#': INK, m: MUTED, y: YEL, w: '#ffffff' }; // w: a highlight drawn last
  // rows of a sprite at pixel size px, top-left at (x, y); pixels keep a hairline gap, like the grid's tiles
  function spr(ctx, rows, x, y, px, { lit = false, extra = null, skip = null } = {}) {
    if (px < 0.5) return;
    const byCol = {};
    const put = (ch, r, c) => { const col = ch === 'e' ? (lit ? YEL : null) : COLS[ch]; if (!col) return; (byCol[col] ||= []).push(r, c); };
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) { const ch = rows[r][c]; if (ch === '.' || (skip && skip(r, c))) continue; put(ch, r, c); }
    if (extra) for (const [r, c, ch] of extra) put(ch, r, c);
    const q = px >= 2 ? Math.round(px) : px, gq = q >= 5 ? Math.max(1, Math.round(q * 0.08)) : 0, X = Math.round(x + (px - q) * 2), Y = Math.round(y + (px - q) * 2);
    for (const col in byCol) { const a = byCol[col]; ctx.fillStyle = col; for (let i = 0; i < a.length; i += 2) ctx.fillRect(X + a[i + 1] * q, Y + a[i] * q, q - gq, q - gq); }
  }
  // people: 11 × 17; arms (columns 1 and 9, rows 10-12) and legs (rows 14-16) are posed in code
  const PEOPLE = {
    maya: ['...mmmmm...', '..mmmmmmm..', '.mmm###mmm.', '.mm#####mm.', '.mm#.#.#mm.', '.mm#####mm.', '.mmm###mmm.', '.mm.###.mm.', '.m..y#y..m.', '..yyyyyyy..', '..yyyyyyy..', '...yyyyy...', '...yyyyy...', '...#####...', '...##.##...', '...##.##...', '..###.###..'],
    sam: ['..m.m.m.m..', '..mmmmmmm..', '..m#####m..', '..#######..', '..##.#.##..', '..#######..', '...#####...', '....###....', '...#####...', '..#######..', '..#######..', '...#####...', '...#####...', '...mmmmm...', '...mm.mm...', '...mm.mm...', '..mmm.mmm..'],
    lee: ['...mmmmm...', '..mmmmmmm..', '.mmmmmmmmm.', '..#######..', '..##.#.##..', '..#######..', '...#####...', '....###....', '...#####...', '..mmmmmmm..', '..#######..', '...mmmmm...', '...#####...', '...mmmmm...', '...mm.mm...', '...mm.mm...', '..mmm.mmm..'],
    ana: ['....mmm....', '....mmm....', '..mmmmmmm..', '.mm#####mm.', '.m##.#.##m.', '..#######..', '...#####...', '....###....', '...mmmmm...', '..mmmmmmm..', '..mmmmmmm..', '...mmmmm...', '..#######..', '..#######..', '...#...#...', '...#...#...', '..##...##..'],
  };
  const EYES = { maya: [[4, 4], [4, 6]], sam: [[4, 4], [4, 6]], lee: [[4, 4], [4, 6]], ana: [[4, 4], [4, 6]] };
  const ARMS = {
    down: [[10, 1], [11, 1], [12, 1], [10, 9], [11, 9], [12, 9]],
    typeA: [[9, 1], [10, 1], [10, 9], [11, 9], [12, 9]], typeB: [[10, 1], [11, 1], [12, 1], [9, 9], [10, 9]],
    waveA: [[10, 1], [11, 1], [12, 1], [9, 9], [8, 10], [7, 10], [6, 10]], waveB: [[10, 1], [11, 1], [12, 1], [9, 9], [8, 9], [7, 9], [6, 9], [5, 10]],
    cheer: [[9, 0], [8, 0], [7, 0], [6, 0], [9, 10], [8, 10], [7, 10], [6, 10]],
    walk: [[10, 1], [11, 0], [12, 0], [10, 9], [11, 10], [12, 10]],
  };
  // pose: { arms, walk (stride frame), blink, breathe }; (x, y) is the centre of the feet
  function person(ctx, who, x, y, px, pose = {}) {
    const rows = PEOPLE[who], legC = rows[14].replace(/\./g, '')[0], top = y - 17 * px, left = x - 5.5 * px;
    const extra = (ARMS[pose.arms || 'down']).map(([r, c]) => [r, c, '#']);
    if (pose.blink) for (const [r, c] of EYES[who]) extra.push([r, c, rows[r][c - 1]]);
    const stride = pose.walk;
    if (stride) for (const [r, c] of [[14, 2], [14, 3], [14, 7], [14, 8], [15, 1], [15, 2], [15, 8], [15, 9], [16, 0], [16, 1], [16, 9], [16, 10]]) extra.push([r, c, legC]);
    const bob = pose.breathe ? px : 0; // the head and body dip a pixel on the out-breath
    spr(ctx, rows.slice(0, 14), left, top + bob, px, { extra: extra.filter(([r]) => r < 14), skip: (r, c) => false });
    spr(ctx, rows.slice(14), left, top + 14 * px, px, { extra: extra.filter(([r]) => r >= 14).map(([r, c, ch]) => [r - 14, c, ch]), skip: stride ? () => true : null });
  }
  // the access beat (real time A0 .. A0 + 4) is inserted into the story: the world holds at A0 under it, everything after runs 4 s later
  const A0 = 11.33, AL = 4;
  let TR = 0, ACC = -1, FT = -1; const FLEN = 4.0; // real time, and time into the access beat (-1 before it, AL after it); set at the start of every frame
  const breathe = (t, ph0 = 0) => ((TR + ph0) % 1) > 0.5;
  const blinkAt = (t, seed) => { const f = (TR + seed * 0.37) % 2.6; return f > 2.45; };
  // robots: 9 × 13, each a different build; eyes light up when their agent can use the tools
  const BOTS = [
    ['....#....', '....#....', '.#######.', '.#.....#.', '.#.e.e.#.', '.#.....#.', '.#######.', '...###...', '#########', '#.#####.#', '#.#####.#', '..##.##..', '..##.##..'],
    ['...###...', '.#######.', '#########', '#.eeeee.#', '#########', '.#######.', '...###...', '..#####..', '.#######.', '.#######.', '#########', '#.#.#.#.#', '#########'],
    ['.#.....#.', '..#...#..', '..#####..', '..#e#e#..', '..#####..', '..#...#..', '..#####..', '...###...', '.#######.', '#..###..#', '...###...', '...#.#...', '..##.##..'],
    ['.........', '..#####..', '##.....##', '##.e.e.##', '##.....##', '..#####..', '.........', '#########', '#########', '#.#####.#', '#########', '.##...##.', '.##...##.'],
    ['...##....', '....#....', '..#####..', '.#######.', '.##e#e##.', '.#######.', '..#####..', '...###...', '..#####..', '.#.###.#.', '...###...', '...#.#...', '..##.##..'],
  ];
  function bot(ctx, k, x, y, px, lit, scan = -1) { // (x, y): centre of the feet; scan in [0, 1): working, the scanner's place
    let rows = BOTS[k], extra = null;
    if (scan >= 0) { // the eyes merge into one visor; a bright dot sweeps along it
      const er = rows.findIndex((r) => r.includes('e')), row = rows[er], e0 = row.indexOf('e'), e1 = row.lastIndexOf('e');
      const a = row.lastIndexOf('#', e0) + 1, b = row.indexOf('#', e1) - 1, tri = scan < 0.5 ? scan * 2 : 2 - scan * 2;
      rows = rows.map((r, i) => (i === er ? r.slice(0, a) + 'e'.repeat(b - a + 1) + r.slice(b + 1) : r));
      extra = [[er, a + Math.round(tri * (b - a)), 'w']]; lit = true;
    }
    spr(ctx, rows, x - 4.5 * px, y - 13 * px, px, { lit, extra });
  }
  const scanAt = (t, t0) => ((t - t0) * 2) % 1; // two sweeps a beat
  // tools, as pixel versions of the real marks (simple-icons paths): github, gmail, datadog, linear, notion
  const LOGOS = [{"n": "github", "d": "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"}, {"n": "gmail", "d": "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"}, {"n": "datadog", "d": "M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749"}, {"n": "linear", "d": "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"}, {"n": "notion", "d": "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"}];
  const ICOL = Array(5).fill('#f8f7f3'), ICOL_OFF = Array(5).fill('#474747'), IN = 24;
  let ICONSPR = null;
  function iconSprites() { // each mark rasterised once at 8× and averaged into IN × IN cells
    if (ICONSPR) return ICONSPR;
    const S8 = 8, c = document.createElement('canvas'); c.width = c.height = IN * S8; const g = c.getContext('2d', { willReadFrequently: true });
    ICONSPR = LOGOS.map((L) => {
      g.clearRect(0, 0, IN * S8, IN * S8); g.save(); const pad = 1.0; g.translate(pad * S8, pad * S8); g.scale(((IN - 2 * pad) * S8) / 24, ((IN - 2 * pad) * S8) / 24);
      g.fillStyle = '#fff'; g.fill(new Path2D(L.d)); g.restore();
      const d = g.getImageData(0, 0, IN * S8, IN * S8).data, cells = [];
      for (let r = 0; r < IN; r++) for (let q = 0; q < IN; q++) {
        let a = 0; for (let y = 0; y < S8; y++) for (let x = 0; x < S8; x++) a += d[((r * S8 + y) * IN * S8 + q * S8 + x) * 4 + 3];
        if (a / (S8 * S8 * 255) >= 0.45) cells.push(r, q);
      }
      return cells;
    });
    return ICONSPR;
  }
  // a tool's mark, (9 × px) wide, centred at (cx, cy); dim: switched off for everyone
  const toolIcon = (ctx, k, cx, cy, px, flash = false, dim = false) => {
    const cs = 9 * px / IN >= 2 ? Math.round((9 * px) / IN) : (9 * px) / IN, w = cs * IN, x0 = Math.round(cx - w / 2), y0 = Math.round(cy - w / 2), gp = cs >= 4 ? 1 : 0, cells = iconSprites()[k];
    if (cs < 0.3) return;
    ctx.fillStyle = dim ? ICOL_OFF[k] : ICOL[k];
    for (let i = 0; i < cells.length; i += 2) ctx.fillRect(x0 + cells[i + 1] * cs, y0 + cells[i] * cs, cs - gp, cs - gp);
    if (flash) { ctx.strokeStyle = YEL; ctx.lineWidth = 4; ctx.strokeRect(cx - 6 * px, cy - 6 * px, 12 * px, 12 * px); }
  };
  // what an admin sets per tool: all (a switch, on), read (an eye), none (a padlock)
  const GATES = {
    on: ['.#########.', '#.......###', '#......####', '#......####', '#.......###', '.#########.'],
    eye: ['....#####....', '..##.....##..', '.#...###...#.', '#...#####...#', '#...#####...#', '#...#####...#', '.#...###...#.', '..##.....##..', '....#####....'],
    lock: ['..#####..', '.##...##.', '.#.....#.', '.#.....#.', '#########', '#########', '####.####', '###...###', '####.####', '#########', '#########'],
  };
  function gate(ctx, kind, x, y, px, col = INK) {
    const rows = GATES[kind], w = rows[0].length, h = rows.length;
    ctx.fillStyle = PAPER; ctx.fillRect(x - (w / 2 + 1) * px, y - (h / 2 + 1) * px, (w + 2) * px, (h + 2) * px);
    spr(ctx, col === INK ? rows : rows.map((r) => r.replace(/#/g, 'm')), x - (w / 2) * px, y - (h / 2) * px, px);
    if (kind === 'on') { ctx.fillStyle = YEL; ctx.fillRect(x + 2.5 * px, y - 1.5 * px, 2 * px, 3 * px); }
    if (kind === 'lock') { ctx.fillStyle = YEL; ctx.fillRect(Math.round(x - 0.5 * px), Math.round(y + 1.5 * px), Math.round(px), Math.round(2 * px)); }
  }
  // a speech bubble with an app inside (what Maya asks for)
  const BUBBLE = ['.###########.', '#...........#', '#...........#', '#...........#', '#...........#', '#...........#', '#...........#', '.#####.#####.', '......#.#....', '.......#.....'];

  // ---------------------------------------------------------------- what an app looks like: pixel UI drawn dark on its light tile
  const APPS = { '2,0': 'list', '4,0': 'spark', '4,-2': 'chart', '2,2': 'cal', '8,0': 'bars', '2,-2': 'notes', '6,0': 'doc' };
  // the posts of the team's list app, the newest sliding in at the top (yellow while it is new)
  function rowsIn(ctx, x, y, s, n, newest, t, onYel = false) {
    const x0 = x - s / 2, y0 = y - s / 2, u = ph(t, newest, 2, K.ease.out);
    for (let r = 0; r < 4; r++) {
      if (r === 3 && u >= 1) continue;
      const pos = r - (r === 0 ? 0 : 1 - u), idx = n - r;
      const w = (0.35 + 0.4 * K.hash(idx + 50, Math.round(x), 3)) * s * (r === 0 ? u : r === 3 ? 1 - u : 1);
      const fresh = r === 0 && t - newest < 1.0 && newest > 0 && !onYel;
      const yy = y0 + 0.13 * s + pos * 0.13 * s;
      if (w > 0.5) { ctx.fillStyle = PAPER; ctx.fillRect(x0 + 0.24 * s, yy, w * 0.8, 0.06 * s); ctx.fillStyle = fresh ? YEL : PAPER; ctx.fillRect(x0 + 0.1 * s, yy - 0.015 * s, 0.09 * s, 0.09 * s); }
    }
  }
  // the hub: a 3 × 3 block of squares (at the end it loses its two left-middle squares and is the slot)
  const BLOCK = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [0, 0]];
  function block(ctx, cx, cy, p, { grow = 1, col = INK, mid = null, gap = 0.84 } = {}) {
    BLOCK.forEach(([i, j], k) => { const g = typeof grow === 'function' ? grow(k) : grow; if (g > 0.01) sq(ctx, cx + i * p, cy + j * p, gap * p * g, k === 8 && mid ? mid : col); });
  }
  // the place: a ring of eight squares round an empty middle (it is the slot, one square short of it)
  const RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  function place(ctx, cx, cy, p, { glow = 0, grow = 1, gap = 0.84, left = 1, core = true, col = INK } = {}) {
    if (p * grow < 1) return;
    const s = gap * p;
    RING.forEach(([i, j], k) => {
      const g = typeof grow === 'function' ? grow(k) : grow; if (g <= 0.01) return;
      const lx = i === -1 && j === 0 ? left : 1; if (lx <= 0.01) return;
      sq(ctx, cx + i * p - (i === -1 && j === 0 ? (1 - lx) * p * 0.6 : 0), cy + j * p, s * g * (i === -1 && j === 0 ? lx : 1), col);
    });
    if (glow > 0.01) { ctx.save(); ctx.globalAlpha = glow; sq(ctx, cx, cy, s * (0.55 + 0.45 * glow), YEL); ctx.restore(); }
    else if (core) osq(ctx, cx, cy, s * 0.7, HAIR, 1.5);
  }

  // ---------------------------------------------------------------- camera and the world grid
  const P1 = 112;
  function cam(t) {
    if (t < 34) return { cx: 0, p: P1 };
    // act 5 and the ecosystem: no zoom; the app pages' own pixels are the cells; after the bloom, pull back over the city
    const u = ph(t, 58.0, 12);
    return { cx: K.lerp(5, 0, u), p: lerpLog(140, 84, u) }; // the apps centred (i 2 .. 8)
  }
  const W2S = (c, i, j) => [OX + (i - c.cx) * c.p, OY + j * c.p];
  const blocked = (i, j) => Math.abs(i) <= 1 && Math.abs(j) <= 1;
  const lane = (i, j) => (i === -2 && j === 0) || (Math.abs(i) <= 1 && j === -2); // under the agents' and tools' lines in act 3
  const NAMED = { '2,0': 'standup', '4,0': 'digest', '4,-2': 'metrics', '2,2': 'oncall', '8,0': 'okrs', '2,-2': 'retro', '6,0': 'wiki' };
  const DROPS = { '4,0': 35.0, '4,-2': 36.5, '2,2': 38.0, '8,0': 39.0, '2,-2': 39.83, '6,0': 40.5 };
  const LINKS = [ // centre to centre; trimmed at the tiles' edges, so each leaves and enters at an edge centre
    { pts: [[2, 0], [4, 0]], t: 35.5 },
    { pts: [[4, 0], [4, -2]], t: 37 },
    { pts: [[2, 2], [2, 0]], t: 38.5 },
    { pts: [[4, -2], [8, -2], [8, 0]], t: 39.5 },
    { pts: [[2, 0], [2, -2]], t: 40.33 },
    { pts: [[4, 0], [6, 0]], t: 41 },
    { pts: [[2, 2], [8, 2], [8, 0]], t: 41.5 },
  ];

  // ---------------------------------------------------------------- the grid's cells (acts 3 and 5)
  const GI0 = -20, GJ0 = -7, GW = 41, GH = 15;
  const CELLS = [];
  for (let j = GJ0; j < GJ0 + GH; j++) for (let i = GI0; i < GI0 + GW; i++) {
    const key = kk(i, j);
    CELLS.push({ i, j, key, named: NAMED[key], ap1: i <= -3 || lane(i, j) || blocked(i, j) ? Infinity : 12.0 + q(Math.hypot(i / 2, j) * 0.05), ap2: 34.0 + q(Math.hypot((i - 5) / 2, j) * 0.05), drop: DROPS[key] });
  }
  // act 5 shows a fixed block of the grid; from 43 s the same block, cell for cell, is the field
  const PAGE_I = [-2, 11], PAGE_J = [-2, 2], inPage = (i, j) => i >= PAGE_I[0] && i <= PAGE_I[1] && j >= PAGE_J[0] && j <= PAGE_J[1];

  // ---------------------------------------------------------------- the palette: paper whites, warm greys, yellow down to deep ochre
  const PAL = ['#000000', '#171614', '#221d18', '#322a23', '#463b31', '#64574b', '#8a7f72', '#b9b0a2', '#e2dccf', '#f8f7f3',
    '#3e230d', '#6a3c13', '#94561a', '#bd7520', '#e09a2a', '#f5b82e', '#ffd43b', '#ffe89a'];
  const OFF = 1, PAPERI = 9, YELI = 16;
  const PALRGB = PAL.map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));
  const PAL32 = new Uint32Array(PALRGB.map(([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r));
  const LUT = new Uint8Array(32768); // nearest palette colour (not the ground colours) for any RGB, 5 bits a channel
  for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
    const R = r * 8.2, G = g * 8.2, B = b * 8.2; let best = 2, bd = Infinity;
    for (let k = 2; k < PAL.length; k++) { const [pr, pg, pb] = PALRGB[k], d = 2 * (R - pr) ** 2 + 4 * (G - pg) ** 2 + 3 * (B - pb) ** 2; if (d < bd) { bd = d; best = k; } }
    LUT[(r << 10) | (g << 5) | b] = best;
  }
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  // one step of a colour on its way from a to b (f of the way), as a palette colour: cells only ever take palette colours
  function stepTo(a, b, f) {
    if (f >= 1) return b;
    const A = PALRGB[a], B = PALRGB[b], c = [0, 1, 2].map((k) => Math.round(A[k] + (B[k] - A[k]) * f) >> 3);
    return LUT[(c[0] << 10) | (c[1] << 5) | c[2]];
  }

  // ---------------------------------------------------------------- the fine grid: every tile is 12 × 12 page pixels plus a 2-pixel gap
  const FF = 14, ECO = { cx: 5, p: 140 }, EF = ECO.p / FF; // 10 px a page pixel, 120 px a tile
  const tileOf = (u) => { const i = Math.floor((u + 7) / FF); return [i, u - FF * i]; }; // offset in -7..6; -7 and 6 are the gap
  const fsx = (c, u) => OX + ((u + 0.5) / FF - c.cx) * c.p, fsy = (c, v) => OY + ((v + 0.5) / FF) * c.p;
  // the field the butterfly lives on, at the ecosystem's camera: render pixel (x, y) is fine cell (U0 + x, V0 + y)
  const U0 = Math.floor((0 - OX) / EF + ECO.cx * FF - 0.5), V0 = Math.floor((0 - OY) / EF - 0.5);
  const RW = Math.ceil((1920 - OX) / EF + ECO.cx * FF - 0.5) - U0 + 1, RH = Math.ceil((1080 - OY) / EF - 0.5) - V0 + 1;
  const VIEW = [fsx(ECO, U0) - EF / 2, fsy(ECO, V0) - EF / 2, RW * EF, RH * EF];
  // the pages: each app is a 12 × 12 bitmap ('.' the page, '#' ink on it, 'y' yellow)
  const APPBMP = {
    list: ['............', '.#..######..', '............', '.#..#######.', '............', '.y..####....', '............', '.#..#####...', '............', '.#..######..', '............', '............'],
    chart: ['............', '............', '.........#..', '.........#..', '....#....#..', '....#..#.#..', '.#..#..#.#..', '.#..#..#.#..', '.#..#..#.#..', '.#..#..#.#..', '.##########.', '............'],
    cal: ['............', '.##########.', '............', '.#.#.#.#.#..', '............', '.#.#.#.y.#..', '............', '.#.#.#.#.#..', '............', '.#.#.#......', '............', '............'],
    bars: ['............', '.########...', '............', '.#####......', '............', '.##########.', '............', '.######.....', '............', '.yyy........', '............', '............'],
    notes: ['............', '.####..####.', '.####..####.', '.####..####.', '.####..####.', '............', '............', '.####..yyyy.', '.####..yyyy.', '.####..yyyy.', '.####..yyyy.', '............'],
    doc: ['............', '.######.....', '.######.....', '............', '.#########..', '............', '.########...', '............', '.#########..', '............', '.#####......', '............'],
    spark: ['............', '..........#.', '.........#..', '.....#..#...', '....#.#.#...', '...#...#....', '..#.........', '.#..........', '............', '.##########.', '............', '............'],
  };
  const KINDS = Object.keys(APPBMP);
  // an app's page drawn as pixels on its tile (the tile itself is drawn by the caller)
  function appIcon(ctx, kind, x, y, s) {
    if (s < 18) return;
    const q2 = s / 12, x0 = x - s / 2, y0 = y - s / 2, bmp = APPBMP[kind];
    for (let r = 0; r < 12; r++) for (let c = 0; c < 12; c++) { const ch = bmp[r][c]; if (ch === '.') continue; ctx.fillStyle = ch === 'y' ? YEL : PAPER; ctx.fillRect(x0 + c * q2, y0 + r * q2, q2, q2); }
    pixelGaps(ctx, x0, y0, s, 12);
  }
  const LVL_COL = (n, b) => { // a block's colour at a coarser level: yellow if most of it is, else a grey for how much ink it holds
    const f = n.d / (b * b); return n.y * 2 >= b * b * 0.5 && n.y >= n.d ? YEL : f < 0.18 ? INK : f < 0.42 ? '#b9b0a2' : f < 0.7 ? '#64574b' : PAPER;
  };
  function appDetail(ctx, kind, x, y, s, t0, t) { // the tile divides on the pulse until it is the page, the last step sweeping in from the top left
    const bmp = APPBMP[kind], x0 = Math.round(x - s / 2), y0 = Math.round(y - s / 2), S = Math.round(s), k = Math.floor((t - t0) / P + 1e-6);
    if (k >= 4 && t - t0 > 1.2) return appIcon(ctx, kind, x, y, s);
    const n = k <= 0 ? 1 : k === 1 ? 3 : 6, b = 12 / n, front = k >= 3 ? ((t - t0 - 3 * P) / 0.25) * 23 : -1, q = S / 12;
    for (let r = 0; r < 12; r += b) for (let c = 0; c < 12; c += b) {
      if (front >= 0) { // the page's own pixels, where the sweep has passed
        for (let rr = r; rr < r + b; rr++) for (let cc = c; cc < c + b; cc++) {
          if (rr + cc > front) continue; const ch = bmp[rr][cc]; if (ch === '.') continue; ctx.fillStyle = ch === 'y' ? YEL : PAPER; ctx.fillRect(x0 + cc * q, y0 + rr * q, q, q);
        }
      }
      let d = 0, yy = 0; for (let rr = r; rr < r + b; rr++) for (let cc = c; cc < c + b; cc++) { if (bmp[rr][cc] === '#') d++; if (bmp[rr][cc] === 'y') yy++; }
      const col = n === 1 ? INK : LVL_COL({ d, y: yy }, b); // whole, the tile keeps its own colour
      if (col === INK) continue;
      for (let rr = r; rr < r + b; rr++) for (let cc = c; cc < c + b; cc++) if (front < 0 || rr + cc > front) { ctx.fillStyle = col; ctx.fillRect(x0 + cc * q, y0 + rr * q, q, q); }
    }
    pixelGaps(ctx, x0, y0, S, front >= 0 ? 12 : n);
    if (front >= 0) pixelGaps(ctx, x0, y0, S, n); // the coarser grid stays until the sweep has passed (it is a subset of the fine one)
  }
  function pixelGaps(ctx, x0, y0, s, n) { // the hairline gaps between a tile's pixels
    const q2 = s / n; if (q2 < 4) return;
    const gw = Math.max(1, 0.16 * q2); ctx.fillStyle = PAPER;
    for (let k = 1; k < n; k++) { ctx.fillRect(x0 + k * q2 - gw / 2, y0, gw, s); ctx.fillRect(x0, y0 + k * q2 - gw / 2, s, gw); }
  }
  function pageColour(u, v) {
    const [i, a] = tileOf(u), [j, b] = tileOf(v);
    if (a === -7 || a === 6 || b === -7 || b === 6 || !inPage(i, j)) return 0;
    const kind = APPS[kk(i, j)]; if (!kind) return OFF;
    const ch = APPBMP[kind][b + 6][a + 6]; return ch === '#' ? 0 : ch === 'y' ? YELI : PAPERI;
  }

  // ---------------------------------------------------------------- the butterfly: three.js, wings painted on canvas, rendered at the grid's resolution
  // @lib three
  function wingPath(pts, W, H) { const s = K.spline(pts.map(([u, v]) => [u * W, v * H]), 4), p = new Path2D(); s.forEach(([x, y], k) => (k ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return { p, s }; }
  const FORE_PTS = [[0.03, 0.72], [0.14, 0.38], [0.36, 0.13], [0.66, 0.03], [0.92, 0.02], [0.99, 0.12], [0.96, 0.36], [0.88, 0.6], [0.73, 0.84], [0.56, 0.97], [0.3, 0.96], [0.1, 0.9], [0.03, 0.72]];
  const HIND_PTS = [[0.03, 0.1], [0.3, 0.02], [0.62, 0.05], [0.86, 0.19], [0.97, 0.38], [0.94, 0.56], [0.86, 0.73], [0.75, 0.87], [0.6, 0.98], [0.44, 0.96], [0.29, 0.85], [0.13, 0.62], [0.04, 0.34], [0.03, 0.1]];
  function paintWing(kind, under) { // features at least a cell wide (about 10 texels at the formed size), so they survive the grid
    const W = 512, H = kind === 'fore' ? 366 : 448, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), { p, s } = wingPath(kind === 'fore' ? FORE_PTS : HIND_PTS, W, H);
    const base = kind === 'fore' ? [0.04 * W, 0.8 * H] : [0.04 * W, 0.12 * H], dark = under ? '#5e5249' : '#1c120a';
    g.save(); g.clip(p);
    const rg = g.createRadialGradient(base[0], base[1], 8, base[0], base[1], W * 1.0);
    const stops = under ? [[0, '#5e5249'], [0.25, '#8a7f72'], [0.5, '#d8cdb4'], [0.75, '#efe6cf'], [1, '#c9b48a']]
      : [[0, '#2e1a0a'], [0.14, '#6a3c13'], [0.3, '#bd7520'], [0.46, '#f5b82e'], [0.62, '#ffd43b'], [0.8, '#ffe68a'], [1, '#f5b82e']];
    for (const [o, col] of stops) rg.addColorStop(o, col);
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
    // scale bands: soft darker stripes between the veins
    const ends = kind === 'fore' ? [[0.8, 0.05], [0.95, 0.2], [0.93, 0.42], [0.83, 0.65], [0.65, 0.9], [0.38, 0.97]] : [[0.62, 0.05], [0.9, 0.24], [0.95, 0.48], [0.83, 0.75], [0.6, 0.96], [0.3, 0.88]];
    const curve = (u, v) => { const ex = u * W, ey = v * H; return [ex, ey, (base[0] + ex) / 2 + (ey - base[1]) * 0.1, (base[1] + ey) / 2 - (ex - base[0]) * 0.1]; };
    g.lineCap = 'round';
    for (let k = 0; k < ends.length - 1; k++) { // a shadow band beside each vein
      const [u, v] = ends[k], [u2, v2] = ends[k + 1], [ex, ey, mx, my] = curve((u * 0.62 + u2 * 0.38), (v * 0.62 + v2 * 0.38));
      g.strokeStyle = under ? 'rgba(90,80,70,0.25)' : 'rgba(120,60,10,0.28)'; g.lineWidth = 26; g.beginPath(); g.moveTo(base[0], base[1]); g.quadraticCurveTo(mx, my, ex, ey); g.stroke();
    }
    g.strokeStyle = dark;
    for (const [u, v] of ends) { const [ex, ey, mx, my] = curve(u, v); g.lineWidth = 15; g.beginPath(); g.moveTo(base[0], base[1]); g.quadraticCurveTo(mx, my, ex, ey); g.stroke(); }
    if (kind === 'fore') { // the discal cell and its dark bar
      g.lineWidth = 14; g.beginPath(); g.moveTo(0.12 * W, 0.66 * H); g.quadraticCurveTo(0.34 * W, 0.34 * H, 0.52 * W, 0.4 * H); g.quadraticCurveTo(0.52 * W, 0.62 * H, 0.22 * W, 0.8 * H); g.closePath(); g.stroke();
      g.fillStyle = dark; g.beginPath(); g.ellipse(0.5 * W, 0.47 * H, 16, 34, 0.5, 0, 7); g.fill();
    }
    // the dark margin with a row of cream dots
    g.lineJoin = 'round'; g.strokeStyle = dark; g.lineWidth = 112; g.stroke(p);
    const outer = s.filter(([x, y]) => x > W * 0.3 && (kind === 'fore' ? !(y > H * 0.88 && x < W * 0.55) && !(y < H * 0.22 && x < W * 0.62) : y > H * 0.12));
    for (let k = 3; k < outer.length - 3; k += 11) {
      const [x, y] = outer[k], [x2, y2] = outer[k + 1], nx = -(y2 - y), ny = x2 - x, nl = Math.hypot(nx, ny) || 1;
      g.fillStyle = (k / 11) % 3 === 1 && !under ? '#ffd43b' : '#f3ecdc'; g.beginPath(); g.arc(x + (nx / nl) * 28, y + (ny / nl) * 28, 10, 0, 7); g.fill();
    }
    if (kind === 'fore') { // the apex: dark, with a band of pale spots
      g.fillStyle = dark; g.beginPath(); g.ellipse(0.86 * W, 0.13 * H, 0.22 * W, 0.17 * H, -0.45, 0, 7); g.fill();
      for (const [u, v, rr, col] of [[0.72, 0.14, 15, '#f3ecdc'], [0.8, 0.22, 17, '#ffd43b'], [0.88, 0.31, 14, '#f3ecdc'], [0.66, 0.24, 11, '#f3ecdc']]) { g.fillStyle = col; g.beginPath(); g.arc(u * W, v * H, rr, 0, 7); g.fill(); }
    } else { // the eye-spot: rings of dark, yellow, amber, black, and a highlight
      const ex = 0.6 * W, ey = 0.55 * H, R = (under ? 0.1 : 0.16) * W;
      for (const [f, col] of [[1, '#120c08'], [0.8, '#ffe68a'], [0.64, '#e09a2a'], [0.46, '#000000'], [0.17, '#f8f7f3']]) { g.fillStyle = col; g.beginPath(); g.arc(ex - (f < 0.2 ? R * 0.15 : 0), ey - (f < 0.2 ? R * 0.15 : 0), R * f, 0, 7); g.fill(); }
    }
    // the fuzzy base where the wing meets the body
    const fz = g.createRadialGradient(base[0], base[1], 0, base[0], base[1], W * 0.24); fz.addColorStop(0, under ? 'rgba(90,80,70,0.9)' : 'rgba(30,18,8,0.95)'); fz.addColorStop(1, 'rgba(30,18,8,0)');
    g.fillStyle = fz; g.fillRect(0, 0, W, H);
    g.restore();
    g.strokeStyle = '#0e0a07'; g.lineWidth = 10; g.stroke(p);
    return c;
  }
  let BF = null;
  function bfInit() {
    const cv = document.createElement('canvas'); cv.width = RW; cv.height = RH;
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, preserveDrawingBuffer: true, alpha: true });
    renderer.setPixelRatio(1); renderer.setSize(RW, RH, false); renderer.setClearColor(0x000000, 0); renderer.outputEncoding = THREE.sRGBEncoding;
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1920 / 1080, 0.1, 100);
    camera.position.set(0, 0, 8.46); camera.lookAt(0, 0, 0);
    camera.setViewOffset(1920, 1080, VIEW[0], VIEW[1], VIEW[2], VIEW[3]); // exactly the fine cells of the field
    scene.add(new THREE.HemisphereLight(0xfff6e0, 0x3a2a1a, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.95); key.position.set(-3, 4, 6); scene.add(key);
    const rim = new THREE.DirectionalLight(0xffe2a0, 0.35); rim.position.set(4, -2, -3); scene.add(rim);
    const tex = (c) => { const tx = new THREE.CanvasTexture(c); tx.encoding = THREE.sRGBEncoding; tx.magFilter = THREE.LinearFilter; tx.minFilter = THREE.LinearMipmapLinearFilter; return tx; };
    const mat = (c, side) => new THREE.MeshStandardMaterial({ map: tex(c), side, alphaTest: 0.5, transparent: false, roughness: 0.48, metalness: 0.0 });
    const foreTop = paintWing('fore', false), foreUnder = paintWing('fore', true), hindTop = paintWing('hind', false), hindUnder = paintWing('hind', true);
    const geoF = new THREE.PlaneGeometry(2.1, 1.5); geoF.translate(1.05, 0.5, 0.004);
    const geoH = new THREE.PlaneGeometry(1.6, 1.4); geoH.translate(0.8, -0.51, -0.004);
    const heading = new THREE.Group(), pitch = new THREE.Group(), bank = new THREE.Group(); heading.add(pitch); pitch.add(bank); scene.add(heading);
    const wings = [];
    for (const side of [1, -1]) for (const kind of ['fore', 'hind']) {
      const pivot = new THREE.Group(), flip = new THREE.Group(); pivot.position.set(side * 0.07, kind === 'fore' ? 0.02 : -0.02, 0); flip.scale.x = side; pivot.add(flip); bank.add(pivot);
      const geo = kind === 'fore' ? geoF : geoH, [top, under] = kind === 'fore' ? [foreTop, foreUnder] : [hindTop, hindUnder];
      flip.add(new THREE.Mesh(geo, mat(top, THREE.FrontSide))); flip.add(new THREE.Mesh(geo, mat(under, THREE.BackSide)));
      wings.push({ pivot, side, kind });
    }
    const fur = new THREE.MeshStandardMaterial({ color: 0x4a3c30, roughness: 0.95 }), dark = new THREE.MeshStandardMaterial({ color: 0x241c16, roughness: 0.8 });
    const seg = (r, sy, y, m) => { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m); s.scale.set(1, sy, 0.8); s.position.y = y; bank.add(s); return s; };
    seg(0.11, 1.7, 0.1, fur); seg(0.085, 4.6, -0.5, dark); seg(0.08, 1, 0.36, dark);
    for (const sd of [1, -1]) { // antennae with clubbed tips
      const a = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.95, 6), dark); a.position.set(sd * 0.2, 0.8, 0.02); a.rotation.z = -sd * 0.42; bank.add(a);
      const club = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), fur); club.position.set(sd * 0.4, 1.23, 0.02); bank.add(club);
    }
    BF = { renderer, scene, camera, heading, pitch, bank, wings, gl: renderer.getContext(), buf: new Uint8Array(RW * RH * 4), idx: new Uint8Array(RW * RH), rest: null, wing: null };
  }
  // where the butterfly is and how it holds its wings at time t: all from t
  const FORMED = 50.0, LIFT = 52.0, BLOOM = 56.0;
  const Y_REST = 0.36;
  // the last pass comes straight at the camera: on the downbeat at 56.0 its open wings fill the frame
  const FLIGHT = [[LIFT, 0, Y_REST, 0], [52.6, 1.5, 0.62, -2.4], [53.3, 2.8, 0.1, -4.6], [54.0, 0.9, -0.7, -2.2], [54.7, -0.85, -0.3, 0.9], [55.3, -0.5, 0.4, -1.2], [BLOOM, 0, 0.2, 5.6], [58, 0, 0.2, 5.6]];
  function track3(t) {
    const k = FLIGHT, n = k.length; if (t <= k[0][0]) return k[0].slice(1); if (t >= k[n - 1][0]) return k[n - 1].slice(1);
    let s = 0; while (t > k[s + 1][0]) s++;
    const a = k[Math.max(0, s - 1)], b = k[s], c = k[s + 1], d = k[Math.min(n - 1, s + 2)], u = K.ease.inOut((t - b[0]) / (c[0] - b[0])) * 0.35 + 0.65 * ((t - b[0]) / (c[0] - b[0])), u2 = u * u, u3 = u2 * u;
    return [1, 2, 3].map((i) => 0.5 * (2 * b[i] + (-a[i] + c[i]) * u + (2 * a[i] - 5 * b[i] + 4 * c[i] - d[i]) * u2 + (-a[i] + 3 * b[i] - 3 * c[i] + d[i]) * u3));
  }
  function flap(t) { // wing angle (radians, 0 = flat open); a slow beat at 50.5, then one a beat in flight, the downstroke ending on the beat
    if (t < 50.5 || t >= BLOOM) return 0;
    const [per, t0, amp] = t < 51.5 ? [1.0, 50.5, 0.9] : [0.5, 51.5, 1.2];
    const f = ((t - t0) / per) % 1, up = 0.56;
    return amp * (f < up ? K.ease.inOut(f / up) : 1 - K.ease.inOut((f - up) / (1 - up)));
  }
  function pose(t) {
    const [x, y, z] = track3(t), [x2, y2, z2] = track3(t + 0.05), vx = (x2 - x) / 0.05, vy = (y2 - y) / 0.05, vz = (z2 - z) / 0.05;
    const fl = K.smooth(LIFT - 0.2, LIFT + 0.4, t) * (1 - K.smooth(55.3, 55.85, t)), sp = Math.hypot(vx, vy);
    const head = fl * K.clamp(-Math.atan2(vx, Math.max(0.6, vy + 1.2)) * 0.9, -0.9, 0.9);
    const [x3, y3] = track3(t + 0.15), turn = ((x3 - x2) - (x2 - x)) * 4;
    const crouch = t >= 51.5 && t < LIFT ? -0.08 * Math.sin(Math.PI * K.inv(51.5, LIFT, t)) : 0, th = flap(t);
    return { x, y: y + crouch - 0.05 * th * fl, z, head, bank: fl * K.clamp(turn * 0.55 + vx * 0.04, -0.34, 0.34), pitch: fl * K.clamp(-vz * 0.08 + 0.15 * sp * 0.1, -0.45, 0.45), th };
  }
  function bfPose(t) {
    if (!BF) bfInit();
    const o = pose(t);
    BF.heading.position.set(o.x, o.y, o.z); BF.heading.rotation.set(0, 0, o.head); BF.pitch.rotation.set(o.pitch, 0, 0); BF.bank.rotation.set(0, o.bank, 0);
    for (const w of BF.wings) w.pivot.rotation.set(0, -w.side * (w.kind === 'fore' ? o.th : o.th * 0.88), 0);
  }
  // render the butterfly at t into palette indices (255 = not butterfly), one per fine cell of the field
  function bfRender(t) {
    bfPose(t);
    BF.renderer.render(BF.scene, BF.camera);
    const gl = BF.gl, buf = BF.buf, idx = BF.idx;
    gl.readPixels(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    for (let y = 0; y < RH; y++) {
      const row = (RH - 1 - y) * RW * 4;
      for (let x = 0; x < RW; x++) {
        const k = row + x * 4; if (buf[k + 3] < 128) { idx[y * RW + x] = 255; continue; }
        const d = (BAYER[((y + V0) & 3) * 4 + ((x + U0) & 3)] - 7.5) * 2.2;
        const r = K.clamp(buf[k] + d, 0, 255) >> 3, g = K.clamp(buf[k + 1] + d, 0, 255) >> 3, b = K.clamp(buf[k + 2] + d, 0, 255) >> 3;
        idx[y * RW + x] = LUT[(r << 10) | (g << 5) | b];
      }
    }
    return idx;
  }
  // the formed butterfly (cached): its colours, and when each cell of the field starts on its way to them
  const CONV = 46.0, QC_T = 44.5, RINGS_T = 43.0, EYES_T = 46.0;
  function bfRest() {
    if (BF && BF.rest) return BF.rest;
    const idx = bfRender(FORMED).slice(), N = RW * RH, dist = new Int16Array(N).fill(999), qq = [];
    for (let k = 0; k < N; k++) if (idx[k] !== 255) { dist[k] = 0; qq.push(k); }
    for (let h = 0; h < qq.length; h++) { const k = qq[h], x = k % RW, y = (k / RW) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= RW || yy >= RH) continue; const n = yy * RW + xx; if (dist[n] <= dist[k] + 1) continue; dist[n] = dist[k] + 1; qq.push(n); } }
    // the spots the wings grow from: the eye-spots, the apex spots, the body (projected into the field)
    const proj = (x, y) => { const v = new THREE.Vector3(x, y, 0); BF.bank.localToWorld(v); v.project(BF.camera); return [(v.x + 1) / 2 * RW - 0.5, (1 - v.y) / 2 * RH - 0.5]; };
    const spots = [[1.03, -0.6], [-1.03, -0.6], [1.75, 0.94], [-1.75, 0.94]].map(([x, y]) => proj(x, y)), body = [proj(0, 0.45), proj(0, -0.95)];
    const KI = new Float32Array(N), KO = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const x = k % RW, y = (k / RW) | 0;
      let dE = Infinity; for (const [sx, sy] of spots) dE = Math.min(dE, Math.hypot(x - sx, y - sy));
      const bx = body[0][0], by = Math.max(body[0][1], Math.min(body[1][1], y)), dB = Math.hypot(x - bx, y - by);
      if (idx[k] !== 255) KI[k] = CONV + 0.33 + P * Math.floor(Math.min(dE, dB * 1.2) / 2.6); // a ripple from the spots and the body
      else KO[k] = CONV + P * Math.max(0, Math.floor((60 - Math.min(dist[k], 60)) / 4.5 + 2 * (1 + Math.sin(dE * 0.5)))); // rings close in from the edges
    }
    BF.rest = { idx, dist, KI, KO, spots, body };
    return BF.rest;
  }

  // ---------------------------------------------------------------- the field: every fine cell, its colour from t; only palette colours, only in steps
  const SOURCES = Object.keys(NAMED).map((k) => k.split(',').map(Number)).map(([i, j]) => [FF * i - 0.5, FF * j - 0.5]);
  const DIRS = Array.from({ length: 7 }, (_, k) => [Math.cos((k * Math.PI) / 7), Math.sin((k * Math.PI) / 7), k * 1.3]);
  const RAMP_A = [10, 11, 12, 13, 14, 15, 16, 17], RAMP_B = [3, 4, 5, 6, 7, 8, 9, 17], QC_C = [FF * 5 - 0.5, -0.5];
  function quasi(i, j, tq) { let v = 0; const kq = (2 * Math.PI) / 9; for (const [c, s, ph0] of DIRS) v += Math.cos(kq * (i * c + j * s) + ph0 + tq * 1.9); return v / 7; }
  // the page, and the quasicrystal once its front has passed (no rings): what a cell holds at time tt
  function baseColour(u, v, tt) {
    if (tt >= QC_T) {
      const r = Math.hypot(u - QC_C[0], (v - QC_C[1]) * 1.3), front = 7 * Math.floor((tt - QC_T) / P + 1e-6);
      if (r < front) {
        const tq = Math.floor(tt / P + 1e-6) * P, w = quasi(u, v, tq);
        if (w <= 0.12) return OFF;
        const lvl = Math.min(7, Math.floor(((w - 0.12) / 0.75) * 8)), sweep = u * 0.8 + v * 0.5 - (tt - 45.5) * 34;
        return r > front - 7 ? YELI : (Math.floor(sweep / 60) % 2 === 0 ? RAMP_A : RAMP_B)[lvl];
      }
    }
    return pageColour(u, v);
  }
  // rings, drawn once a frame into a buffer over the visible cells: from every app on every beat, then from the wings' spots
  const RB = { on: false, hits: null, age: null, mark: null, stamp: 0, u0: 0, v0: 0, w: 0, h: 0 };
  function ringsInto(t, u0, v0, w, h, rest) {
    const apps = t >= RINGS_T && t < 47.0, eyes = rest && t >= EYES_T && t < 48.6;
    RB.on = apps || eyes; if (!RB.on) return;
    if (!RB.hits || RB.hits.length < w * h) { RB.hits = new Uint8Array(w * h); RB.age = new Uint8Array(w * h); RB.mark = new Int32Array(w * h); }
    RB.hits.fill(0, 0, w * h); RB.age.fill(11, 0, w * h); RB.u0 = u0; RB.v0 = v0; RB.w = w; RB.h = h; RB.stamp = (RB.stamp + 1) % 2000;
    let id = 0;
    const ring = (cu, cv, n, Rr) => {
      id++;
      const steps = Math.ceil(2 * Math.PI * (Rr + 1) * 2.5);
      for (const rr of [Rr - 0.4, Rr + 0.4]) for (let k = 0; k < steps; k++) {
        const a = (k / steps) * 2 * Math.PI, ci = Math.round(cu + rr * Math.cos(a)) - u0, ri = Math.round(cv + rr * Math.sin(a)) - v0;
        if (ci < 0 || ri < 0 || ci >= w || ri >= h) continue;
        const c = ri * w + ci, tag = RB.stamp * 1000 + id; if (RB.mark[c] === tag) continue;
        RB.mark[c] = tag; RB.hits[c]++; if (n < RB.age[c]) RB.age[c] = n;
      }
    };
    if (apps) for (let b = 0; b < 7; b++) { const t0 = RINGS_T + b * 0.5; if (t < t0) break; const n = Math.floor((t - t0) / P + 1e-6); if (n > 11) continue; for (const [cu, cv] of SOURCES) ring(cu, cv, n, 3 * n + 1); }
    if (eyes) for (let b = 0; b < 4; b++) { const t0 = EYES_T + b * 0.5; if (t < t0) break; const n = Math.floor((t - t0) / P + 1e-6); if (n > 9) continue; for (const [sx, sy] of rest.spots) ring(sx + U0, sy + V0, n, 2.5 * n + 1); }
  }
  function ringColour(u, v, col) {
    if (!RB.on) return col;
    const ri = v - RB.v0, ci = u - RB.u0; if (ri < 0 || ci < 0 || ri >= RB.h || ci >= RB.w) return col;
    const k = ri * RB.w + ci, h = RB.hits[k], ag = RB.age[k];
    return h >= 3 ? PAPERI : h === 2 ? (ag < 4 ? 17 : ag < 8 ? 8 : 7) : h === 1 ? [16, 16, 15, 15, 14, 14, 13, 12, 12, 11, 10, 10][ag] : col;
  }
  // the ecosystem up to the bloom: page → rings → quasicrystal → each cell stepping to the butterfly's colour
  function ecoColour(u, v, t, rest, live) {
    const x = u - U0, y = v - V0, inR = x >= 0 && y >= 0 && x < RW && y < RH, k = y * RW + x;
    if (live) return inR && live[k] > 1 && live[k] !== 255 ? live[k] : -1; // the butterfly's own coloured cells only; near-black ones count as empty
    if (rest && inR && t >= CONV) {
      const T = rest.idx[k];
      if (T !== 255) { const ki = rest.KI[k]; if (t >= ki) { const n = Math.floor((t - ki) / P + 1e-6) + 1, s = baseColour(u, v, ki); return n >= 4 ? (T > 1 ? T : -1) : stepTo(s, T, n / 4); } }
      else { const ko = rest.KO[k]; if (t >= ko) { const n = Math.floor((t - ko) / P + 1e-6) + 1, s = baseColour(u, v, ko); return n >= 3 || s <= OFF ? -1 : stepTo(s, 2, n / 3); } } // outside the wings: steps to dark, then is gone
    }
    const cc = ringColour(u, v, baseColour(u, v, t)); return cc <= OFF ? -1 : cc; // dark and empty cells: nothing
  }

  // ---------------------------------------------------------------- the bloom: the wings are made of the team's apps, and they come alive
  const PEOPLE_AT = { '-2,0': 'maya', '2,0': 'sam', '0,-2': 'lee', '0,2': 'ana' }, BOTS_AT = { '-2,-2': 0, '2,-2': 1, '-2,2': 2, '2,2': 3 };
  const BC = [Math.round(fsx(ECO, 0) === 0 ? 0 : (960 - OX) / EF + ECO.cx * FF - 0.5), Math.round((540 - OY) / EF - 0.5)]; // the frame's centre, in fine cells
  const TILEC = new Map();
  function wingFrame() { if (!BF) bfInit(); if (!BF.wing) { const w = bfRender(BLOOM).slice(); BF.wing = w; } return BF.wing; }
  function tileBase(i, j) { // a tile's colour: the wing under it at the bloom, or (beyond the frame then) a warm city light
    const key = i * 1000 + j; if (TILEC.has(key)) return TILEC.get(key);
    const W = wingFrame(); let r = 0, g = 0, b = 0, n = 0;
    for (let bb = -6; bb < 6; bb++) for (let aa = -6; aa < 6; aa++) {
      const x = FF * i + aa - U0, y = FF * j + bb - V0; if (x < 0 || y < 0 || x >= RW || y >= RH) continue;
      const c = W[y * RW + x]; if (c === 255) continue; const [cr, cg, cb] = PALRGB[c]; r += cr; g += cg; b += cb; n++;
    }
    let col;
    if (n > 72) col = LUT[((r / n) >> 3 << 10) | ((g / n) >> 3 << 5) | ((b / n) >> 3)];
    else { const w = quasi(i * 2.3, j * 2.3, 0), hsh = K.hash(i, j, 91); col = hsh < 0.12 ? 3 : w > 0.3 ? [15, 16, 14][Math.floor(hsh * 3)] : w > -0.2 ? [12, 13, 14, 8][Math.floor(hsh * 4)] : [10, 11, 5, 4][Math.floor(hsh * 4)]; }
    TILEC.set(key, col); return col;
  }
  const SHADE = [0, 1, 5, 6, 7, 7, 3, 4, 5, 6, 13, 14, 15, 10, 11, 12, 12, 13];
  // a living app: its pixels from its kind and the pulse
  function appPixel(kind, a, b, s, hsh) { // a, b in 0..11; returns 0 page, 1 ink, 2 yellow
    const st = s + Math.floor(hsh * 12);
    if (a === 0 || a === 11 || b === 0 || b === 11) return 0;
    if (kind === 'list') { if (b % 2 === 0) return 0; const row = (b - 1) / 2, len = 4 + ((row * 3 + st) % 6); if (a === 1) return row === st % 5 ? 2 : 1; return a >= 3 && a < 3 + len ? (row === st % 5 ? 2 : 1) : 0; }
    if (kind === 'chart') { if (b === 10) return 1; const bar = [1, 4, 7, 9].indexOf(a); if (bar < 0) return 0; const h = 3 + ((st + bar * 3) % 7); return b >= 10 - h ? (bar === st % 4 ? 2 : 1) : 0; }
    if (kind === 'cal') { if (b === 1) return 1; if (a % 2 === 0 || b % 2 === 0 || b < 3) return 0; const n = ((b - 3) / 2) * 5 + (a - 1) / 2; return n < st % 21 ? 2 : 1; }
    if (kind === 'bars') { if (b % 2 === 0) return 0; const row = (b - 1) / 2, len = 2 + ((st + row * 4) % 9); return a < 1 + len ? (row === 4 ? 2 : 1) : 0; }
    if (kind === 'notes') { const q2 = (a < 6 ? 0 : 1) + (b < 6 ? 0 : 2); if (a === 5 || a === 6 || b === 5 || b === 6) return 0; return q2 === st % 4 ? 2 : 1; }
    if (kind === 'doc') { if (b % 2 === 1 || b === 0) return 0; const len = Math.min(10, 3 + ((st * 2 + b) % 9)); return a <= len ? (b === 2 ? 1 : 1) : 0; }
    const c = a + st, hgt = 5 + Math.round(3 * Math.sin(c * 0.9)); return b === 10 ? 1 : b === hgt ? 2 : 0; // spark: a line scrolling
  }
  // the connections: a light running along the gaps between two apps
  const LINKS2 = Array.from({ length: 30 }, (_, k) => { const i = -10 + Math.floor(K.hash(k, 1, 93) * 20), j = -5 + Math.floor(K.hash(k, 2, 93) * 8), di = (K.hash(k, 3, 93) < 0.5 ? -1 : 1) * (1 + Math.floor(K.hash(k, 4, 93) * 3)), dj = (K.hash(k, 5, 93) < 0.5 ? -1 : 1) * (1 + Math.floor(K.hash(k, 6, 93) * 2)); return { i, j, i2: i + di, j2: Math.min(3, j + dj), t0: 56.67 + K.hash(k, 7, 93) * 1.5, per: 1.5 + K.hash(k, 8, 93) }; });
  const LIT = new Map();
  function linksInto(t) {
    LIT.clear(); if (t < 56.67) return;
    for (const L of LINKS2) {
      if (t < L.t0) continue;
      const ph0 = ((t - L.t0) % L.per) / L.per; if (ph0 > 0.6) continue;
      const vy = FF * L.j + 6, ux = FF * L.i2 + 6, path = [];
      for (let u = FF * L.i; L.i2 > L.i ? u <= ux : u >= ux; u += L.i2 > L.i ? 1 : -1) path.push([u, vy]);
      for (let v = vy; L.j2 > L.j ? v <= FF * L.j2 : v >= FF * L.j2; v += L.j2 > L.j ? 1 : -1) path.push([ux, v]);
      const head = Math.floor((ph0 / 0.6) * (path.length + 8));
      for (let k = 0; k < 8; k++) { const c = path[head - k]; if (c) LIT.set(c[0] * 4096 + c[1], [16, 17, 15, 14, 13, 12, 11, 10][k]); }
    }
  }
  function mosaicColour(u, v, t) {
    const [i, a] = tileOf(u), [j, b] = tileOf(v), s = Math.floor((t - BLOOM) / P + 1e-6);
    if (a === -7 || a === 6 || b === -7 || b === 6) { const l = t < FOLD ? LIT.get(u * 4096 + v) : 0; return l || 0; }
    if (j > 3) return 0;
    const key = kk(i, j), who = PEOPLE_AT[key], bot = BOTS_AT[key], aa = a + 6, bb = b + 6;
    if (who) { const ch = PEOPLE[who][bb] ? PEOPLE[who][bb][aa] : '.'; return ch === '#' ? PAPERI : ch === 'm' ? 7 : ch === 'y' ? YELI : 2; }
    if (bot !== undefined) { const ch = bb < 12 && aa >= 1 && aa < 10 ? BOTS[bot][bb][aa - 1] : '.'; return ch === '#' ? 8 : ch === 'e' ? YELI : 2; }
    const hsh = K.hash(i, j, 97), kind = APPS[key] || KINDS[Math.floor(hsh * KINDS.length)];
    let base = tileBase(i, j);
    if (K.hash(i, j, s) < 0.06) base = SHADE[SHADE[base]] === base ? base : Math.min(17, base + 1); // a shimmer on the pulse
    const px = appPixel(kind, aa, bb, s, hsh);
    return px === 0 ? base : px === 2 ? YELI : SHADE[base];
  }
  function bloomColour(u, v, t, wing) {
    const n = Math.floor((t - BLOOM) / P + 1e-6), R = 9 * n + 1.5 * n * n, d = Math.hypot(u - BC[0], (v - BC[1]) * 1.25);
    const [, a] = tileOf(u), [j, b] = tileOf(v), gap = a === -7 || a === 6 || b === -7 || b === 6;
    if (d >= R - 9 || (!gap && d >= R - 14)) { // ahead of the wave, and a beat behind it: still the wings
      if (d >= R - 3 && d < R) return 17;
      if (gap && d < R) return 0;
      const x = u - U0, y = v - V0; return x >= 0 && y >= 0 && x < RW && y < RH && wing[y * RW + x] !== 255 ? wing[y * RW + x] : 0;
    }
    return mosaicColour(u, v, t);
  }
  const FLD = { c: null, g: null, img: null, w: 0, h: 0 };
  function drawField(ctx, t) {
    const c = cam(t), f = c.p / FF;
    const uMin = Math.floor((0 - OX) / f + c.cx * FF - 0.5), uMax = Math.ceil((1920 - OX) / f + c.cx * FF - 0.5);
    const vMin = Math.floor((0 - OY) / f - 0.5), vMax = Math.ceil((1080 - OY) / f - 0.5), w = uMax - uMin + 1, h = vMax - vMin + 1;
    if (!FLD.c) { FLD.c = document.createElement('canvas'); FLD.g = FLD.c.getContext('2d'); }
    if (FLD.w !== w || FLD.h !== h) { FLD.c.width = w; FLD.c.height = h; FLD.w = w; FLD.h = h; FLD.img = FLD.g.createImageData(w, h); }
    const px = new Uint32Array(FLD.img.data.buffer);
    const bloom = t >= BLOOM, rest = !bloom && t >= CONV - 0.01 ? bfRest() : null, live = !bloom && t >= FORMED ? bfRender(t) : null, wing = bloom ? wingFrame() : null;
    if (!bloom) ringsInto(t, uMin, vMin, w, h, rest); else { RB.on = false; linksInto(t); }
    const textOn = (t < FORMED + 0.4) || (t >= 59.33 && t < 62.7);
    for (let v = vMin; v <= vMax; v++) {
      const sy = fsy(c, v), row = (v - vMin) * w, mask = textOn && sy > 850;
      for (let u = uMin; u <= uMax; u++) { const ci = mask ? -1 : bloom ? bloomColour(u, v, t, wing) : ecoColour(u, v, t, rest, live); px[row + u - uMin] = ci < 0 ? 0 : PAL32[ci]; }
    }
    FLD.g.putImageData(FLD.img, 0, 0);
    const gw = Math.max(1, 0.16 * f);
    if (bloom) { // the city: every cell drawn, the gaps in the ground colour
      ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(FLD.c, fsx(c, uMin) - f / 2, fsy(c, vMin) - f / 2, w * f, h * f); ctx.restore();
      ctx.fillStyle = PAPER;
      for (let u = uMin; u <= uMax + 1; u++) ctx.fillRect(fsx(c, u) - f / 2 - gw / 2, 0, gw, 1080);
      for (let v = vMin; v <= vMax + 1; v++) ctx.fillRect(0, fsy(c, v) - f / 2 - gw / 2, 1920, gw);
      return;
    }
    // the convergence and the butterfly: the cells at screen size on their own layer, the gaps between them cut out, so empty cells and gaps alike show the black beneath
    if (!FLD.L) { FLD.L = document.createElement('canvas'); FLD.L.width = 1920; FLD.L.height = 1080; FLD.lg = FLD.L.getContext('2d'); }
    const lg = FLD.lg; lg.clearRect(0, 0, 1920, 1080); lg.imageSmoothingEnabled = false;
    lg.drawImage(FLD.c, fsx(c, uMin) - f / 2, fsy(c, vMin) - f / 2, w * f, h * f);
    lg.globalCompositeOperation = 'destination-out'; lg.fillStyle = '#000';
    for (let u = uMin; u <= uMax + 1; u++) lg.fillRect(fsx(c, u) - f / 2 - gw / 2, 0, gw, 1080);
    for (let v = vMin; v <= vMax + 1; v++) lg.fillRect(0, fsy(c, v) - f / 2 - gw / 2, 1920, gw);
    lg.globalCompositeOperation = 'source-over';
    ctx.drawImage(FLD.L, 0, 0);
  }

  // ---------------------------------------------------------------- the grid (act 3, and act 5's pages)
  const FIELD_T = 43.0, FOLD = 62.0;
  function fillAt(c, t) {
    if (t < 34) return c.key === '3,0' && t >= 16.5 && t < 20.0 ? { s: 1 } : null; // act 3: the app at its own cell
    if (c.key === '2,0') return t >= 34.5 ? { s: 1 } : null;
    if (c.drop) {
      if (t < c.drop - 2 * P) return null;
      if (t < c.drop) { const u = K.ease.in(K.inv(c.drop - 2 * P, c.drop, t)); return { s: 1 + 0.4 * (1 - u), dy: -0.5 * (1 - u), shadow: u }; }
      const dt = t - c.drop, k = Math.exp(-dt * 9) * Math.cos(dt * 38) * 0.1; return { s: 1, sx: 1 + k, sy: 1 - k };
    }
    return null;
  }
  function drawGrid(ctx, t) {
    const vis1 = t >= 12.0 && t < 20.4, vis2 = t >= 34.0 && t < FOLD;
    if (!vis1 && !vis2) return;
    if (t >= FIELD_T) return drawField(ctx, t);
    const c = cam(t), ts = (vis2 ? 12 / FF : 0.84) * c.p, [x0c, y0c, x1c, y1c] = REG;
    const outlines = new Path2D(), fills = new Path2D(), special = [], pages = [];
    const shrink1 = 1 - ph(t, 20.0, 2, K.ease.in);
    for (const ce of CELLS) {
      let [x, y] = W2S(c, ce.i, ce.j);
      if (vis1 && (x - ts / 2 < x0c - 1 || x + ts / 2 > x1c + 1 || y - ts / 2 < y0c - 1 || y + ts / 2 > y1c + 1)) continue;
      if (vis2 && !inPage(ce.i, ce.j)) continue;
      const ap = vis1 ? ce.ap1 : ce.ap2;
      if (t < ap) continue;
      if (vis1 && t > 16 && t < 17.2 && Math.abs(ce.i - 3) <= 2 && Math.abs(ce.j) <= 2) { // the snap's ripple
        const d = Math.max(Math.abs(ce.i - 3), Math.abs(ce.j));
        if (d > 0) { const dt = t - 16 - (d - 1) * 0.05; if (dt > 0) { const m = Math.exp(-dt * 7) * Math.sin(dt * 26) * 9 / d, n = Math.hypot(ce.i - 3, ce.j); x += ((ce.i - 3) / n) * m; y += (ce.j / n) * m; } }
      }
      const os = ts * ph(t, ap, 2, K.ease.out) * (vis1 ? shrink1 : 1 - ph(t, FIELD_T - 0.55 + 0.03 * Math.hypot(ce.i - 5, ce.j * 1.6), 2, K.ease.in));
      if (os > 1) { outlines.rect(x - os / 2, y - os / 2, os, os); if (vis2) pages.push([x, y, os]); }
      const f = fillAt(ce, t);
      if (!f) continue;
      const sx = ts * f.s * (f.sx ?? 1), sy = ts * f.s * (f.sy ?? 1), yy = y + (f.dy || 0) * c.p;
      special.push({ ce, x, y: yy, gy: y, sx, sy, f, ts });
    }
    if (vis2) { ctx.fillStyle = PAL[OFF]; ctx.fill(outlines); for (const [x, y, s] of pages) pixelGaps(ctx, x - s / 2, y - s / 2, s, 12); } // the apps act sits on its grid; elsewhere, no underlay
    for (const s of special) {
      if (s.f.shadow !== undefined) { ctx.fillStyle = GLOW + (0.08 * s.f.shadow) + ')'; ctx.fillRect(s.x - s.ts / 2 - 4, s.gy - s.ts / 2 - 4, s.ts + 8, s.ts + 8); }
      ctx.fillStyle = INK; ctx.fillRect(s.x - s.sx / 2, s.y - s.sy / 2, s.sx, s.sy);
      if (s.ce.named || (t < 34 && s.ce.key === '3,0')) appDetail(ctx, t < 34 ? 'list' : APPS[s.ce.key], s.x, s.y, s.sx, t < 34 ? -99 : s.ce.key === '2,0' ? 34.5 : s.ce.drop + 2 * P, t); // in act 3 it is already the page
    }
  }

  // ---------------------------------------------------------------- the place (a ring of squares; the slot only at the end)
  const MARK_CELLS = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2]]; // the slot: a 3 × 3 square without its two left-middle cells
  function hub(ctx, t) { // the OpenBelt mark; it lights while something passes through it
    if (t < 1.5 || t >= 20.5) return;
    const out = 1 - ph(t, 20.17, 2, K.ease.in);
    let glow = 0;
    for (let k = 0; k < 5; k++) glow = Math.max(glow, 1 - K.smooth(0, 0.5, t - (lineT(k) + 3 * P)) - (t < lineT(k) + 3 * P ? 1 : 0));
    for (const t0 of [8.33, 12.17, 17.0]) if (t >= t0) glow = Math.max(glow, 1 - K.smooth(0, 0.45, t - t0));
    if (ACC >= 2.5 && ACC < AL) glow = Math.max(glow, 1 - K.smooth(0, 0.45, ACC - 2.5));
    glow = Math.max(0, glow);
    // the hub is the mark: its seven cells grow in one after another and close into the slot; it brightens as something passes through
    // the hub: a square tile like an app icon, the mark centred in it; the tile scales in, then the mark's cells grow in;
    // it brightens (mark to paper, the tile a step lighter) while something passes through. The tile is a plain
    // square: solid fill, corners rounded 22% like the brand's tile, no border.
    const tg = ph(t, 1.5, 3, K.ease.outBack) * out, T0 = HUB * tg;
    if (T0 > 1) {
      const g = Math.max(0, glow);
      ctx.fillStyle = `rgb(${Math.round(32 + 12 * g)},${Math.round(32 + 12 * g)},${Math.round(32 + 12 * g)})`; // #202020, lifting to #2c2c2c on a pass
      ctx.beginPath(); ctx.roundRect(Math.round(OX - T0 / 2), Math.round(OY - T0 / 2), Math.round(T0), Math.round(T0), BRAND.tileRadius * T0); ctx.fill();
    }
    const MK = BRAND.markRatio * HUB, cs = MK / 3, whole = t >= 1.5 + 2 * P + 6 * P * 0.3 + 2 * P && out >= 1;
    const mark = (col) => {
      if (whole) return K.slot(ctx, Math.round(OX - MK / 2), Math.round(OY - MK / 2), Math.round(MK), col);
      ctx.fillStyle = col; MARK_CELLS.forEach(([i, j], k) => { const g = ph(t, 1.5 + 2 * P + k * P * 0.3, 2, K.ease.out) * out, z = cs * g * tg; if (z > 0.5) ctx.fillRect(OX - MK / 2 + (i + 0.5) * cs - z / 2, OY - MK / 2 + (j + 0.5) * cs - z / 2, z, z); });
    };
    mark(INK); // paper-white, like the tools and the robots
    if (glow > 0.01) { ctx.save(); ctx.globalAlpha = glow; mark('#ffffff'); ctx.restore(); } // a pass: briefly pure white
  }
  const RP = 52;
  const HUB = 200, HUB_TOP = OY - HUB / 2, MOUTH_X = OX - HUB / 2; // the hub's tile; every line ends at its edges: tools on the top, robots at the left middle, the app at the right middle

  // ---------------------------------------------------------------- Maya
  const MX = 150, MY = 800, MPX = 12, TPX2 = 11, MAYA_C = [MX, MY - 8.5 * MPX], Z0 = 2.0;
  function mayaPose(t) {
    const pose = { blink: blinkAt(t, 0), breathe: breathe(t) }, alt = (rate) => Math.floor(t * rate) % 2 === 0;
    if (t >= 0.17 && t < 0.83) pose.arms = alt(6) ? 'waveA' : 'waveB';
    else if ((t >= 4.33 && t < 4.83) || (t >= 16.17 && t < 16.83)) { pose.arms = 'cheer'; pose.breathe = false; }
    else if (t >= 11.33 && t < 11.9) pose.arms = 'waveA';
    else if (t < 0.17) pose.arms = 'down';
    if (ACC > 0 && ACC < AL) pose.arms = (ACC > 0.95 && ACC < 1.3) || (ACC > 1.45 && ACC < 1.8) ? 'waveA' : ACC > 2.6 && ACC < 3.1 ? 'cheer' : 'down';
    return pose;
  }
  function maya(ctx, t) { // acts 1-3, bottom left; she walks to her place in the team at 20.0
    if (t >= 21.0) return;
    if (t < 20.0) {
      const hop = (t >= 4.33 && t < 4.83) || (t >= 16.17 && t < 16.83) ? -Math.abs(Math.sin((t % 0.25) / 0.25 * Math.PI)) * 2 * MPX : 0;
      person(ctx, 'maya', MX, MY + hop, MPX, mayaPose(t));
      return;
    }
    const u = K.inv(20.0, 21.0, t);
    person(ctx, 'maya', K.lerp(MX, TEAM[0].x, K.ease.inOut(u)), K.lerp(MY, FEET, u), K.lerp(MPX, TPX2, u), { walk: Math.floor(t * 8) % 2 === 0, arms: Math.floor(t * 8) % 2 === 0 ? 'walk' : 'down' });
  }
  // what she asks for: a bubble with an app in it, which flies to her first agent
  function ask(ctx, t) {
    if (t < 11.33 || t >= 12.05) return;
    const bx = MX + 26, by = MY - 17 * MPX - 70, px = 8;
    if (t < 11.85) {
      const g = ph(t, 11.33, 2, K.ease.outBack), s = px * g; if (s < 0.5) return;
      spr(ctx, BUBBLE, bx - 6.5 * s, by - 5 * s, s);
      ctx.fillStyle = INK; ctx.fillRect(bx - 4 * s, by - 4 * s, 8 * s, 6 * s); appIcon(ctx, 'list', bx, by - 1 * s, 6.2 * s);
      return;
    }
    const u = K.ease.inOut(K.inv(11.85, 12.05, t)), [x1, y1] = [BOTX + 60, agY(0)];
    dot(ctx, K.lerp(bx, x1, u), K.lerp(by, y1, u) - 80 * Math.sin(Math.PI * u), 18);
  }

  // ---------------------------------------------------------------- her tools, and her agents
  const TX = [480, 720, 960, 1200, 1440], TYc = 86, TPX = 12;
  const toolIn = (k) => 1.33 + k * P, lineT = (k) => 2.0 + k * 2 * P, GY = 192;
  const accU = (a0) => K.ease.inOut(K.inv(a0, a0 + 0.33, ACC));
  function toolPts(k) {
    const tx = TX[k], ex = OX + (k - 2) * 36, lane = k === 2 ? null : k === 1 || k === 3 ? 230 : 254, y0 = TYc + 4.5 * TPX + 4;
    return lane === null ? [[tx, y0], [tx, HUB_TOP]] : [[tx, y0], [tx, lane], [ex, lane], [ex, HUB_TOP]];
  }
  function tools(ctx, t) {
    if (t < 1.0 || t >= 20.6) return;
    const out = ph(t, 20.0, 2, K.ease.in);
    for (let k = 0; k < 5; k++) {
      const pts = toolPts(k), lt = lineT(k);
      if (t >= lt) {
        const o1 = ph(t, lt, 3, K.ease.inOut), L = polyLen(pts), dg = (GY - pts[0][1]) / L, cut = (a0, a1, col = WIRE) => { if (a1 - a0 > 0.002) strokePts(ctx, polyCut(pts, a0 * L, a1 * L), WW, col); };
        const lock = k === 2 ? accU(1.17) : 0, eye = k === 1 && ACC >= 1.67;
        if (lock > 0) { const c = dg + (1 - dg) * (1 - lock); cut(out, Math.min(o1, c)); cut(Math.max(out, c), o1, '#2a2a2a'); }
        else if (eye) { cut(out, Math.min(o1, dg)); ctx.save(); ctx.setLineDash([7, 9]); cut(Math.max(out, dg), o1, 'rgba(160,160,160,0.7)'); ctx.restore(); }
        else cut(out, o1);
        if (t >= lt + 3 * P && out === 0 && !lock) arrow(ctx, pts, 5);
      }
      // pulses down the lines (8.0) and the app reaching two tools back up them (17.17)
      if (t >= 8.0 && t < 8.33) pulse(ctx, pts, K.ease.in(K.inv(8.0, 8.33, t)));
      if ((k === 0 || k === 1) && t >= 17.17 && t < 17.5) { const u = 1 - K.ease.inOut(K.inv(17.17, 17.5, t)), L = polyLen(pts); strokePts(ctx, polyCut(pts, u * L, Math.min(L, u * L + 110)), 3, INK); const [x, y] = polyAt(pts, u * L); dot(ctx, x, y, 12); }
      // in the access beat: only what is allowed goes through (all bright, read dim, none stops at its lock)
      if (ACC >= 2.17 && ACC < 2.5) {
        const L = polyLen(pts), u = K.ease.in(K.inv(2.17, 2.5, ACC)), dgd = GY - pts[0][1];
        if (k === 2) { if (u * L < dgd - 20) pulse(ctx, pts, u); }
        else pulse(ctx, pts, u, 12, k === 1);
      }
    }
    // the gates: they appear on every line, then the admin sets two of them
    if (ACC >= 0.33) for (let k = 0; k < 5; k++) {
      const g0 = ph(ACC, 0.33 + k * 0.08, 2, K.ease.outBack) * (1 - ph(t, 20.0, 2, K.ease.in)), x = TX[k];
      if (g0 <= 0.02) continue;
      if (k === 2 && ACC >= 1.17) gate(ctx, 'lock', x, GY, 6 * g0 * (1 + 0.25 * Math.sin(Math.PI * K.inv(1.17, 1.4, ACC))));
      else if (k === 1 && ACC >= 1.67) { const sh = 1 - ph(ACC, 1.67, 2, K.ease.in); if (sh > 0.02) gate(ctx, 'on', x, GY, 6 * g0 * sh); }
      else { const sh = 1 - ph(ACC, 3.33 + k * 0.05, 2, K.ease.in); if (sh > 0.02) gate(ctx, 'on', x, GY, 6 * g0 * sh); }
    }
    // each icon comes out of Maya and flies up to its place
    for (let k = 0; k < 5; k++) {
      const t0 = toolIn(k), u = K.inv(t0, t0 + 4 * P, t); if (t < t0) continue;
      const e = K.ease.out(u), x = K.lerp(MAYA_C[0], TX[k], e), y = K.lerp(MAYA_C[1] - 60, TYc, e);
      const g = (0.5 + 0.5 * Math.min(1, u * 2)) * (1 - ph(t, 20.0 + k * P * 0.5, 2, K.ease.in));
      toolIcon(ctx, k, x, y, TPX * g, (k === 0 || k === 1) && t >= 17.5 && t < 17.95, k === 2 && accU(1.17) > 0.5);
    }
  }
  const agY = (r) => OY + (r - 2) * 96, agIn = (r) => 6.0 + r * P * 0.5, TRUNK = 680, PORT = 420, BOTX = 330, BPX = 6;
  const portPts = (r) => [[MOUTH_X, OY], [TRUNK, OY], [TRUNK, agY(r)], [PORT, agY(r)]];
  function agents(ctx, t) {
    if (t < 6.0 || t >= 20.6) return;
    const out = ph(t, 20.0, 2, K.ease.in);
    for (let r = 0; r < 5; r++) {
      const y = agY(r), t0 = agIn(r), lit = t >= 8.83;
      if (t < t0) continue;
      const drop = K.ease.outBack(K.inv(t0, t0 + 3 * P, t)), g = 1 - ph(t, 20.0 + r * P * 0.3, 2, K.ease.in);
      const working = r === 0 && t >= 11.9 && t < 12.9;
      bot(ctx, r, BOTX, y + 6.5 * BPX - (1 - drop) * 140, BPX * g, lit, working ? scanAt(t, 11.9) : -1);
      const pu = ph(t, 6.67 + r * P * 0.5, 2, K.ease.out) * (1 - out);
      if (pu > 0) { ctx.fillStyle = WIRE; ctx.fillRect(TRUNK - (TRUNK - PORT) * pu, y - 1, (TRUNK - PORT) * pu, 2); if (pu > 0.99) { ctx.fillStyle = '#737373'; ctx.fillRect(PORT - 4, y - 4, 8, 8); } }
    }
    const tu = ph(t, 7.0, 2, K.ease.inOut) * (1 - out);
    if (tu > 0) { const a = OY - (OY - agY(0)) * tu, b = OY + (agY(4) - OY) * tu; ctx.fillStyle = WIRE; ctx.fillRect(TRUNK - 1, a, 2, b - a); }
    const mouth = [[TRUNK, OY], [MOUTH_X, OY]];
    partial(ctx, mouth, out, ph(t, 7.33, 2, K.ease.inOut));
    if (t >= 7.67 && out === 0) arrow(ctx, mouth, 5);
    if (ACC >= 2.5 && ACC < 3.0) { const u = K.ease.inOut(K.inv(2.5, 3.0, ACC)); for (let r = 0; r < 5; r++) pulse(ctx, portPts(r), u); }
    // the pulse out to every agent
    for (const [t0, rows] of [[8.33, [0, 1, 2, 3, 4]]]) {
      if (t < t0 || t >= t0 + 3 * P) continue;
      const u = K.ease.inOut(K.inv(t0, t0 + 3 * P, t));
      for (const r of rows) pulse(ctx, portPts(r), u);
    }
    // her first agent takes the request: into the place and out to the right
    if (t >= 12.0 && t < 12.67) {
      if (t < 12.33) pulse(ctx, portPts(0).slice().reverse(), K.ease.inOut(K.inv(12.0, 12.33, t)));
      else { const x = K.lerp(OX + HUB / 2, 1240, K.ease.out(K.inv(12.33, 12.67, t))); dot(ctx, x, OY); }
    }
  }

  // ---------------------------------------------------------------- the files fold into an app; it lifts; it snaps into the grid, live
  const FX = 1400, FS = 120, TGT = [OX + 3 * P1, OY], CELL = 0.84 * P1;
  const GLYPH = [ // markup lines, style swatches, braces
    ['#######..', '.........', '..#######', '.........', '#####....'],
    ['###...###', '###...###', '.........', '###...###', '###...###'],
    ['.##...##.', '.#.....#.', '#.......#', '.#.....#.', '.##...##.'],
  ];
  function build(ctx, t) {
    if (t < 12.67 || t >= 16.5) return;
    if (t < 13.5) {
      const gap = K.lerp(10, 0, ph(t, 13.33, 1));
      for (let k = 0; k < 3; k++) {
        const x = FX + (k - 1) * (FS + gap), s = FS * ph(t, 12.67 + k * P, 2, K.ease.outBack);
        sq(ctx, x, OY, s);
        if (s > FS * 0.95) { ctx.save(); ctx.fillStyle = PAPER; GLYPH[k].forEach((row, r) => [...row].forEach((ch, c) => { if (ch === '#') ctx.fillRect(x - 45 + c * 10, OY - 25 + r * 10, 9, 9); })); ctx.restore(); }
      }
      return;
    }
    const fR = ph(t, 13.5, 2), fL = ph(t, 13.83, 2), top = OY - FS / 2;
    const flap = (pivot, dir, u) => {
      const th = Math.PI * u, w = FS * Math.cos(th), grow = 0.1 * Math.sin(th) * FS;
      ctx.fillStyle = Math.cos(th) < 0 && u < 1 ? '#bdb8ac' : INK;
      ctx.beginPath(); ctx.moveTo(pivot, top); ctx.lineTo(pivot + dir * w, top - grow); ctx.lineTo(pivot + dir * w, top + FS + grow); ctx.lineTo(pivot, top + FS); ctx.closePath(); ctx.fill();
    };
    if (t < 14.17) {
      sq(ctx, FX, OY, FS);
      if (fL < 1) flap(FX - FS / 2, -1, fL);
      flap(FX + FS / 2, 1, fR);
      if (fL > 0) flap(FX - FS / 2, -1, fL);
      return;
    }
    // the tile: lift (15.0), hover over its cell, anticipation (15.67), drop (15.83 → 16.0), squash
    const lu = ph(t, 15.0, 3, K.ease.inOut);
    let x = K.lerp(FX, TGT[0], lu), y = K.lerp(OY, OY - 40, lu), s = K.lerp(FS, CELL * 1.3, lu);
    const an = ph(t, 15.67, 1, K.ease.out), dr = K.ease.in(K.inv(15.83, 16.0, t));
    s += an * 6 - dr * (CELL * 1.3 + 6 - CELL); y += -an * 14 + dr * (40 + 14);
    let sx = s, sy = s;
    if (t >= 16.0) { const dt = t - 16, k = Math.exp(-dt * 10) * Math.cos(dt * 40) * 0.14; sx = CELL * (1 + k); sy = CELL * (1 - k); }
    if (t >= 15.0 && t < 16.0) { const a = lu * (1 - dr); ctx.fillStyle = GLOW + (0.07 * a) + ')'; ctx.fillRect(TGT[0] - CELL / 2 - 6 * a, OY - CELL / 2 - 6 * a, CELL + 12 * a, CELL + 12 * a); }
    if (t >= 15.0 && t < 15.83 && Math.floor((t - 15.0) / 0.25) % 2 === 0) { ctx.strokeStyle = YEL; ctx.lineWidth = 4; ctx.strokeRect(TGT[0] - CELL / 2 + 3, OY - CELL / 2 + 3, CELL - 6, CELL - 6); }
    // stacked layers: a folder of three files
    const lay = ph(t, 14.17, 2, K.ease.outBack) * (1 - lu);
    for (let k = 2; k >= 1; k--) { const o = 7 * k * lay; if (o < 0.5) continue; ctx.fillStyle = INK; ctx.fillRect(x - sx / 2 + o, y - sy / 2 + o, sx, sy); ctx.strokeStyle = PAPER; ctx.lineWidth = 3; ctx.strokeRect(x - sx / 2 + o, y - sy / 2 + o, sx, sy); }
    ctx.fillStyle = INK; ctx.fillRect(x - sx / 2, y - sy / 2, sx, sy);
    if (t >= 14.17) appIcon(ctx, 'list', x, y, Math.min(sx, sy));
    if (t >= 16.0) { const z = 0.12 * CELL * ph(t, 16.0, 2, K.ease.outBack), m = 0.08 * CELL; ctx.fillStyle = YEL; ctx.fillRect(x + sx / 2 - m - z, y - sy / 2 + m, z, z); }
    if (t >= 16.0 && t < 16.6) { const u = K.inv(16.0, 16.6, t), z = CELL * (1 + 1.6 * K.ease.out(u)); ctx.strokeStyle = YEL; ctx.lineWidth = 6 * (1 - u); ctx.strokeRect(x - z / 2, OY - z / 2, z, z); }
  }
  function s3tags(ctx, t) { // the app reaches the tools through the place
    if (t >= 16.83 && t < 18.0) {
      const pts = [[TGT[0] - CELL / 2, OY], [OX + HUB / 2, OY]];
      partial(ctx, pts, ph(t, 17.67, 2, K.ease.in), ph(t, 16.83, 1, K.ease.out));
      if (t < 17.17 && t >= 17.0) pulse(ctx, pts, K.ease.in(K.inv(17.0, 17.17, t)));
    }
  }

  // ---------------------------------------------------------------- the team around one shared app, and the link Maya shares with them
  const PX = [330, 750, 1170, 1590], side = (k) => (k < 2 ? -1 : 1); // pair centres; each person on the outside, their robot on the inside
  const TEAM = PX.map((x, k) => ({ who: ['maya', 'sam', 'lee', 'ana'][k], x: x + 58 * side(k), rx: x - 58 * side(k) }));
  const POFF = TEAM[0].x - 420, RBT = 24.0;
  const VT = { x: OX, y: 330, s: 380 }, FEET = 800, HEAD = FEET - 17 * 11 - 6, RHEAD = FEET - 13 * 7 - 6;
  const EV = [{ t: 25.5, s: 2 }, { t: 26.67, s: 0 }, { t: 32.33, s: 3, bot: true }, { t: 33.0, s: 0, bot: true }]; // the last two posted by their agents
  const FLY = 2 * P; // a post flies up to the app in two pulses
  const LINK = ['.####...####.', '#....#.#....#', '#...#####...#', '#....#.#....#', '.####...####.'];
  const SHARE = 21.0, HAND = [TEAM[0].x + 70, 560], ARRIVE = [0, 22.17, 22.33, 22.5], OPEN = [20.83, 22.33, 22.5, 22.67];
  function pill(ctx, x, y, px) { // the link: a yellow pill with a chain in it
    if (px < 0.4) return;
    px = px >= 2 ? Math.round(px) : px; x = Math.round(x); y = Math.round(y);
    const w = 17 * px, h = 9 * px;
    ctx.fillStyle = YEL; ctx.fillRect(x - w / 2 + px, y - h / 2, w - 2 * px, h); ctx.fillRect(x - w / 2, y - h / 2 + px, w, h - 2 * px);
    ctx.fillStyle = PAPER; LINK.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === '#') ctx.fillRect(Math.round(x - 6.5 * px) + c * px, Math.round(y - 2.5 * px) + r * px, px, px); }));
  }
  const upPath = (x, y) => [[x, y], [x, VT.y + VT.s / 2 + 40], [VT.x + (x - VT.x) * 0.25, VT.y + VT.s / 2 + 40], [VT.x + (x - VT.x) * 0.25, VT.y + VT.s / 2]]; // up to the app, square-cornered
  function vignetteTile(t) { // where the list app is between the grid and the vignette
    const c5 = cam(34.5), [x5, y5] = W2S(c5, 2, 0);
    if (t < 20.5) { const u = ph(t, 20.0, 3, K.ease.inOut); return { x: K.lerp(TGT[0], VT.x, u), y: K.lerp(OY, VT.y, u), s: K.lerp(CELL, VT.s, u) }; }
    if (t < 34.0) return VT;
    const u = ph(t, 34.0, 3, K.ease.inOut); return { x: K.lerp(VT.x, x5, u), y: K.lerp(VT.y, y5, u), s: K.lerp(VT.s, 0.84 * c5.p, u) };
  }
  const landT = (e) => e.t + FLY;
  const seen = (t) => EV.some((e) => t >= landT(e) && t < landT(e) + 0.12); // everyone blinks as a post lands: they all see it
  function share(ctx, t) {
    if (t < SHARE || t >= 23.2) return;
    // the link pops out of the live app and drops into Maya's hand
    if (t < 21.9) {
      const g = ph(t, SHARE, 2, K.ease.outBack), u = K.ease.inOut(K.inv(21.33, 21.67, t));
      const x = K.lerp(VT.x + VT.s / 2 - 20, HAND[0], u), y = K.lerp(VT.y + VT.s / 2 + 34, HAND[1], u) - 70 * Math.sin(Math.PI * u);
      pill(ctx, x, y, 7 * g);
    }
    // she sends it: a chat bubble with the link flies to each teammate
    for (let k = 1; k < 4; k++) {
      const t0 = 21.9 + (k - 1) * P * 0.5, ta = ARRIVE[k]; if (t < t0 || t >= OPEN[k]) continue;
      const u = K.ease.inOut(K.inv(t0, ta, t)), x = K.lerp(HAND[0], TEAM[k].x, u), y = K.lerp(HAND[1], HEAD - 70, u) - 150 * Math.sin(Math.PI * u), px = 9;
      spr(ctx, BUBBLE, x - 6.5 * px, y - 5 * px, px);
      ctx.fillStyle = INK; ctx.fillRect(x - 5 * px, y - 4 * px, 10 * px, 6 * px); pill(ctx, x, y - 1 * px, 4.4);
    }
    // they tap it and join: a pulse runs from each of them up into the app, and is gone
    for (let k = 0; k < 4; k++) { const t0 = OPEN[k] + P * (k ? 1 : 3); if (t >= t0 && t < t0 + 0.4) pulse(ctx, upPath(TEAM[k].x, HEAD - 8), K.ease.inOut(K.inv(t0, t0 + 0.4, t))); }
  }
  function team(ctx, t) {
    if (t < 20.0 || t >= 34.5) return;
    const out = ph(t, 33.67, 2, K.ease.in), all = seen(t);
    TEAM.forEach((p, k) => {
      const botPost = EV.find((e) => e.bot && e.s === k && t >= e.t - 0.5 && t < e.t), post = EV.find((e) => !e.bot && e.s === k && t >= e.t - 0.5 && t < e.t), typing = Math.floor(t * 12) % 2 ? 'typeA' : 'typeB';
      // people: Maya has walked over; the others drop in and wave, then tap the link when it reaches them
      if (k > 0 && t >= 20.5 + k * P) {
        const t0 = 20.5 + k * P, d = K.ease.outBack(K.inv(t0, t0 + 3 * P, t)), g = 1 - out;
        let arms = 'down';
        if (post) arms = typing;
        else if (t >= ARRIVE[k] && t < OPEN[k] + P) arms = 'waveA';
        else if (t >= t0 + 0.3 && t < t0 + 0.9) arms = Math.floor(t * 6) % 2 ? 'waveA' : 'waveB';
        person(ctx, p.who, p.x, FEET - (1 - d) * 260, TPX2 * g, { arms, blink: all || blinkAt(t, k), breathe: breathe(t, k * 0.3) });
      }
      if (k === 0 && t >= 21.0) {
        const arms = post ? typing : t >= 21.5 && t < 21.9 ? 'waveA' : t >= 21.9 && t < 22.2 ? typing : 'down';
        person(ctx, 'maya', p.x, FEET, TPX2 * (1 - out), { arms, blink: all || blinkAt(t, 0), breathe: breathe(t) });
      }
      // their agent: a different robot for each of them, dropping in beside them; it joins the same app
      const rt = RBT + k * P * 0.5;
      if (t >= rt) {
        const d = K.ease.outBack(K.inv(rt, rt + 3 * P, t)), g = 1 - out;
        bot(ctx, k, p.rx, FEET - (1 - d) * 200, 7 * g, t >= rt + 4 * P && !all, botPost ? scanAt(t, botPost.t - 0.5) : -1);
        const t1 = rt + 2 * P; if (t >= t1 && t < t1 + 0.4) pulse(ctx, upPath(p.rx, RHEAD - 8), K.ease.inOut(K.inv(t1, t1 + 0.4, t)), 10);
      }
    });
    share(ctx, t);
    // a post: a new row flies from whoever wrote it up into the shared app
    for (const e of EV) {
      if (t < e.t || t >= landT(e)) continue;
      const p = TEAM[e.s], sx = e.bot ? p.rx : p.x, sy = e.bot ? RHEAD - 10 : HEAD - 10, v = VT, u = K.ease.inOut(K.inv(e.t, landT(e), t));
      const rw = 0.6 * v.s, rh = 0.055 * v.s, tx = v.x - v.s / 2 + 0.1 * v.s + rw / 2, ty = v.y - v.s / 2 + 0.12 * v.s + rh / 2, sc = K.lerp(0.6, 1, u);
      const x = K.lerp(sx, tx, u), y = K.lerp(sy, ty, u) - 90 * Math.sin(Math.PI * u), w = rw * sc, h = rh * sc, pd = 0.4 * h;
      ctx.fillStyle = YEL; ctx.fillRect(x - w / 2 - pd, y - h / 2 - pd, w + 2 * pd, h + 2 * pd); // the post in flight: a yellow row with the dark row on it
      ctx.fillStyle = PAPER; ctx.fillRect(x - w / 2, y - h / 2, h, h); ctx.fillRect(x - w / 2 + h * 2.2, y - h / 2 + h * 0.15, w - h * 2.2, h * 0.7);
    }
  }
  function heroRows(ctx, v, t) { // the shared list: three posts to begin with, one more for each that lands; the newest at the top, the rest pushed down
    let n = 3, newest = -9; for (const e of EV) if (t >= landT(e)) { n++; newest = landT(e); }
    const s = v.s, x0 = v.x - s / 2, y0 = v.y - s / 2, gap = 0.135 * s, u = K.ease.outBack(K.clamp((t - newest) / 0.3)), sh = (1 - u) * gap;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, s, s); ctx.clip();
    for (let r = 0; r < Math.min(n, 7); r++) {
      const idx = n - r, fresh = r === 0 && t - newest < 0.9, yy = y0 + 0.12 * s + r * gap - (r ? sh : 0), w = (0.35 + 0.33 * K.hash(idx + 50, 7, 3)) * s;
      if (r === 0 && t - newest < 0.3) { const a = K.clamp((t - newest) / 0.3); ctx.globalAlpha = 1; if (a <= 0) continue; }
      const sq = 0.055 * s;
      if (fresh) { ctx.fillStyle = YEL; ctx.fillRect(x0 + 0.06 * s, yy - 0.025 * s, 0.88 * s, sq + 0.05 * s); } // the new post, highlighted
      ctx.fillStyle = PAPER; ctx.fillRect(x0 + 0.1 * s, yy, sq, sq); ctx.fillRect(x0 + 0.1 * s + sq * 2.2, yy + sq * 0.15, w, sq * 0.7);
    }
    ctx.restore();
  }
  function standupHero(ctx, t) { // the list app, the team's one shared app, and its moves in and out
    if (t < 20.0 || t >= 34.5) return;
    const v = vignetteTile(t), flash = EV.some((e) => t >= landT(e) && t < landT(e) + 2 * P) || (t >= SHARE && t < SHARE + 2 * P);
    sq(ctx, v.x, v.y, v.s, INK);
    const wipeOut = K.ease.in(K.inv(34.0, 34.33, t)); // as it moves into the grid its rows retract, leaving the plain tile
    ctx.save(); ctx.beginPath(); ctx.rect(v.x - v.s / 2, v.y - v.s / 2, v.s * (1 - wipeOut), v.s); ctx.clip();
    if (v.s > 200) heroRows(ctx, v, t); else rowsIn(ctx, v.x, v.y, v.s, 3, -9, t, false);
    const z = 0.08 * v.s, m = 0.06 * v.s; ctx.fillStyle = YEL; ctx.fillRect(v.x + v.s / 2 - m - z, v.y - v.s / 2 + m, z, z);
    ctx.restore();
    if (flash) { ctx.strokeStyle = YEL; ctx.lineWidth = 4; ctx.strokeRect(v.x - v.s / 2 - 8, v.y - v.s / 2 - 8, v.s + 16, v.s + 16); }
  }

  // ---------------------------------------------------------------- S5: links between apps
  function links(ctx, t) {
    if (t < 35.5 || t >= 43.1) return;
    const c = cam(t), trim = 0.43, out = ph(t, 42.67, 2, K.ease.in);
    for (const l of LINKS) {
      if (t < l.t) continue;
      const pts = l.pts.map(([i, j]) => W2S(c, i, j)), L = polyLen(pts), tr = trim * c.p;
      const sub = polyCut(pts, tr, L - tr), u = ph(t, l.t, 3, K.ease.inOut);
      partial(ctx, sub, out, u);
      if (u >= 1 && out === 0) arrow(ctx, sub, Math.max(4, 0.04 * c.p));
      if (t > l.t + 0.5 && out === 0) { // data running along it: one smooth sweep a second, the dot growing from nothing at the start and shrinking to nothing at the end (no hold, no jump)
        const f = ((t - l.t - 0.5) % 1.2) / 1.2, d = polyLen(sub) * (f - Math.sin(2 * Math.PI * f) / (2 * Math.PI)), z = Math.max(6, 0.09 * c.p) * Math.min(1, 3 * Math.sin(Math.PI * f)), [x, y] = polyAt(sub, d);
        if (z > 0.5) dot(ctx, x, y, z);
      }
    }
  }

  // ---------------------------------------------------------------- the fold into the place, the reveal, the end card, back to Maya
  const WM = { c: 66, yb: 513 }, NAME = 'OpenBelt'; // the tile 66 px (0.75 × grid38's), its centre where it was (y 480)
  const WMF = { family: 'Geist, "Inter Tight", sans-serif', weight: 650, track: -0.035 };
  function lockup(ctx) {
    ctx.save(); ctx.font = `${WMF.weight} 100px ${WMF.family}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const ref = Math.max(ctx.measureText('H').actualBoundingBoxAscent, ctx.measureText('l').actualBoundingBoxAscent); ctx.restore();
    const mk = WM.c, size = (100 * mk * BRAND.logo.wordmarkScale) / ref, font = { size, weight: WMF.weight, font: WMF.family, track: WMF.track, color: INK };
    ctx.save(); ctx.font = `${WMF.weight} ${size}px ${WMF.family}`; if ('letterSpacing' in ctx) ctx.letterSpacing = `${WMF.track * size}px`;
    const m = ctx.measureText(NAME), tw = m.actualBoundingBoxRight + m.actualBoundingBoxLeft - WMF.track * size, lead = -m.actualBoundingBoxLeft, desc = m.actualBoundingBoxDescent; ctx.restore();
    const gap = mk * BRAND.logo.gap / BRAND.logo.tile, W = mk + gap + tw, x0 = OX - W / 2;
    return { x0, tx: x0 + mk + gap - lead, baseline: WM.yb - mk * (1 - BRAND.logo.wordmarkScale) / 2, tw, desc, font, mk, gap };
  }
  // Maya as she stands in the first frame, in screen pixels: what the slot breaks into at the end
  const MARKC = { x: 960 - 45, y: 540 - 45, s: 90 }; // the opening's bare mark: small, at the frame's centre
  const MARK_IN = 0.08, MARK_BREAK = 1.6; // the mark holds about 1.5 s, then breaks into Maya
  const MAYA_PIX = (() => {
    const rows = PEOPLE.maya, out = [], pxs = MPX * Z0, g = Math.max(1, pxs * 0.07), left = 960 - 5.5 * pxs, top = 540 - 8.5 * pxs;
    const arms = new Set(ARMS.down.map(([r, c]) => r + ',' + c));
    for (let r = 0; r < 17; r++) for (let c = 0; c < 11; c++) { const ch = arms.has(r + ',' + c) ? '#' : rows[r][c]; if (ch !== '.') out.push({ r, c, col: COLS[ch], x: left + c * pxs + (pxs - g) / 2, y: top + r * pxs + (pxs - g) / 2 }); }
    const sub = [], cs = MARKC.s / 12; // the centred mark cut into twelfths
    for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) { const ui = Math.floor(i / 4), uj = Math.floor(j / 4); if (uj === 1 && ui < 2) continue; sub.push([MARKC.x + (i + 0.5) * cs, MARKC.y + (j + 0.5) * cs]); }
    out.forEach((p, k) => { const q = sub[Math.floor((k * sub.length) / out.length)]; p.sx = q[0]; p.sy = q[1]; p.d = MARK_BREAK + 0.22 * (p.r / 16) + 0.05 * K.hash(p.r, p.c, 61); }); // each of Maya's pixels starts as one of the mark's squares
    return { out, pxs };
  })();
  const inOut5 = (u) => (u < 0.5 ? 16 * u ** 5 : 1 - Math.pow(-2 * u + 2, 5) / 2);
  const URLT = { cover: 67.0, slide: 67.25, gone: 68.05, out: 69.2, black: 69.5, end: 70.0 }; // slide .. gone: the squeeze // world time
  const URLS = 'openbelt.com';
  function urlText(ctx) { // openbelt.com, JetBrains Mono 500, centred in the frame, its x-height band on the bar's centre line
    const o = { size: 48, weight: 500, font: 'mono', track: 0, color: INK }; // 0.75 × grid38's, with the lockup
    ctx.save(); ctx.font = `500 48px ${K.FONT.mono}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const m = ctx.measureText(URLS), xh = ctx.measureText('x').actualBoundingBoxAscent; ctx.restore();
    const x = Math.round(OX - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2), y = Math.round(WM.yb - WM.c / 2 + xh / 2 + 2); // centred on the ink
    return { o, x, y, x0: x - m.actualBoundingBoxLeft, x1: x + m.actualBoundingBoxRight };
  }
  // the end card's icon: the white mark resolves (r 0 → 1) into a white tile, its corners rounding to 22%, with the mark cut out of it in black, at 54%
  function icon(ctx, x, y, s, r = 1) {
    if (r <= 0) return K.slot(ctx, x, y, s, INK);
    const r1 = K.ease.inOut(K.clamp(r / 0.5)), r2 = K.ease.out(K.clamp((r - 0.45) / 0.55)), nw = (2 * s / 3) * r1; ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, s, s, BRAND.tileRadius * s * r1); ctx.clip(); K.slot(ctx, x, y, s, INK); ctx.fillStyle = INK; ctx.fillRect(x + 2 * s / 3 - nw - 0.5, y + s / 3 - 0.5, nw + 1, s / 3 + 1); // the notch fills, from its inner wall out
    const m = s * BRAND.markRatio * r2; if (m > 0.5) K.slot(ctx, x + (s - m) / 2, y + (s - m) / 2, m, PAPER); // the black mark grows in, centred
    ctx.restore();
  }
  const RESOLVE = [64.06, 64.3]; // just after the click, one quick beat
  function endCard(ctx, t) {
    if (t < 64.0) return;
    const L = lockup(ctx), x0 = L.x0, u = K.ease.outQuint(K.inv(65.0, 65.55, t)); // the tile holds at the centre, then slides to its place in one move
    const C0 = 3 * ENDCAM.s; // where the fold lands: the mark at the lockup's size, at the frame's centre
    let size = K.lerp(C0, L.mk, u), sx = K.lerp(OX - C0 / 2, x0, u), sy = K.lerp(OY - C0 / 2, WM.yb - L.mk, u);
    if (t < 65.0) { const dt = t - 64.0, k = 1 + 0.045 * Math.exp(-dt * 5) * Math.cos(dt * 30); sx += size * (1 - k) / 2; sy += size * (1 - k) / 2; size *= k; }
    if (t < 64.25) { const r = K.inv(64.0, 64.25, t), z = C0 + 2 * (15 + 4 * K.ease.out(r)); ctx.save(); ctx.globalAlpha = 0.5 * (1 - K.ease.in(r)); ctx.strokeStyle = '#8c8c8c'; ctx.lineWidth = 1.5; ctx.strokeRect(OX - z / 2, OY - z / 2, z, z); ctx.restore(); } // a soft acknowledgement of the click
    const nx = x0 + L.mk + L.gap - 8, nw = L.tw + 16, top = WM.yb - L.mk, bot = WM.yb, name = () => K.text(ctx, NAME, L.tx, L.baseline, L.font);
    const rr = K.inv(RESOLVE[0], RESOLVE[1], t); // first the notch closes to a white square, then the black mark grows in
    if (t < URLT.cover) { // the name slides out from behind the tile as the tile slides left: masked at the tile's right edge plus the gap
      icon(ctx, sx, sy, size, rr);
      if (t >= 65.0) {
        const gap = L.gap, edge = sx + size + gap, edge0 = OX + C0 / 2 + gap, dx = (1 - u) * (edge0 - (L.tx + L.tw + 4));
        ctx.save(); ctx.beginPath(); ctx.rect(edge, 0, 1920 - edge, 1080); ctx.clip(); K.text(ctx, NAME, L.tx + dx, L.baseline, L.font); ctx.restore();
      }
      return;
    }
    if (t < URLT.slide) { // the bar covers the name, left to right
      const cw = nw * sine((t - URLT.cover) / (URLT.slide - URLT.cover));
      icon(ctx, sx, sy, size, 1);
      ctx.save(); ctx.beginPath(); ctx.rect(nx + cw, top - 80, nw - cw, bot - top + 160); ctx.clip(); name(); ctx.restore();
      ctx.fillStyle = INK; ctx.fillRect(nx, top, cw, bot - top);
      return;
    }
    const U = urlText(ctx);
    // the squeeze: the bar's right end stays; the left edge (the mark's left side) closes on it, eased inOut5. The mark flattens
    // on its own faster curve (zero width by 55% of the move, its gap closing with it), so no sliver of mark is ever left by the bar
    const M = size, barR = nx + nw, gap0 = nx - (sx + M), p = K.ease.inOut5 ? K.ease.inOut5(K.inv(URLT.slide, URLT.gone, t)) : inOut5(K.inv(URLT.slide, URLT.gone, t));
    const Lx = sx + (barR - sx) * p, mw = M * (1 - K.ease.inOut(K.inv(0, 0.55, p))), g = gap0 * (mw / M), bl = Math.min(barR, Lx + mw + g);
    if (t < URLT.black) { // openbelt.com: uncovered left of the moving edge; it holds, then a hard cut to black
      const edge = Lx - 4;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, edge, 1080); ctx.clip(); K.text(ctx, URLS, U.x, U.y, U.o); ctx.restore();
    }
    if (t < URLT.gone) {
      if (mw >= 1) { ctx.save(); ctx.translate(Lx, sy); ctx.scale(mw / M, 1); icon(ctx, 0, 0, M, 1); ctx.restore(); } // the tile, its cut-out with it
      if (barR - bl >= 1) { ctx.fillStyle = INK; ctx.fillRect(bl, top, barR - bl, bot - top); }
    }
  }


  // ---------------------------------------------------------------- the fold: the city is a sheet of paper; folded into a belt; the belt folds into the mark
  // The sheet is the city's tiles i = -12 .. 11, j = -12 .. 3 (24 × 16), in tile units, world y up (row j is y = -j).
  // 1. Four folds lay its rows together (16 → 8 → 4 → 2 → 1): a belt, one tile tall, 24 long, the apps its pattern.
  //    Each fold takes the packet's moving half (a box hinged on the crease at the packet's top) through 180° onto the other half.
  // 2. Its ends fold under, one after the other, until it is 7 tiles long (they swing down and back, out of sight).
  // 3. Two folds across the belt at 45° turn it down and back: the 7 tiles become the mark, top row, right side, bottom row.
  //    The last lands on the chord: the buckle clicks shut.
  const SHEET = [-12.5, 11.5, -3.5, 12.5], TPX0 = 14 * 6, FTH = 0.003; // sheet extent; texels per tile; one sheet's thickness
  const STEPS = [ // axis of the crease, crease, which side moves, under or over, start and end (fold time, s); each quicker than the last
    { ax: 'y', c: 4.5, side: 1, a: 0.08, b: 0.72 }, { ax: 'y', c: 0.5, side: -1, a: 0.78, b: 1.28 },
    { ax: 'y', c: 2.5, side: 1, a: 1.33, b: 1.71 }, { ax: 'y', c: 1.5, side: -1, a: 1.75, b: 2.03 },
    { ax: 'x', c: -8.25, side: -1, under: true, a: 2.1, b: 2.32 }, { ax: 'x', c: 8.25, side: 1, under: true, a: 2.32, b: 2.52 },
    { ax: 'x', c: -4, side: -1, under: true, a: 2.52, b: 2.7 }, { ax: 'x', c: 5, side: 1, under: true, a: 2.7, b: 2.86 },
  ];
  // the belt (9 long) into the mark, square-cornered: at each corner it goes back under itself (A, C), then turns 90° on a 45° crease (B, D)
  // belt coordinates: x 0 .. 9 along it, y 0 .. 1 across, y down. The top row is x 0 .. 3; the right side and the bottom row lie under it, each a layer lower.
  const BELTF = [
    { p: [[3, 0], [3, 1]], ref: [7, 0.5], dir: -1, at: 'b', a: 2.92, b: 3.16 }, // A: back under, along x = 3
    { p: [[3, 0], [4, 1]], ref: [5, 0.5], dir: 1, at: 't', a: 3.18, b: 3.5 }, // B: down, on the 45° crease
    { p: [[6, 0], [6, 1]], ref: [8, 0.5], dir: -1, at: 'b', a: 3.52, b: 3.7 }, // C: back under, along x = 6
    { p: [[6, 0], [7, 1]], ref: [8.5, 0.5], dir: 1, at: 't', a: 3.72, b: 4.0 }, // D: left: it lands on the chord, the buckle shut
  ];
  const BPIECES = [[[0, 0], [3, 0], [3, 1], [0, 1]], [[3, 0], [4, 1], [3, 1]], [[3, 0], [6, 0], [6, 1], [4, 1]], [[6, 0], [7, 1], [6, 1]], [[6, 0], [9, 0], [9, 1], [7, 1]]];
  const DRAIN = [3.3, 3.95];
  // the packets: after m steps, its rectangle, its bottom and top, and how its top face maps to the sheet's textures
  const PACK = [{ r: SHEET.slice(), zb: 0, zt: FTH, front: true, refl: null }];
  STEPS.forEach((F, m) => {
    const p = PACK[m], r = p.r.slice(), k = F.ax === 'x' ? 0 : 2;
    if (F.side > 0) r[k + 1] = F.c; else r[k] = F.c;
    PACK.push(F.under ? { ...p, r } : { r, zb: p.zb, zt: p.zt + (p.zt - p.zb), front: false, refl: F }); // an end folded under is out of sight
  });
  const BELT = PACK[STEPS.length]; // x -4 .. 5, y 1.5 .. 2.5
  const sw = (xs, ys) => [xs - 4, 2.5 - ys]; // belt coordinates (x along it from its left end, y down across it) to world
  const reflect = (F, x, y) => (!F ? [x, y] : F.ax === 'x' ? [2 * F.c - x, y] : [x, 2 * F.c - y]);
  const suv = (x, y) => [(x - SHEET[0]) / (SHEET[1] - SHEET[0]), (y - SHEET[2]) / (SHEET[3] - SHEET[2])];
  let FD = null;
  function foldTextures() { // the city as it is when the fold starts (front), and its back: the same print, darker and warm, seen through the paper
    linksInto(FOLD - 0.001);
    const W = 24 * TPX0, H = 16 * TPX0, fc = document.createElement('canvas'), bc = document.createElement('canvas');
    fc.width = bc.width = W; fc.height = bc.height = H;
    const fi = fc.getContext('2d').createImageData(W, H), bi = bc.getContext('2d').createImageData(W, H), u0 = FF * -12 - 7, v0 = FF * -12 - 7, gr = PALRGB[0];
    for (let cv = 0; cv < 16 * FF; cv++) for (let cu = 0; cu < 24 * FF; cu++) {
      const col = PALRGB[bloomColour(u0 + cu, v0 + cv, FOLD - 0.001, wingFrame())];
      for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
        const e = (x === 0 || x === 5 ? 0.5 : 0) + (y === 0 || y === 5 ? 0.5 : 0), m = Math.min(1, e * 0.75), k = ((cv * 6 + y) * W + cu * 6 + x) * 4; // the hairline between pixels
        for (let c = 0; c < 3; c++) { const v = col[c] * (1 - m) + gr[c] * m; fi.data[k + c] = v; bi.data[k + c] = v * 0.58 + [30, 23, 16][c]; }
        fi.data[k + 3] = bi.data[k + 3] = 255;
      }
    }
    fc.getContext('2d').putImageData(fi, 0, 0); bc.getContext('2d').putImageData(bi, 0, 0);
    return [fc, bc];
  }
  function foldInit() {
    const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setPixelRatio(1); renderer.setSize(1920, 1080, false); renderer.setClearColor(0x000000, 0); renderer.outputEncoding = THREE.sRGBEncoding;
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(22, 1920 / 1080, 0.5, 200);
    // lit so that a face looking straight up shows its texture exactly (ambient + key·n_z = 1); faces turned away go darker
    const L = new THREE.Vector3(-0.35, 0.45, 0.82).normalize(), kd = 0.55;
    scene.add(new THREE.AmbientLight(0xffffff, 1 - kd * L.z));
    const key = new THREE.DirectionalLight(0xffffff, kd); key.position.copy(L); scene.add(key);
    const [fc, bc] = foldTextures(), tex = (c) => { const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; };
    const mats = { front: new THREE.MeshLambertMaterial({ map: tex(fc) }), back: new THREE.MeshLambertMaterial({ map: tex(bc) }), side: new THREE.MeshLambertMaterial({ color: 0x5c5045 }) };
    // a prism over a convex polygon (world xy) from zb to zt: top mapped by the packet's rule, bottom the back at the same place, sides paper edge
    function prism(poly, zb, zt, top) {
      let area = 0; for (let i = 0; i < poly.length; i++) { const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length]; area += x0 * y1 - x1 * y0; }
      if (area < 0) poly = poly.slice().reverse();
      const P = [], U = [], N = [], G = [], topUV = (p) => suv(...reflect(top.refl, p[0], p[1])), botUV = (p) => suv(p[0], p[1]);
      const tri = (a, b, c, n, uvf, g) => { const s = P.length / 3; for (const p of [a, b, c]) { P.push(...p); N.push(...n); U.push(...uvf(p)); } G.push([s, 3, g]); };
      for (let i = 1; i < poly.length - 1; i++) {
        tri([...poly[0], zt], [...poly[i], zt], [...poly[i + 1], zt], [0, 0, 1], topUV, top.front ? 0 : 1);
        tri([...poly[0], zb], [...poly[i + 1], zb], [...poly[i], zb], [0, 0, -1], botUV, 1);
      }
      for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length], l = Math.hypot(x1 - x0, y1 - y0), n = [(y1 - y0) / l, -(x1 - x0) / l, 0];
        tri([x0, y0, zb], [x1, y1, zb], [x1, y1, zt], n, () => [0, 0], 2); tri([x0, y0, zb], [x1, y1, zt], [x0, y0, zt], n, () => [0, 0], 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      for (const [s, n, m] of G) g.addGroup(s, n, m);
      const mesh = new THREE.Mesh(g, [mats.front, mats.back, mats.side]); mesh.visible = false; scene.add(mesh); return mesh;
    }
    const rect = ([x0, x1, y0, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const hinge = (P, child) => { const pivot = new THREE.Group(), inner = new THREE.Group(); pivot.position.copy(P); inner.position.set(-P.x, -P.y, -P.z); scene.remove(child); inner.add(child); pivot.add(inner); scene.add(pivot); return { pivot, inner }; };
    // the static packets, and for each step its staying part and its moving part (hinged on the crease, at the top, or at the bottom when it goes under)
    const packs = PACK.map((p) => prism(rect(p.r), p.zb, p.zt, p));
    const steps = STEPS.map((F, m) => {
      const p = PACK[m], st = PACK[m + 1].r, mv = p.r.slice(), k = F.ax === 'x' ? 0 : 2;
      if (F.side > 0) mv[k] = F.c; else mv[k + 1] = F.c;
      const stay = prism(rect(st), p.zb, p.zt, p), moving = prism(rect(mv), p.zb, p.zt, p);
      const h = hinge(new THREE.Vector3(F.ax === 'x' ? F.c : 0, F.ax === 'y' ? F.c : 0, F.under ? p.zb : p.zt), moving);
      return { stay, moving, pivot: h.pivot };
    });
    // the belt's five pieces, each crease's pivot nested in the last: a fold moves everything beyond its crease
    const B = BELT, pieces = BPIECES.map((poly) => prism(poly.map(([x, y]) => sw(x, y)), B.zb, B.zt, B));
    let parent = scene; const belt = [];
    BELTF.forEach((F, k) => {
      const [p0, p1] = F.p.map(([x, y]) => sw(x, y)), P = new THREE.Vector3(p0[0], p0[1], F.at === 't' ? B.zt : B.zb);
      const ax = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], 0).normalize(), m = sw(...F.ref), cz = ax.x * (m[1] - p0[1]) - ax.y * (m[0] - p0[0]);
      const pivot = new THREE.Group(), inner = new THREE.Group(); pivot.position.copy(P); inner.position.set(-P.x, -P.y, -P.z); pivot.add(inner); parent.add(pivot);
      scene.remove(pieces[k + 1]); inner.add(pieces[k + 1]);
      belt.push({ pivot, ax, sign: Math.sign(cz) * F.dir }); parent = inner;
    });
    const white = new THREE.Color(0xf8f7f3).convertSRGBToLinear();
    const base = { front: mats.front.color.clone(), back: mats.back.color.clone(), side: mats.side.color.clone() };
    FD = { renderer, scene, camera, packs, steps, pieces, belt, mats, white, base, cv };
  }
  // where the camera looks (a world point that shows at screen (960, 470)) and its scale (px per tile) for each packet; the end is the mark
  const PCAM = [{ x: 0, y: 0, s: 84 }, { x: -0.5, y: 0.5, s: 78 }, { x: -0.5, y: 2.5, s: 78 }, { x: -0.5, y: 1.5, s: 78 }, { x: -0.5, y: 2.0, s: 76 },
    { x: 0.5, y: 2.0, s: 74 }, { x: 0.5, y: 2.0, s: 66 }, { x: 0.5, y: 2.0, s: 58 }, { x: 0.5, y: 2.0, s: 50 }];
  const ENDCAM = { x: sw(1.5, 1.5)[0], y: sw(1.5, 1.5)[1], s: WM.c / 3 }; // the mark's centre at (960, 470), a cell 100 px: the logo exactly
  const foldEase = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  function foldState(ft) { // which step, its angle (0 .. π), the belt's two folds, and the camera
    let m = 0, th = 0, cam0 = PCAM[0], cam1 = PCAM[0], cu = 0;
    for (let k = 0; k < STEPS.length; k++) {
      const F = STEPS[k];
      if (ft < F.a) { m = k; th = 0; cam0 = cam1 = PCAM[k]; break; }
      if (ft < F.b) { const u = (ft - F.a) / (F.b - F.a); m = k; th = Math.PI * foldEase(u); cam0 = PCAM[k]; cam1 = PCAM[k + 1]; cu = K.ease.inOut(Math.min(1, u * 1.15)); break; }
      m = k + 1; cam0 = cam1 = PCAM[k + 1];
    }
    const bel = BELTF.map((F) => Math.PI * foldEase(K.inv(F.a, F.b, ft)));
    if (m === STEPS.length) { cam0 = PCAM[m]; cam1 = ENDCAM; cu = K.ease.inOut(K.inv(BELTF[0].a - 0.04, BELTF[3].b - 0.1, ft)); }
    const lerp = (k) => K.lerp(cam0[k], cam1[k], cu);
    return { m, th, bel, cam: { x: lerp('x'), y: lerp('y'), s: lerpLog(cam0.s, cam1.s, cu) } };
  }
  function foldDraw(ctx, ft) {
    if (!FD) foldInit();
    const st = foldState(ft), F = STEPS[st.m], belt = st.m === STEPS.length, folding = !belt && st.th > 0 && st.th < Math.PI;
    for (const p of FD.packs) p.visible = false;
    for (const f of FD.steps) f.stay.visible = f.moving.visible = false;
    for (const l of FD.pieces) l.visible = false;
    let topZ;
    if (belt) { // the belt's pieces, each crease turned by its own angle (each in the frame of the one before)
      for (const l of FD.pieces) l.visible = true;
      FD.belt.forEach((b, k) => b.pivot.quaternion.setFromAxisAngle(b.ax, b.sign * st.bel[k]));
      topZ = BELT.zt - 2 * (BELT.zt - BELT.zb) * K.inv(BELTF[0].a, BELTF[3].b, ft);
    } else if (folding) {
      const f = FD.steps[st.m], sg = F.under ? -1 : 1; f.stay.visible = f.moving.visible = true; topZ = PACK[st.m].zt;
      if (F.ax === 'x') f.pivot.rotation.set(0, -sg * F.side * st.th, 0); else f.pivot.rotation.set(sg * F.side * st.th, 0, 0);
    } else { const m = st.th >= Math.PI ? st.m + 1 : st.m; FD.packs[m].visible = true; topZ = PACK[m].zt; }
    // the colours drain to paper-white over the last fold
    const w = K.ease.inOut(K.inv(DRAIN[0], DRAIN[1], ft));
    for (const k of ['front', 'back', 'side']) { const M = FD.mats[k]; M.color.copy(FD.base[k]).multiplyScalar(1 - w); M.emissive.copy(FD.white).multiplyScalar(w); }
    // the camera: straight above its point, the image shifted so that point shows at (960, 470); its scale exact at the top face
    const c = st.cam, cam = FD.camera, D = 1080 / (2 * c.s * Math.tan((11 * Math.PI) / 180));
    cam.position.set(c.x, c.y, topZ + D); cam.up.set(0, 1, 0); cam.lookAt(c.x, c.y, topZ);
    cam.setViewOffset(1920, 1080, 0, 70, 1920, 1080); cam.updateProjectionMatrix();
    FD.renderer.render(FD.scene, cam);
    // a fold over the top: a hairline shadow on the crease, and the lifting half's shade on the half it will land on
    if (folding && !F.under) {
      const pr = PACK[st.m].r, sh = Math.sin(st.th), proj = (x, y) => { const v = new THREE.Vector3(x, y, topZ).project(cam); return [(v.x + 1) * 960, (1 - v.y) * 540]; };
      const [a0, a1] = F.ax === 'x' ? [proj(F.c, pr[2]), proj(F.c, pr[3])] : [proj(pr[0], F.c), proj(pr[1], F.c)];
      const nx = F.ax === 'x' ? -F.side : 0, ny = F.ax === 'y' ? F.side : 0, reach = c.s * 1.6 * (1 - Math.abs(Math.cos(st.th)) * 0.4);
      const g = ctx.createLinearGradient((a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2, (a0[0] + a1[0]) / 2 + nx * reach, (a0[1] + a1[1]) / 2 + ny * reach);
      g.addColorStop(0, `rgba(8,7,6,${0.32 * sh})`); g.addColorStop(1, 'rgba(8,7,6,0)');
      ctx.drawImage(FD.cv, 0, 0);
      ctx.save();
      ctx.beginPath(); ctx.moveTo(a0[0], a0[1]); ctx.lineTo(a1[0], a1[1]); ctx.lineTo(a1[0] + nx * reach, a1[1] + ny * reach); ctx.lineTo(a0[0] + nx * reach, a0[1] + ny * reach); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = `rgba(8,7,6,${0.6 * sh})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a0[0], a0[1]); ctx.lineTo(a1[0], a1[1]); ctx.stroke();
      ctx.restore();
      // the moving half is drawn again over the shade, so the shade falls only on the staying half
      const f = FD.steps[st.m]; f.stay.visible = false; FD.renderer.render(FD.scene, cam); f.stay.visible = true;
      ctx.drawImage(FD.cv, 0, 0);
      return;
    }
    ctx.drawImage(FD.cv, 0, 0);
  }

  // ---------------------------------------------------------------- frame
  // the opening camera: close on Maya, then out to the whole scene (1.0 → 2.0); the last frames are close on her again
  function openCam(t) {
    const u = t >= 60 ? 0 : ph(t, 0.83, 5), z = lerpLog(Z0, 1, u);
    return { z, fx: K.lerp(MAYA_C[0], 960, u), fy: K.lerp(MAYA_C[1], 540, u) };
  }
  function world(ctx, t) {
    drawGrid(ctx, t);
    hub(ctx, t);
    tools(ctx, t);
    agents(ctx, t);
    links(ctx, t);
    build(ctx, t);
    s3tags(ctx, t);
    team(ctx, t);
    standupHero(ctx, t);
    maya(ctx, t);
    ask(ctx, t);
  }
  function grainFull(ctx, frame) { // the grain as one full-frame overlay (one draw, not forty tiles)
    const f = frame % 8, c = K.cached(`grainFull:${f}`, 1920, 1080, (g) => { const tile = K.cached(`grain:${f}:256`, 256, 256, (h) => { const r = K.rng(f + 11), img = h.createImageData(256, 256); for (let i = 0; i < img.data.length; i += 4) { const v = r() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; } h.putImageData(img, 0, 0); }); for (let y = 0; y < 1080; y += 256) for (let x = 0; x < 1920; x += 256) g.drawImage(tile, x, y); });
    ctx.save(); ctx.globalAlpha = 0.05; ctx.globalCompositeOperation = 'overlay'; ctx.drawImage(c, 0, 0); ctx.restore();
  }
  function draw(ctx, t) {
    const tn = ((t % DUR) + DUR) % DUR;
    if (tn < INTRO) { // frame 0 is the last frame (black); the white mark stamps in, holds, and breaks into Maya
      TR = 0; ACC = -1; FT = -1;
      ctx.fillStyle = PAPER; ctx.fillRect(0, 0, 1920, 1080);
      if (tn >= MARK_IN && tn < MARK_BREAK) K.slot(ctx, MARKC.x, MARKC.y, MARKC.s, INK);
      if (tn >= MARK_BREAK) {
        const { out, pxs } = MAYA_PIX, g = Math.max(1, pxs * 0.07), c0 = MARKC.s / 12;
        for (const p of out) {
          const u = K.ease.inOut(K.inv(p.d, p.d + 0.5, tn)), sz = K.lerp(c0, pxs - g, u); ctx.fillStyle = u > 0.6 ? p.col : INK;
          ctx.fillRect(K.lerp(p.sx, p.x, u) - sz / 2, K.lerp(p.sy, p.y, u) - sz / 2 - 50 * Math.sin(Math.PI * u), sz, sz);
        }
      }
      grainFull(ctx, 0);
      return;
    }
    TR = tn - INTRO; for (const c of CUTS) if (TR >= c) TR += 2; ACC = TR < A0 ? -1 : TR < A0 + AL ? TR - A0 : AL;
    const t1 = TR < A0 ? TR : TR < A0 + AL ? A0 - 0.03 : TR - AL;
    FT = t1 >= FOLD && t1 < FOLD + FLEN ? t1 - FOLD : -1; // time into the fold
    t = t1 < FOLD ? t1 : FT >= 0 ? FOLD - 0.001 : t1 - (FLEN - 2); // the world's own time (the old chord at 64.0)
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, 1920, 1080);
    if (FT >= 0) foldDraw(ctx, FT);
    else if (t < 2.2) {
      const o = openCam(t);
      ctx.save(); ctx.transform(o.z, 0, 0, o.z, 960 - o.fx * o.z, 540 - o.fy * o.z); world(ctx, t); ctx.restore();
    } else world(ctx, t);
    for (const L of LINES) statement(ctx, TR, L);
    endCard(ctx, t);
    grainFull(ctx, t >= 66.0 ? 0 : Math.floor(t * 24)); // still once the lockup holds
  }

  // ---------------------------------------------------------------- score
  function score(ac, dest, when, offset) {
    const S00 = K.sched(ac, dest, when, offset), S0 = (time, fn, out) => { if (time > 70.05) return; let d = 0; for (const c of CUTS) { if (time >= c - 1e-6 && time < c + 2 - 1e-6) return; if (time >= c + 2 - 1e-6) d += 2; } S00(Math.round((time - d + INTRO) * 1e6) / 1e6, fn, out); }, S = (time, fn, out) => S0(time >= 64.0 - 1e-6 ? time + AL + FLEN - 2 : time >= A0 - 1e-6 ? time + AL : time, fn, out);
    const bus = K.bus(ac, dest, { gain: 0.72 });
    const rv = K.reverb(ac, bus.input, { wet: 0.3, seconds: 3.4, decay: 2.4 });
    const M = rv.input, D = bus.input;
    const PAT = [0, 2, 3, 1, 4, 2, 0, 3, 1, 4, 2, 3];
    const SET = {
      D: ['D4', 'F#4', 'A4', 'C#5', 'E5'], Bm: ['B3', 'D4', 'F#4', 'A4', 'C#5'], G: ['G3', 'D4', 'F#4', 'A4', 'B4'],
      Em: ['E4', 'G4', 'B4', 'D5', 'F#5'], Asus: ['A3', 'D4', 'E4', 'G4', 'B4'],
    };
    const ROOT = { D: 'D2', Bm: 'B1', G: 'G1', Em: 'E2', Asus: 'A1' };
    const KEYS = { D: ['A3', 'C#4', 'E4', 'F#4'], Bm: ['B3', 'D4', 'F#4', 'A4'], G: ['B3', 'D4', 'F#4', 'A4'], Em: ['G3', 'B3', 'D4', 'F#4'], Asus: ['G3', 'A3', 'D4', 'E4'] };
    const CH = ['D', 'D', 'D', 'D', 'D', 'Bm', 'Bm', 'Bm', 'G', 'G', 'G', 'G', 'G', 'G', 'Em', 'Em', 'Em', 'D', 'D', 'Bm', 'Bm',
      'G', 'Asus', 'D', 'Bm', 'G', 'Em', 'D', 'D', 'G', 'Em', 'Asus', 'D', 'D', 'D', 'D'];
    const keyv = (t, n, v) => S(t, (tt, o) => {
      const f = K.hz(n), g = ac.createGain();
      g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(v * 0.1, tt + 0.006); g.gain.setTargetAtTime(0, tt + 0.01, 0.09); g.connect(o);
      K.osc(ac, 'sine', f, tt, tt + 0.5, g); const g2 = ac.createGain(); g2.gain.value = 0.35; g2.connect(g); K.osc(ac, 'triangle', f * 2, tt, tt + 0.5, g2);
    }, M);
    for (let bR = 0; bR < 38; bR++) {
      const qb = bR < 6 ? bR : bR < 8 ? 5 : bR - 2, b = qb < 31 ? qb : qb < 33 ? 31 : qb - 1;
      const ch = bR === 6 ? 'Em' : bR === 7 ? 'Asus' : qb === 31 ? 'G' : CH[b], set = SET[ch], t0 = bR * 2, S = S0;
      const play = b < 32 || b >= 34, ramp = b >= 34 ? 0.8 : 1, peak = b >= 28 && b < 32 ? 1.25 : 1;
      const shift = b < 4 ? null : b < 10 ? 1 : b < 17 ? 3 : b < 23 ? 5 : 6;
      for (let k = 0; k < 12; k++) {
        const t = t0 + k * P;
        if (b === 31 && qb === 32 && k >= 9) continue;
        if (b >= 32 && b < 34) continue;
        const acc = k % 3 === 0 ? 0.12 : 0;
        if (play) S(t, (tt, o) => K.mallet(ac, o, tt, set[PAT[k]], ((b === 0 ? 0.34 + k * 0.006 : 0.4) * ramp + acc * 0.8) * peak * (bR === 0 ? 0.55 + 0.45 * (k / 12) : 1), -0.35), M); // it comes in softly after the silence
        if (shift != null && b < 32 && !(b >= 25 && b < 28)) { const n = set[PAT[(k + shift) % 12]]; S(t, (tt, o) => K.mallet(ac, o, tt, n, 0.32 + acc * 0.6, 0.38), M); }
        if (b >= 8 && b < 32) { const sw = 0.45 + 0.55 * Math.pow(Math.sin(Math.PI * (((b % 2) * 12 + k) / 24)), 2); for (const n of KEYS[ch]) keyv(t, n, (b < 15 ? 0.5 : 0.6) * sw); }
        if (b >= 19 && b < 32 && !(b >= 25 && b < 28)) S(t, (tt, o) => K.hat(ac, o, tt, k % 3 === 0 ? 0.3 : 0.15), D);
      }
      if (b >= 1 && b < 32) for (let k = 0; k < 12; k += 3) { if (b < 3 && k > 0) continue; S(t0 + k * P, (tt, o) => K.bass(ac, o, tt, ROOT[ch], 0.3, k === 0 ? 0.55 : 0.38), D); }
    }
    // the access beat: the gates appear, a lock snaps shut, an eye opens, only what is allowed goes through
    const At = (a, fn, out) => S0(A0 + a, fn, out);
    for (let k = 0; k < 5; k++) At(0.33 + k * 0.08, (tt, o) => K.tick(ac, o, tt, 0.22, 2000 + k * 180), D);
    At(1.17, (tt, o) => { K.pop(ac, o, tt, 0.35, 260); K.noise(ac, o, tt, 0.08, { type: 'bandpass', freq: 1400, q: 3, vel: 0.25 }); K.bass(ac, o, tt, 'E2', 0.25, 0.4); }, D);
    At(1.67, (tt, o) => { K.pluck(ac, o, tt, 'B5', 0.3, 0.4); K.tick(ac, o, tt, 0.15, 2600); }, M);
    At(2.17, (tt, o) => { for (const n of ['A5', 'D6', 'F#6']) K.bell(ac, o, tt, n, 0.26, 1.8); K.bell(ac, o, tt, 'E5', 0.1, 1.2); }, M);
    At(2.5, (tt, o) => { for (let r = 0; r < 5; r++) K.tick(ac, o, tt + r * 0.04, 0.2, 3000 + r * 250); K.pop(ac, o, tt + 0.5, 0.25, 700); }, D);
    At(3.33, (tt, o) => K.whoosh(ac, o, tt, 0.4, 0.08, false), M);
    const typeKeys = (t0, n, rate, v = 0.22) => { for (let i = 0; i < n; i++) S(t0 + i / rate, (tt, o) => K.key(ac, o, tt, v), D); };
    // S1: Maya waves; her tools fly out of her and up; the place builds; each tool wired once
    S(0.33, (tt, o) => K.pluck(ac, o, tt, 'A5', 0.22, 0.6), M);
    for (let k = 0; k < 5; k++) { S(toolIn(k), (tt, o) => K.pop(ac, o, tt, 0.22, 500 + k * 90), D); S(toolIn(k) + 4 * P, (tt, o) => K.tick(ac, o, tt, 0.3, 1500 + k * 200), D); S(lineT(k) + 3 * P, (tt, o) => K.bell(ac, o, tt, ['D5', 'F#5', 'A5', 'C#6', 'E6'][k], 0.4, 2), M); }
    for (let k = 0; k < 8; k++) S(1.5 + k * P * 0.4 + P, (tt, o) => K.tick(ac, o, tt, 0.16, 900 + k * 60), D);
    S(4.33, (tt, o) => { K.bell(ac, o, tt, 'A5', 0.25, 1.5); K.bell(ac, o, tt, 'D6', 0.2, 1.5); }, M);
    // S2: the robots drop in; the pulse; their eyes light; the new one plugs into a spare port
    for (let r = 0; r < 5; r++) S(agIn(r) + 2 * P, (tt, o) => { K.pop(ac, o, tt, 0.28, 330 + r * 60); K.tick(ac, o, tt, 0.18, 2600); }, D);
    S(6.67, (tt, o) => K.whoosh(ac, o, tt, 0.6, 0.12, true), M);
    S(7.67, (tt, o) => K.riser(ac, o, tt, 0.6, 0.12), M);
    S(8.33, (tt, o) => { for (const n of ['D5', 'F#5', 'A5', 'D6']) K.bell(ac, o, tt, n, 0.3, 2.2); }, M);
    S(8.83, (tt, o) => { for (let r = 0; r < 5; r++) K.tick(ac, o, tt + r * 0.04, 0.22, 3000 + r * 300); K.pop(ac, o, tt, 0.25, 700); }, D);
    // S3: Maya asks; her agent types; the files; the fold; the lift and the snap; she cheers
    S(11.33, (tt, o) => { K.pop(ac, o, tt, 0.3, 600); K.pluck(ac, o, tt, 'F#5', 0.3, 0.5); }, M);
    S(12.0, (tt, o) => K.pluck(ac, o, tt, 'A4', 0.5, 0.5), M);
    for (let k = 0; k < 4; k++) S(11.9 + k * 0.25, (tt, o) => { K.tick(ac, o, tt, 0.12, 2400); K.noise(ac, o, tt, 0.2, { type: 'bandpass', freq: 1800, sweepTo: 3200, q: 4, vel: 0.05, attack: 0.08 }); }, D); // the scanner
    for (let k = 0; k < 3; k++) S(12.67 + k * P, (tt, o) => K.mallet(ac, o, tt, ['A5', 'F#5', 'D5'][k], 0.5), M);
    for (const t of [13.5, 13.83]) { S(t, (tt, o) => K.noise(ac, o, tt, 0.2, { type: 'bandpass', freq: 900, sweepTo: 2400, q: 1, vel: 0.2, attack: 0.1 }), M); S(t + 2 * P, (tt, o) => K.mallet(ac, o, tt, 'D3', 0.7), M); }
    S(15.0, (tt, o) => K.whoosh(ac, o, tt, 0.6, 0.1, true), M);
    S(15.67, (tt, o) => K.pop(ac, o, tt, 0.25, 420), D);
    S(16.0, (tt, o) => { K.kick(ac, o, tt, 0.7); K.clap(ac, o, tt, 0.28); K.bass(ac, o, tt, 'B1', 0.6, 0.6); }, D);
    S(16.0, (tt, o) => { K.bell(ac, o, tt, 'F#5', 0.5, 3); K.bell(ac, o, tt, 'B5', 0.3, 3); }, M);
    S(16.17, (tt, o) => { K.pluck(ac, o, tt, 'D6', 0.3, 0.7); K.pluck(ac, o, tt + 0.12, 'F#6', 0.25, 0.7); }, M);
    S(17.5, (tt, o) => { K.bell(ac, o, tt, 'D6', 0.35, 2); K.bell(ac, o, tt, 'A5', 0.3, 2); }, M);
    // S4: the team: Maya walks over, the others drop in and wave; she shares a link; each taps it and the app opens
    S(20.0, (tt, o) => K.whoosh(ac, o, tt, 0.5, 0.14, false), M);
    for (let k = 0; k < 8; k++) S(20.0 + k * 0.125, (tt, o) => K.tick(ac, o, tt, 0.14, 700 + (k % 2) * 140), D);
    TEAM.forEach((p, k) => { if (k) S(20.5 + k * P + 2 * P, (tt, o) => K.pop(ac, o, tt, 0.3, 380 + k * 70), D); });
    TEAM.forEach((p, k) => { const rt = RBT + k * P * 0.5; S(rt + 2 * P, (tt, o) => K.pop(ac, o, tt, 0.26, 300 + k * 60), D); S(rt + 4 * P, (tt, o) => { K.tick(ac, o, tt, 0.2, 2800 + k * 200); K.bell(ac, o, tt, ['D6', 'F#6', 'A6', 'D7'][k], 0.16, 1.2); }, M); });
    S(OPEN[0], (tt, o) => K.tick(ac, o, tt, 0.3, 2400), D);
    S(SHARE, (tt, o) => { K.pop(ac, o, tt, 0.34, 520); K.bell(ac, o, tt, 'A5', 0.36, 1.8); K.bell(ac, o, tt + 0.08, 'D6', 0.3, 1.8); }, M);
    S(21.33, (tt, o) => K.whoosh(ac, o, tt, 0.35, 0.1, false), M);
    typeKeys(21.9, 3, 12, 0.2);
    S(21.9, (tt, o) => K.whoosh(ac, o, tt, 0.4, 0.12, true), M);
    for (let k = 1; k < 4; k++) { S(ARRIVE[k], (tt, o) => K.pluck(ac, o, tt, ['F#5', 'A5', 'D6'][k - 1], 0.34, 0.6), M); S(OPEN[k], (tt, o) => { K.pop(ac, o, tt, 0.3, 600 + k * 80); K.bell(ac, o, tt, ['A5', 'D6', 'F#6'][k - 1], 0.3, 1.6); }, M); }
    EV.forEach((e, k) => { if (e.bot) for (let q = 0; q < 2; q++) S(e.t - 0.5 + q * 0.25, (tt, o) => { K.tick(ac, o, tt, 0.12, 2400); K.noise(ac, o, tt, 0.2, { type: 'bandpass', freq: 1800, sweepTo: 3200, q: 4, vel: 0.05, attack: 0.08 }); }, D); else typeKeys(e.t - 0.5, 5, 10, 0.18); S(e.t, (tt, o) => K.pop(ac, o, tt, 0.32, 650), D); S(e.t + 2 * P, (tt, o) => K.bell(ac, o, tt, ['B5', 'D6', 'E6', 'F#6'][k], 0.4, 2), M); S(e.t + 4 * P, (tt, o) => { for (const n of ['D6', 'G5', 'B5']) K.bell(ac, o, tt, n, 0.18, 1.5); }, M); });
    // S5: apps build on each other
    S(34.0, (tt, o) => K.whoosh(ac, o, tt, 0.5, 0.14, true), M);
    for (const t of Object.values(DROPS)) S(t, (tt, o) => { K.kick(ac, o, tt, 0.32); K.tick(ac, o, tt, 0.25, 2200); }, D);
    LINKS.forEach((l, k) => { S(l.t, (tt, o) => K.tick(ac, o, tt, 0.3, 3000), D); S(l.t + 3 * P, (tt, o) => K.bell(ac, o, tt, ['F#5', 'A5', 'B5', 'D6', 'E6', 'F#6', 'A6'][k], 0.35, 2), M); });
    // S6: the pages come alive: rings from every app on the beat, the quasicrystal shimmering on the pulse, a palette sweep
    S(42.0, (tt, o) => K.whoosh(ac, o, tt, 0.8, 0.12, true), M);
    ['D5', 'E5', 'F#5', 'A5', 'B5', 'D6', 'E6'].forEach((n, k) => S(RINGS_T + k * 0.5, (tt, o) => { K.bell(ac, o, tt, n, 0.26, 2.2, 0.4 * Math.sin(k * 1.7)); K.bell(ac, o, tt + 1 / 6, n.replace(/\d/, (d) => String(+d + 1)), 0.08, 1.2); }, M));
    for (let k = 0; k < 18; k++) { const t = QC_T + k * P; S(t, (tt, o) => { K.tick(ac, o, tt, 0.09 + 0.05 * (k % 3 === 0), 4200 + (k % 6) * 300); K.hat(ac, o, tt, 0.12); }, D); }
    S(45.5, (tt, o) => K.noise(ac, o, tt, 1.8, { type: 'bandpass', freq: 400, sweepTo: 5000, q: 2, vel: 0.08, attack: 1.6 }), M);
    S(46.0, (tt, o) => K.pad(ac, o, tt, ['D3', 'A3', 'E4', 'F#4', 'B4'], 3.4, 0.32, { attack: 1.2, release: 1.6, cutoff: 2200 }), M);
    // the wings: rings from the eye-spots, then a glockenspiel climbing as the cells step into the butterfly
    [EYES_T, EYES_T + 0.5, EYES_T + 1.0, EYES_T + 1.5].forEach((t, k) => S(t, (tt, o) => K.bell(ac, o, tt, ['A5', 'B5', 'D6', 'E6'][k], 0.24, 2), M));
    const CLIMB = ['D5', 'E5', 'F#5', 'A5', 'B5', 'D6', 'E6', 'F#6', 'A6', 'B6', 'D7', 'E7', 'F#7', 'A7', 'D7', 'A6'];
    CLIMB.forEach((n, k) => S(CONV + 0.33 + k * P, (tt, o) => { K.bell(ac, o, tt, n, 0.18 + Math.min(k, 11) * 0.014, 1.4, 0.3 * Math.sin(k)); K.tick(ac, o, tt, 0.1, 2800); }, M));
    S(FORMED, (tt, o) => { for (const n of ['D5', 'F#5', 'A5', 'D6']) K.bell(ac, o, tt, n, 0.3, 3); K.pad(ac, o, tt, ['G2', 'D3', 'B3', 'F#4'], 1.8, 0.3, { attack: 0.3, release: 1.2, cutoff: 1500 }); }, M);
    // alive: a breath on each downstroke; lift-off; a rising phrase over the flight; the approach
    const breath = (t, v) => S(t, (tt, o) => { K.noise(ac, o, tt, 0.32, { type: 'bandpass', freq: 520, sweepTo: 240, q: 0.9, vel: v, attack: 0.07 }); K.noise(ac, o, tt + 0.04, 0.2, { type: 'lowpass', freq: 220, vel: v * 0.8, attack: 0.05 }); }, D);
    breath(51.06, 0.36);
    for (let m = 0; m < 8; m++) breath(51.5 + m * 0.5 + 0.28, 0.3 + (m === 7 ? 0.15 : 0));
    S(51.0, (tt, o) => K.riser(ac, o, tt, 1.0, 0.13), M);
    S(LIFT, (tt, o) => { K.kick(ac, o, tt, 0.45); K.bass(ac, o, tt, 'G1', 0.8, 0.55); }, D);
    [[52.0, 'B4'], [52.5, 'D5'], [53.0, 'G5'], [53.5, 'B5'], [54.0, 'A5'], [54.5, 'D6'], [55.0, 'F#6'], [55.5, 'A6']].forEach(([t, n], k) =>
      S(t, (tt, o) => { K.lead(ac, o, tt, n, k === 7 ? 0.45 : 0.38, 0.75, { cutoff: 3000 }); K.bell(ac, o, tt, n, 0.24, 1.4); }, M));
    S(54.67, (tt, o) => K.riser(ac, o, tt, 1.33, 0.2), M);
    // the bloom: the fullest moment; then the city lives on the pulse
    S(BLOOM, (tt, o) => { K.kick(ac, o, tt, 0.85); K.clap(ac, o, tt, 0.3); K.bass(ac, o, tt, 'D1', 2.0, 0.7); K.noise(ac, o, tt, 1.6, { type: 'highpass', freq: 3000, vel: 0.12, attack: 0.005 }); for (const n of ['D3', 'A3', 'D4', 'F#4', 'A4', 'E5']) K.piano(ac, o, tt, n, 0.4, 3); K.lead(ac, o, tt, 'D6', 1.2, 0.8, { cutoff: 3500 }); }, M);
    S(BLOOM, (tt, o) => K.pad(ac, o, tt, ['D3', 'A3', 'E4', 'F#4', 'A4'], 5.5, 0.5, { attack: 0.4, release: 2, cutoff: 2400 }), M);
    for (let k = 0; k < 12; k++) S(BLOOM + k * P, (tt, o) => { K.bell(ac, o, tt, ['A6', 'F#6', 'E6', 'D6', 'B5', 'A5', 'F#5', 'E5', 'D5', 'A4', 'F#4', 'D4'][k], 0.24, 1.6, k % 2 ? 0.5 : -0.5); K.tick(ac, o, tt, 0.18, 2600); }, M);
    for (let k = 0; k < 12; k++) S(BLOOM + 2 + k * 0.5, (tt, o) => { K.kick(ac, o, tt, 0.4); }, D);
    const CITY = ['D6', 'A5', 'F#6', 'E6', 'B5', 'D6', 'A6', 'F#6', 'G6', 'E6', 'D6', 'B5'];
    for (let k = 0; k < 30; k++) { const t = 57.0 + k * P; S(t, (tt, o) => K.bell(ac, o, tt, CITY[(k * 5) % CITY.length], 0.09 + 0.05 * (k % 3 === 0), 1.0, Math.sin(k * 2.1) * 0.6), M); }
    [[58.0, 'F#5'], [58.5, 'A5'], [59.0, 'B5'], [59.5, 'D6'], [60.0, 'E6'], [60.5, 'D6'], [61.0, 'B5'], [61.5, 'A5']].forEach(([t, n]) => S(t, (tt, o) => K.lead(ac, o, tt, n, 0.4, 0.55, { cutoff: 2800 }), M));
    // the fold: a riser into the biggest chord of the film, as the ring becomes the slot
    S(64.0, (tt, o) => K.noise(ac, o, tt, 0.12, { type: 'bandpass', freq: 2200, q: 2, vel: 0.22 }), D);
    S(65.0, (tt, o) => K.tick(ac, o, tt, 0.08, 900), D); // the name slides out: one quiet low tick
    // the fold (real time from FOLD + AL): a paper swish as each half lifts, rising as they quicken; a soft thump and a note as it lands
    const F0 = FOLD + AL;
    STEPS.forEach((F, m) => {
      const d = F.b - F.a, up = Math.pow(1.16, m);
      if (!F.under) {
        S0(F0 + F.a, (tt, o) => K.noise(ac, o, tt, d * 0.95, { type: 'bandpass', freq: 520 * up, sweepTo: 2600 * up, q: 1.4, vel: 0.11 + m * 0.015, attack: d * 0.55 }), M);
        S0(F0 + F.b, (tt, o) => { K.kick(ac, o, tt, 0.26 + m * 0.04); K.noise(ac, o, tt, 0.14, { type: 'lowpass', freq: 260, vel: 0.3, attack: 0.004 }); K.tick(ac, o, tt, 0.1, 1400 + m * 200); }, D);
        S0(F0 + F.b, (tt, o) => K.mallet(ac, o, tt, ['D5', 'F#5', 'A5', 'D6'][m], 0.34 + m * 0.03), M);
      } else { // the strap: its ends tuck under, a zip of quick clicks running with each
        for (let q = 0; q < 7; q++) S0(F0 + F.a + (q / 7) * d, (tt, o) => { K.tick(ac, o, tt, 0.07 + q * 0.012, 2600 + q * 260 + m * 120); K.noise(ac, o, tt, 0.025, { type: 'bandpass', freq: 3800, q: 3, vel: 0.08 }); }, D);
        S0(F0 + F.b, (tt, o) => K.noise(ac, o, tt, 0.07, { type: 'lowpass', freq: 400, vel: 0.2, attack: 0.003 }), D);
      }
    });
    S0(F0 + 2.12, (tt, o) => K.noise(ac, o, tt, 0.86, { type: 'bandpass', freq: 900, sweepTo: 5200, q: 2.2, vel: 0.08, attack: 0.7 }), M); // the strap pulled through
    BELTF.forEach((F, k) => { // the corners: a short tuck back (A, C), then the turn (B, D) with a swish, landing on a tick
      S0(F0 + F.a, (tt, o) => K.noise(ac, o, tt, (F.b - F.a) * 0.95, { type: 'bandpass', freq: k % 2 ? 900 : 1400, sweepTo: k % 2 ? 4600 : 3000, q: 1.3, vel: k % 2 ? 0.13 : 0.07, attack: (F.b - F.a) * 0.6 }), M);
      if (k < 3) S0(F0 + F.b, (tt, o) => { K.tick(ac, o, tt, 0.12, 1600 + k * 300); if (k === 1) { K.kick(ac, o, tt, 0.36); K.mallet(ac, o, tt, 'A5', 0.42); } }, D);
    });
    S0(F0 + 1.7, (tt, o) => K.riser(ac, o, tt, 2.3, 0.26), M);
    S0(F0 + BELTF[3].b, (tt, o) => { // the buckle clicks shut, under the chord: a short bright metal click
      K.noise(ac, o, tt, 0.035, { type: 'highpass', freq: 3500, vel: 0.5, attack: 0.001 }); K.noise(ac, o, tt + 0.018, 0.03, { type: 'bandpass', freq: 6000, q: 4, vel: 0.35, attack: 0.001 });
      K.bell(ac, o, tt, 'B7', 0.22, 0.35); K.bell(ac, o, tt + 0.012, 'F#7', 0.18, 0.3); K.tick(ac, o, tt, 0.5, 4200);
    }, D);
    S(64.0, (tt, o) => { K.kick(ac, o, tt, 0.9); K.clap(ac, o, tt, 0.25); K.bass(ac, o, tt, 'D1', 2.4, 0.75); for (const n of ['D2', 'A2', 'D3', 'F#3', 'A3', 'C#4', 'E4', 'F#4', 'A4', 'D5']) K.piano(ac, o, tt, n, 0.44, 3.0); K.noise(ac, o, tt, 1.4, { type: 'highpass', freq: 5000, vel: 0.1, attack: 0.005 }); }, M);
    S(64.0, (tt, o) => { K.bell(ac, o, tt, 'D6', 0.5, 3.8); K.bell(ac, o, tt, 'A5', 0.35, 3.4); K.bell(ac, o, tt, 'F#6', 0.25, 3.4); K.pad(ac, o, tt, ['D3', 'A3', 'E4', 'F#4', 'A4'], 1.2, 0.6, { attack: 0.05, release: 2.4, cutoff: 1800 }); }, M); // it resolves and decays to silence before the end
    // the end card, back to Maya
    for (let k = 0; k < 14; k++) { const u = k / 13, tk = URLT.slide + 0.8 * (0.5 - 0.5 * Math.cos(Math.PI * Math.sqrt(u))); S00(tk + INTRO, (tt, o) => K.tick(ac, o, tt, 0.05 + 0.06 * Math.sin(Math.PI * u), 2600 + u * 1800), D); } // the strap cinched: a quick dry zip
    S00(URLT.slide + INTRO, (tt, o) => K.noise(ac, o, tt, 0.8, { type: 'bandpass', freq: 900, sweepTo: 3600, q: 2.5, vel: 0.07, attack: 0.5 }), D);
    S00(67.75 + INTRO, (tt, o) => K.bell(ac, o, tt, 'A5', 0.09, 1.0), M); // openbelt.com, uncovered
    // the intro (film time 0 .. INTRO, after the end's silence): soft; Maya's pixels fly in
    const bytes = atob(BRAND.clasp), clip = ac.createBuffer(1, bytes.length / 2, 44100), samples = clip.getChannelData(0);
    for (let i = 0; i < samples.length; i++) { const n = bytes.charCodeAt(i * 2) | bytes.charCodeAt(i * 2 + 1) << 8; samples[i] = (n >= 32768 ? n - 65536 : n) / 32768; }
    if (offset < MARK_IN + clip.duration && (!K.window || MARK_IN < K.window.to)) {
      const source = ac.createBufferSource(), gain = ac.createGain(), skip = Math.max(0, offset - MARK_IN);
      source.buffer = clip; gain.gain.value = 0.7; source.connect(gain); gain.connect(dest);
      source.start(when + Math.max(0, MARK_IN - offset), skip);
    }
    S00(MARK_BREAK, (tt, o) => K.bell(ac, o, tt, 'A5', 0.12, 1.4), M); // it breaks
    for (let k = 0; k < 6; k++) S00(MARK_BREAK + 0.07 + k * 0.08, (tt, o) => K.tick(ac, o, tt, 0.06 + k * 0.01, 2200 + k * 260), D);
    S00(MARK_BREAK + 0.75, (tt, o) => K.pluck(ac, o, tt, 'D6', 0.16, 0.6), M); // Maya
  }

  return { title: 'OpenBelt: the butterfly city', logline: 'Maya connects her tools once. Every agent can use them, her whole team uses the apps, and every app makes the next one easier.', duration: DUR, bg: PAPER, poster: 67.45, draw, score };
})();
