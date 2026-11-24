(() => {
  'use strict';

  /* ───────────── helpers ───────────── */
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const loginScreen = $('login-screen');
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const prog = (t, start, dur) => clamp((t - start) / dur);

  // cubic-bezier(x1,y1,x2,y2) → easing function
  function bez(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (t) => ((ax * t + bx) * t + cx) * t;
    const Y = (t) => ((ay * t + by) * t + cy) * t;
    const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const e = X(t) - x;
        if (Math.abs(e) < 1e-5) return Y(t);
        const d = dX(t);
        if (Math.abs(d) < 1e-6) break;
        t -= e / d;
      }
      let lo = 0, hi = 1; t = x;
      while (hi - lo > 1e-6) {
        const e = X(t);
        if (Math.abs(e - x) < 1e-5) break;
        if (x > e) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return Y(t);
    };
  }

  const OUT   = bez(0.22, 1, 0.36, 1);   // brand curve: smooth deceleration, no bounce
  const WIND  = bez(0.25, 1, 0.5, 1);    // wind ribbons
  const FALLY = bez(0.35, 0.1, 0.35, 1); // leaf descent (vertical)
  const FALLX = bez(0.25, 0.1, 0.25, 1); // leaf descent (horizontal drift)
  const FALLR = bez(0.30, 0.0, 0.30, 1); // leaf descent (rotation)
  const LIFT  = bez(0.35, 0.0, 0.15, 1); // leaf rise to the header
  const AMBX  = bez(0.20, 0.6, 0.40, 1); // ambient leaves, carried by the breeze

  const hex2rgb = (h) => {
    h = h.trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const mixRGB = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
  const css = (a) => `rgb(${a.map(Math.round).join(',')})`;

  function rotAbout(px, py, cx, cy, deg) {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const dx = px - cx, dy = py - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  /* ───────────── elements ───────────── */
  const scene = $('scene'), leavesEl = $('leaves'), flier = $('flier');
  const glyph = flier.querySelector('.glyph'), badge = flier.querySelector('.badge');
  const logo = $('logoBadge'), boughs = $('boughs');
  const crown = [...scene.querySelectorAll('.crown')];
  const ribbons = [
    { el: $('ribbon1'), start: 0.60, dur: 0.95 },
    { el: $('ribbon2'), start: 0.72, dur: 0.95 }
  ];
  const reveals = [...document.querySelectorAll('[data-reveal]')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  const LEAF_SVG = '<svg viewBox="0 0 48 48"><path class="blade" d="M24 3.5C33.2 8.1 40.2 17.2 37.7 26.8C35.5 35.6 27.8 42.2 19.7 45C11.7 39.4 7.3 29.7 9.7 20.3C11.7 12.3 17.5 6.6 24 3.5Z"/><path class="rib" d="M24 5.5C24 16 22.5 29 19.9 42.5"/><path class="leaf-veins" d="M23.6 13.2C19.5 12.1 16.5 10.2 13.8 8.6M23.6 13.2C28 13 31.4 11.3 34.1 9.2M23 20C18.8 18.8 15.1 16.3 12.2 13.5M23 20C28.1 19.1 32.1 16.6 35.6 13.1M22.2 27C17.9 25 14.6 22.1 11.8 19M22.2 27C27.1 25.5 31.3 22.8 36.3 18.4M21.2 34C17.2 31.2 14.7 28.6 12.8 25.6M21.2 34C25.4 32 29.4 29.2 33.7 25.2"/></svg>';

  /* ───────────── timeline (seconds) ───────────── */
  const T = {
    windStart: 0.60,          // 2. breeze & scatter
    detach: 1.25,             //    focal leaf lets go of the bough
    fallStart: 1.80,          // 3. descent
    touch: 2.50,              //    ground contact
    holdEnd: 2.65,            //    150 ms beat of stillness
    liftEnd: 3.35,            // 4. elevation to header
    morphStart: 3.20,         //    leaf → emblem badge
    morphEnd: 3.50,
    uiStart: 3.00,            //    split-screen reveal (+ per-item stagger)
    end: 3.56
  };
  const REST_ROT = 84;        // leaf lies almost flat on the ground
  const FINAL_ROT = 35;       // matches the logo glyph tilt
  const FINAL_SCALE = 0.55;   // matches the logo glyph size

  /* ───────────── wind physics: damped spring "gust" ───────────── */
  // step response of an under-damped spring; a gust = step up, then step down
  const K = 4.5, W = 2 * Math.PI;
  const S = (u) => u <= 0 ? 0 : 1 - Math.exp(-K * u) * (Math.cos(W * u) + (K / W) * Math.sin(W * u));
  const sway = (t) => 3.2 * (S(t - 0.65) - S(t - 1.15));   // degrees, positive = lean right

  /* ───────────── state ───────────── */
  let running = false, raf = 0, t0 = 0;
  let g, amb, FOCAL, FOCAL_RGB, LEAFG, GLOW;
  let target, P1, P2, sF, u, restHalf;

  const P = (vx, vy) => ({ x: g.x + vx * g.u, y: g.y + vy * g.u });

  function measure() {
    scene.style.transform = ''; scene.style.opacity = '';
    const r = scene.getBoundingClientRect();
    g = { x: r.left, y: r.top, u: r.width / 800 };
    u = g.u;
    sF = 0.95 * u;                                   // leaf ≈ 38 scene-units long
    const lr = logo.getBoundingClientRect();
    target = { x: lr.left + lr.width / 2, y: lr.top + lr.height / 2 };
  }

  // Focal leaf while still attached to the right bough (follows the bough flex)
  function attached(t) {
    const ab = sway(t) * 0.8;
    const [vx, vy] = rotAbout(480.2, 364.6, 400, 410, ab);
    const p = P(vx, vy);
    return { x: p.x, y: p.y, rot: 140 + ab * 1.4 };
  }

  function buildAmbient() {
    leavesEl.innerHTML = '';
    const defs = [
      { vx: 511, vy: 190, t: 0.82, d: 1.45, dy: 0.18, spin: 210, ph: 0.3, k: 0.72, c: '#88BF6E' },
      { vx: 468, vy: 133, t: 0.92, d: 1.55, dy: 0.26, spin: -180, ph: 1.4, k: 0.66, c: '#A9D395' },
      { vx: 497, vy: 162, t: 1.02, d: 1.40, dy: 0.12, spin: 260, ph: 2.1, k: 0.78, c: '#5B8A4D' },
      { vx: 420, vy: 114, t: 1.12, d: 1.50, dy: 0.30, spin: -230, ph: 0.8, k: 0.62, c: '#88BF6E' },
      { vx: 516, vy: 250, t: 1.22, d: 1.30, dy: 0.10, spin: 190, ph: 2.8, k: 0.70, c: '#A9D395' }
    ];
    amb = defs.map((d, i) => {
      const [vx, vy] = rotAbout(d.vx, d.vy, 400, 345, sway(d.t));
      const p = P(vx, vy);
      const el = document.createElement('div');
      el.className = 'leaf';
      el.innerHTML = LEAF_SVG;
      el.style.setProperty('--c', d.c);
      leavesEl.appendChild(el);
      return {
        el, x0: p.x, y0: p.y, t: d.t, d: d.d, k: d.k * sF,
        tx: (innerWidth - p.x) * 0.92,
        dy: d.dy * 500 * u,
        fl: 10 * u, ph: d.ph, spin: d.spin, rot0: 30 + i * 25
      };
    });
  }

  /* ───────────── frame update ───────────── */
  function update(t) {
    // wind ribbons sweep left → right
    for (const r of ribbons) {
      const p = clamp((t - r.start) / r.dur);
      r.el.style.strokeDasharray = '0.3 2';
      r.el.style.strokeDashoffset = (0.3 - 1.3 * WIND(p)).toFixed(4);
      r.el.style.opacity = (Math.sin(Math.PI * p) * 0.75).toFixed(3);
    }

    // crown layers sway with a slight lag (weighted, not rubbery)
    crown.forEach((el, i) => {
      el.setAttribute('transform', `rotate(${(sway(t - i * 0.07) * (1 + 0.2 * i)).toFixed(3)} 400 345)`);
    });
    boughs.setAttribute('transform', `rotate(${(sway(t) * 0.8).toFixed(3)} 400 410)`);

    // ambient leaves drift out on the breeze
    for (const L of amb) {
      const p = clamp((t - L.t) / L.d);
      if (t < L.t || p >= 1) { L.el.style.opacity = 0; continue; }
      const e = AMBX(p);
      const x = L.x0 + L.tx * e;
      const y = L.y0 + L.dy * e + L.fl * Math.sin(2 * Math.PI * 1.1 * p + L.ph) * Math.sin(Math.PI * p);
      const fade = clamp((p - 0.5) / 0.5);
      const o = clamp(p / 0.08) * (1 - fade * fade * (3 - 2 * fade));
      L.el.style.opacity = o.toFixed(3);
      L.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${(L.rot0 + L.spin * e).toFixed(1)}deg) scale(${L.k.toFixed(3)})`;
    }

    // ── focal leaf ──
    let x, y, rot, scale = sF;
    if (t <= T.detach) {
      const a = attached(t); x = a.x; y = a.y; rot = a.rot;
    } else if (t <= T.fallStart) {
      const sep = OUT(prog(t, T.detach, T.fallStart - T.detach));
      x = lerp(P1.base.x, P1.x, sep); y = lerp(P1.base.y, P1.y, sep);
      rot = lerp(P1.base.rot, P1.rot, sep);
    } else if (t <= T.touch) {
      const p = prog(t, T.fallStart, T.touch - T.fallStart);
      const sw = 2 * Math.PI * 1.5 * p;
      x = lerp(P1.x, P2.x, FALLX(p)) + 34 * u * (1 - p) * Math.sin(sw);
      y = lerp(P1.y, P2.y, FALLY(p));
      rot = lerp(P1.rot, REST_ROT, FALLR(p)) + 24 * (1 - p) * (Math.sin(sw + 0.7) - Math.sin(0.7));
    } else if (t <= T.holdEnd) {
      x = P2.x; y = P2.y; rot = REST_ROT;                 // the 150 ms beat
    } else {
      const e = LIFT(prog(t, T.holdEnd, T.liftEnd - T.holdEnd));
      x = lerp(P2.x, target.x, e); y = lerp(P2.y, target.y, e);
      rot = lerp(REST_ROT, FINAL_ROT, e);
    }

    // colour: catches the light on the bough, then turns white as it becomes the emblem
    const lightP = OUT(prog(t, 1.0, 0.75));
    let col = mixRGB(LEAFG, FOCAL_RGB, lightP);
    const m = OUT(prog(t, T.morphStart, T.morphEnd - T.morphStart));
    col = mixRGB(col, [255, 255, 255], m);
    scale = lerp(sF, FINAL_SCALE, m);

    const glow = Math.sin(Math.PI * prog(t, 1.1, 1.0)) * (1 - m);
    flier.style.opacity = 1;
    flier.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px)`;
    glyph.style.transform = `rotate(${rot.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
    glyph.style.setProperty('--c', css(col));
    glyph.style.filter = glow > 0.02
      ? `drop-shadow(0 0 ${(glow * 12).toFixed(1)}px rgba(${GLOW},${(glow * 0.6).toFixed(2)}))` : 'none';
    badge.style.opacity = m.toFixed(3);
    badge.style.transform = `scale(${lerp(0.35, 1, m).toFixed(3)})`;

    // tree + ground dissolve outward to make room for the workspace
    const d = OUT(prog(t, T.holdEnd, 0.6));
    scene.style.opacity = (1 - d).toFixed(3);
    scene.style.transform = `scale(${lerp(1, 0.98, d).toFixed(4)})`;

    // split-screen reveal: staggered 8px rise over 300ms
    for (const el of reveals) {
      const p = OUT(prog(t, T.uiStart + parseFloat(el.dataset.reveal), 0.3));
      el.style.opacity = p.toFixed(3);
      if (!el.classList.contains('brand-bg')) el.style.transform = `translateY(${((1 - p) * 8).toFixed(2)}px)`;
    }
  }

  function clearInline() {
    for (const el of reveals) { el.style.opacity = ''; el.style.transform = ''; }
    scene.style.cssText = '';
    for (const r of ribbons) r.el.style.cssText = '';
    crown.forEach((el) => el.removeAttribute('transform'));
    boughs.removeAttribute('transform');
    flier.style.cssText = ''; glyph.style.cssText = ''; badge.style.cssText = '';
    leavesEl.innerHTML = '';
  }

  function finish() {
    running = false;
    root.classList.remove('intro');
    clearInline();
    loginScreen?.classList.remove('intro-running');
    loginScreen?.classList.add('intro-complete');
    $('login-email')?.focus({ preventScroll: true });
  }

  function tick(now) {
    if (!t0) t0 = now;
    const t = (now - t0) / 1000;
    update(Math.min(t, T.end));
    if (t < T.end) raf = requestAnimationFrame(tick);
    else finish();
  }

  function play() {
    if (running || reduced.matches) return;
    running = true; t0 = 0;
    root.classList.add('intro');
    clearInline();

    refreshThemeColors();

    measure();
    buildAmbient();

    // key positions for the focal leaf
    const base = attached(T.detach);
    P1 = { base, x: base.x + 16 * u, y: base.y - 8 * u, rot: base.rot + 12 };
    const rr = REST_ROT * Math.PI / 180;
    restHalf = sF * (20 * Math.cos(rr) + 13 * Math.sin(rr));        // half-height of the resting leaf
    const ground = P(448, 460);
    P2 = { x: ground.x, y: ground.y - restHalf - 1 * u };            // rests on the ground line

    update(0);
    raf = requestAnimationFrame(tick);
  }

  /* ───────────── CleanTrack app integration ─────────────
     app.js controls login visibility; this module controls only the intro animation. */
  let openFrame1 = 0, openFrame2 = 0;

  function openLoginIntro() {
    if (!loginScreen) return;

    // Every explicit Register / Sign in opening starts the same complete intro again.
    if (openFrame1) cancelAnimationFrame(openFrame1);
    if (openFrame2) cancelAnimationFrame(openFrame2);
    if (raf) cancelAnimationFrame(raf);
    running = false;
    t0 = 0;
    root.classList.remove('intro');
    clearInline();

    if (reduced.matches) {
      loginScreen.classList.remove('intro-running');
      loginScreen.classList.add('intro-complete');
      $('login-email')?.focus({ preventScroll: true });
      return;
    }

    loginScreen.classList.remove('intro-complete');
    loginScreen.classList.add('intro-running');
    openFrame1 = requestAnimationFrame(() => {
      openFrame2 = requestAnimationFrame(() => {
        if (!loginScreen.classList.contains('hidden')) play();
      });
    });
  }

  function closeLoginIntro() {
    if (openFrame1) cancelAnimationFrame(openFrame1);
    if (openFrame2) cancelAnimationFrame(openFrame2);
    if (raf) cancelAnimationFrame(raf);
    running = false;
    root.classList.remove('intro');
    clearInline();
    loginScreen?.classList.remove('intro-running', 'intro-complete');
  }

  function refreshThemeColors() {
    const cs = getComputedStyle(root);
    FOCAL = cs.getPropertyValue('--focal').trim() || (root.dataset.theme === 'dark' ? '#FFFFFF' : '#7BC462');
    FOCAL_RGB = hex2rgb(FOCAL);
    LEAFG = hex2rgb('#88BF6E');
    GLOW = FOCAL_RGB.join(',');
  }

  window.CleanTrackIntro = {
    open: openLoginIntro,
    close: closeLoginIntro,
    refreshThemeColors,
    replay: () => {
      closeLoginIntro();
      openLoginIntro();
    }
  };
})();
