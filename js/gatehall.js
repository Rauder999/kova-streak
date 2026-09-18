// The Gate hall: what a hunter stands in front of before turning a key.
//
// The descent in gate.js is the event. This is the doorway to it, and it has
// a job of its own: the key in your hand cost a whole day of training, so the
// screen that takes it has to look like it knows that.
//
// It is the System's own summoning circle, seen face on: rings inside rings
// turning against each other, a rune band, a hexagram, and a dark well in the
// middle where the Hoard burns. Around it reality is FRACTURED: cracks run
// out of the rim into the dark, bleeding light.
//
// HOW IT STAYS AT 60fps. Every light here is three strokes, a wide dim bloom,
// a body and a white hot core, and that glow is canvas shadowBlur, which is
// about seventeen times the cost of the same stroke without it: measured on
// this machine, 300 shadowed strokes cost 187ms at dpr 1 and 805ms at dpr 2,
// against a frame budget of 16.7ms. The first cut of this screen drew some
// three hundred and fifty of them per frame and ran at fifteen.
//
// So none of that is drawn per frame. Everything that only TURNS is baked
// once into an offscreen layer and blitted back with a rotation, which costs
// one drawImage. What is left live is the handful of things that genuinely
// change shape: the vortex arms, the sparks, the bolts and the pulses, none
// of which need a shadow except the bolts, of which there are at most three.
// Rebuilds happen on resize and when the Gate is sealed or unsealed, never
// in a frame.
//
// Everything in front of it, the figure and the one control, is flat HTML:
// the art never fights the words.

const ACCENT = [139, 124, 255];
const ACCENT_SOFT = [207, 201, 255];
const GOLD = [232, 182, 74];
const GOLD_SOFT = [245, 217, 154];
const ASH = [126, 108, 132];
const BAD = [229, 72, 77];

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (t) => 1 - (1 - t) ** 3;
const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const CRACKS = 24;
const SPARKS = 80;
const VORTEX = 12;

// one stroke with its glow, on whichever context is being drawn into
function glowPath(g, path, color, width, blur, alpha) {
  g.save();
  g.strokeStyle = color;
  g.shadowColor = color;
  g.shadowBlur = blur;
  g.lineWidth = width;
  g.globalAlpha = alpha;
  path(g);
  g.stroke();
  g.restore();
}

// the three stroke recipe: a wide dim bloom, a body, a white hot core
function ring3(g, r, color, body, alpha, dash) {
  const path = (gg) => {
    gg.beginPath();
    if (dash) gg.setLineDash(dash);
    gg.arc(0, 0, r, 0, Math.PI * 2);
  };
  g.save();
  glowPath(g, path, color, body * 7, 30, 0.14 * alpha);
  glowPath(g, path, color, body, 15, 0.95 * alpha);
  glowPath(g, path, '#FFFFFF', body * 0.42, 7, 0.7 * alpha);
  g.setLineDash([]);
  g.restore();
}

class Hall {
  constructor(canvas, opts) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.o = opts || {};
    this.t = 0;            // seconds of turning, the only clock the rings read
    this.heat = 0;         // 0 at rest, 1 with a hand on the key
    this.heatTarget = 0;
    this.burst = 0;        // the flare when the key turns
    this.sparks = [];
    this.cracks = [];
    this.shocks = [];
    this.arcs = [];
    this.nextArc = 1.2;
    this.nextShock = 3;
    this.layers = null;
    this.bakedSealed = null;
    this.running = true;
    this.last = performance.now();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this.onResize);
      this.ro.observe(canvas);
    }
    for (let i = 0; i < CRACKS; i++) this.cracks.push(this.newCrack(i));
    for (let i = 0; i < SPARKS; i++) this.sparks.push(this.newSpark(true));
    this.resize();
    canvas.__hall = this; // so the frame cost can be measured from the console
    if (reduced()) { this.t = 3; this.draw(); return; }
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    // the art is soft glow: a third of the pixels of a retina buffer is free
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const r = this.c.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width));
    const H = Math.max(1, Math.round(r.height));
    const same = W === this.W && H === this.H;
    this.W = W;
    this.H = H;
    this.c.width = Math.round(W * this.dpr);
    this.c.height = Math.round(H * this.dpr);
    this.x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.cx = W / 2;
    // on a phone the readouts cannot stand beside the circle, so they sit
    // above it and the circle drops to make room
    this.cy = H * (W < 720 ? 0.57 : 0.5);
    this.R = clamp(Math.min(W * (W < 720 ? 0.42 : 0.34), H * 0.4), 120, 330);
    if (!same || !this.layers) this.bake();
    this.gradients();
    if (reduced()) this.draw();
  }

  stop() {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    if (this.ro) this.ro.disconnect();
    this.layers = null;
  }

  get sealed() { return !!this.o.sealed; }
  hue() { return this.sealed ? mix(ASH, BAD, 0.3) : ACCENT; }

  // ---------- the baked layers ----------

  // an offscreen square with its origin at the centre, in CSS units
  makeLayer(half, fn) {
    const side = Math.max(2, Math.ceil(half * 2 * this.dpr));
    const c = document.createElement('canvas');
    c.width = side;
    c.height = side;
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, half * this.dpr, half * this.dpr);
    fn(g);
    return { canvas: c, half };
  }

  bake() {
    const R = this.R;
    const hue = this.hue();
    const c = rgba(hue, 1);
    const hot = this.sealed ? rgba(mix(ASH, BAD, 0.6), 1) : rgba(ACCENT_SOFT, 1);
    this.bakedSealed = this.sealed;

    // outer orbit: dashed, with diamond nodes riding it
    const orbit = this.makeLayer(R * 1.17, (g) => {
      ring3(g, R * 1.12, c, 1, 0.4, [R * 0.055, R * 0.05]);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        g.save();
        g.translate(Math.cos(a) * R * 1.12, Math.sin(a) * R * 1.12);
        g.rotate(a);
        const d = i % 3 === 0 ? 6 : 3.4;
        g.beginPath();
        g.moveTo(0, -d); g.lineTo(d * 0.8, 0); g.lineTo(0, d); g.lineTo(-d * 0.8, 0); g.closePath();
        g.fillStyle = hot;
        g.shadowColor = c;
        g.shadowBlur = 12;
        g.globalAlpha = 0.75;
        g.fill();
        g.restore();
      }
    });

    // a fine tick collar
    const collar = this.makeLayer(R * 1.1, (g) => {
      g.strokeStyle = c;
      g.shadowColor = c;
      g.shadowBlur = 6;
      g.globalAlpha = 0.35;
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * Math.PI * 2;
        const long = i % 10 === 0;
        const r0 = R * (long ? 1.015 : 1.045);
        g.lineWidth = long ? 1.4 : 0.7;
        g.beginPath();
        g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        g.lineTo(Math.cos(a) * R * 1.07, Math.sin(a) * R * 1.07);
        g.stroke();
      }
    });

    // THE RIM, and the rune band written inside it
    const band = this.makeLayer(R * 1.06, (g) => {
      ring3(g, R, c, 2.2, 1);
      ring3(g, R * 0.9, c, 1, 0.5);
      g.strokeStyle = c;
      g.shadowColor = c;
      g.shadowBlur = 9;
      g.globalAlpha = 0.55;
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const long = i % 4 === 0;
        const r0 = R * (long ? 0.905 : 0.945);
        g.lineWidth = long ? 1.6 : 0.8;
        g.beginPath();
        g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        g.lineTo(Math.cos(a) * R * 0.995, Math.sin(a) * R * 0.995);
        g.stroke();
      }
      g.globalAlpha = 0.8;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        g.save();
        g.rotate(a);
        g.translate(R * 0.945, 0);
        g.rotate(Math.PI / 2);
        g.lineWidth = 1.2;
        g.beginPath();
        g.rect(-7, -R * 0.045, 14, R * 0.045);
        g.moveTo(-7, -R * 0.02); g.lineTo(7, -R * 0.02);
        g.moveTo(0, -R * 0.045); g.lineTo(0, 0);
        g.stroke();
        g.restore();
      }
    });

    // four arc segments with a spoke out of each head
    const segs = this.makeLayer(R * 1.04, (g) => {
      for (let i = 0; i < 4; i++) {
        const a0 = (i / 4) * Math.PI * 2;
        const path = (gg) => { gg.beginPath(); gg.arc(0, 0, R * 0.78, a0, a0 + 1.15); };
        glowPath(g, path, c, 9, 22, 0.1);
        glowPath(g, path, c, 2.4, 12, 0.7);
        glowPath(g, path, '#FFFFFF', 0.9, 5, 0.45);
        g.save();
        g.rotate(a0);
        g.strokeStyle = c;
        g.shadowColor = c;
        g.shadowBlur = 10;
        g.globalAlpha = 0.5;
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(R * 0.78, 0);
        g.lineTo(R * 0.99, 0);
        g.stroke();
        g.restore();
      }
    });

    // one triangle of the hexagram; the other is the same image mirrored in time
    const tri = this.makeLayer(R * 0.7, (g) => {
      const path = (gg) => {
        gg.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
          const px = Math.cos(a) * R * 0.64;
          const py = Math.sin(a) * R * 0.64;
          if (!i) gg.moveTo(px, py); else gg.lineTo(px, py);
        }
        gg.closePath();
      };
      glowPath(g, path, c, 8.5, 20, 0.08);
      glowPath(g, path, c, 1.7, 10, 0.5);
    });

    // the inner collar
    const inner = this.makeLayer(R * 0.58, (g) => {
      ring3(g, R * 0.52, c, 1.2, 0.6);
      g.strokeStyle = c;
      g.shadowColor = c;
      g.shadowBlur = 7;
      g.globalAlpha = 0.45;
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        g.lineWidth = i % 3 === 0 ? 1.3 : 0.7;
        g.beginPath();
        g.moveTo(Math.cos(a) * R * 0.47, Math.sin(a) * R * 0.47);
        g.lineTo(Math.cos(a) * R * 0.515, Math.sin(a) * R * 0.515);
        g.stroke();
      }
    });

    // the head of light that runs the rim, with its tail behind it
    const sweep = this.makeLayer(R * 1.06, (g) => {
      const steps = 14;
      const tail = 1.35;
      g.lineCap = 'round';
      for (let i = 0; i < steps; i++) {
        const k = i / steps;
        const a0 = -tail * k;
        const a1 = -tail * ((i + 1) / steps);
        const path = (gg) => { gg.beginPath(); gg.arc(0, 0, R, a1, a0); };
        const f = (1 - k) ** 2;
        glowPath(g, path, c, 5 * f + 1, 20, 0.34 * f);
        if (i < 3) glowPath(g, path, '#FFFFFF', 2.4 - i * 0.7, 11, 0.85);
      }
    });

    // what is barred is shown barred
    const bars = !this.sealed ? null : this.makeLayer(R * 1.15, (g) => {
      g.strokeStyle = rgba(BAD, 0.55);
      g.shadowColor = rgba(BAD, 1);
      g.shadowBlur = 20;
      g.lineWidth = 8;
      g.lineCap = 'round';
      for (const a of [-0.34, 0.34]) {
        g.beginPath();
        g.moveTo(-Math.cos(a) * R * 1.1, -Math.sin(a) * R * 1.1);
        g.lineTo(Math.cos(a) * R * 1.1, Math.sin(a) * R * 1.1);
        g.stroke();
      }
    });

    // Reality, fractured. These do not turn, so they are baked at the size of
    // the canvas and blitted straight back; two of them, breathing out of
    // phase, so the fractures still flicker against each other.
    const half = Math.max(this.W, this.H);
    const crackLayer = (parity) => this.makeLayer(half / 2, (g) => {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (let i = 0; i < this.cracks.length; i++) {
        if (i % 2 !== parity) continue;
        const k = this.cracks[i];
        const line = (pts, from) => (gg) => {
          gg.beginPath();
          gg.moveTo(Math.cos(from[1]) * R * from[0], Math.sin(from[1]) * R * from[0]);
          for (const [pr, pa] of pts) gg.lineTo(Math.cos(pa) * R * pr, Math.sin(pa) * R * pr);
        };
        const start = [1.0, k.pts[0][1]];
        glowPath(g, line(k.pts, start), c, k.w * 3.2, 18, 0.1);
        glowPath(g, line(k.pts, start), c, k.w, 9, 0.5);
        glowPath(g, line(k.pts.slice(0, Math.ceil(k.pts.length * 0.55)), start), '#FFFFFF', k.w * 0.4, 5, 0.42);
        if (k.fork) glowPath(g, line(k.fork.pts, k.pts[k.fork.at]), c, k.w * 0.7, 8, 0.35);
      }
    });

    this.layers = { orbit, collar, band, segs, tri, inner, sweep, bars, cracks: [crackLayer(0), crackLayer(1)] };
  }

  // the fills that cover the whole canvas, built once and modulated by alpha
  gradients() {
    const x = this.x;
    const live = !this.sealed;
    const hue = this.hue();
    const amb = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, Math.max(this.W, this.H) * 0.62);
    amb.addColorStop(0, rgba(live ? GOLD : BAD, 0.055));
    amb.addColorStop(0.22, rgba(hue, 0.09));
    amb.addColorStop(0.62, rgba(hue, 0.025));
    amb.addColorStop(1, rgba(hue, 0));
    this.gAmbient = amb;

    const dark = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, this.R);
    dark.addColorStop(0, 'rgba(2,2,5,0.98)');
    dark.addColorStop(0.6, 'rgba(4,4,10,0.92)');
    dark.addColorStop(1, 'rgba(6,5,14,0.4)');
    this.gDark = dark;

    const pc = this.sealed ? BAD : GOLD;
    const core = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, this.R * 0.62);
    core.addColorStop(0, rgba(this.sealed ? BAD : GOLD_SOFT, this.sealed ? 0.12 : 0.3));
    core.addColorStop(0.45, rgba(pc, this.sealed ? 0.05 : 0.1));
    core.addColorStop(1, rgba(pc, 0));
    this.gCore = core;

    const arms = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, this.R);
    arms.addColorStop(0, rgba(this.sealed ? BAD : GOLD_SOFT, 0.5));
    arms.addColorStop(0.55, rgba(hue, 0.22));
    arms.addColorStop(1, rgba(hue, 0));
    this.gArms = arms;

    const scrim = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, this.R * 0.95);
    scrim.addColorStop(0, 'rgba(4,4,9,0.9)');
    scrim.addColorStop(0.55, 'rgba(4,4,9,0.6)');
    scrim.addColorStop(1, 'rgba(4,4,9,0)');
    this.gScrim = scrim;
  }

  // ---------- the live bits ----------

  newCrack(i) {
    const a0 = (i / CRACKS) * Math.PI * 2 + rnd(-0.16, 0.16);
    const pts = [];
    let r = 1.0;
    let a = a0;
    const reach = rnd(0.35, 1.5);
    while (r < 1 + reach) {
      r += rnd(0.07, 0.2);
      a += rnd(-0.11, 0.11);
      pts.push([r, a]);
    }
    let fork = null;
    if (Math.random() < 0.55 && pts.length > 3) {
      const at = 1 + Math.floor(Math.random() * (pts.length - 2));
      const f = [];
      let fr = pts[at][0];
      let fa = pts[at][1] + (Math.random() < 0.5 ? -1 : 1) * rnd(0.18, 0.4);
      const fReach = rnd(0.12, 0.5);
      while (fr < pts[at][0] + fReach) {
        fr += rnd(0.06, 0.16);
        fa += rnd(-0.12, 0.12);
        f.push([fr, fa]);
      }
      fork = { at, pts: f };
    }
    return { pts, fork, w: rnd(0.8, 2.6) };
  }

  newSpark(spread) {
    return {
      r: spread ? rnd(0.16, 2.0) : rnd(1.6, 2.3),
      a: rnd(0, Math.PI * 2),
      v: rnd(0.18, 0.62),   // radii per second, inward
      av: rnd(0.25, 0.95),  // how hard it spirals
      len: rnd(0.02, 0.09),
      al: rnd(0.2, 0.9),
      w: rnd(0.6, 2),
    };
  }

  // a bolt jumping between two rings, drawn once and held for a few frames
  newArc() {
    const r0 = [0.54, 0.66, 0.8, 1.0][Math.floor(Math.random() * 4)];
    const r1 = r0 + rnd(0.1, 0.34);
    const a0 = rnd(0, Math.PI * 2);
    const a1 = a0 + rnd(-0.5, 0.5);
    const pts = [];
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const jitter = i === 0 || i === n ? 0 : rnd(-0.045, 0.045);
      pts.push([r0 + (r1 - r0) * k + jitter, a0 + (a1 - a0) * k + jitter * 2]);
    }
    return { pts, t: 0, dur: rnd(0.12, 0.3), w: rnd(0.9, 2.2) };
  }

  shock(from, to, dur, w) { this.shocks.push({ t: 0, dur, from, to, w }); }

  frame(t) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    try { this.update(dt); this.draw(); } catch { /* a drawing hiccup never breaks the tab */ }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  update(dt) {
    if (this.layers && this.bakedSealed !== this.sealed) { this.bake(); this.gradients(); }
    const speed = 1 + this.heat * 1.1 + this.burst * 2.5;
    this.t += dt * speed;
    this.heat += (this.heatTarget - this.heat) * Math.min(1, dt * 3.2);
    this.burst *= Math.exp(-dt * 2.2);

    const pull = this.sealed ? -0.35 : 1 + this.heat * 0.9 + this.burst * 3;
    for (const s of this.sparks) {
      s.r -= s.v * dt * pull;
      s.a += s.av * dt * (0.6 + (1.4 - clamp(s.r, 0, 1.4)));
      if (s.r < 0.1 || s.r > 2.6) Object.assign(s, this.newSpark(false));
    }

    for (const sh of this.shocks) sh.t += dt;
    this.shocks = this.shocks.filter((sh) => sh.t < sh.dur);
    this.nextShock -= dt * speed;
    if (this.nextShock <= 0 && !this.sealed) {
      this.nextShock = rnd(3.2, 6.5);
      this.shocks.push({ t: 0, dur: 1.7, from: 1, to: 1.85, w: 1.4 });
    }

    for (const a of this.arcs) a.t += dt;
    this.arcs = this.arcs.filter((a) => a.t < a.dur);
    this.nextArc -= dt * speed;
    if (this.nextArc <= 0) {
      this.nextArc = this.sealed ? rnd(1.6, 3.4) : rnd(0.35, 1.5);
      this.arcs.push(this.newArc());
    }
  }

  polar(r, a) { return [this.cx + Math.cos(a) * this.R * r, this.cy + Math.sin(a) * this.R * r]; }

  // one baked layer, put back with a turn on it
  blit(layer, angle, alpha, scale = 1, additive) {
    if (!layer || alpha <= 0.002) return;
    const x = this.x;
    x.save();
    if (additive) x.globalCompositeOperation = 'lighter';
    x.translate(this.cx, this.cy);
    if (angle) x.rotate(angle);
    if (scale !== 1) x.scale(scale, scale);
    x.globalAlpha = Math.min(1, alpha);
    x.drawImage(layer.canvas, -layer.half, -layer.half, layer.half * 2, layer.half * 2);
    x.restore();
  }

  draw() {
    const { x, W, H } = this;
    const L = this.layers;
    if (!L) return;
    const live = !this.sealed;
    const lit = clamp((live ? 0.82 + this.heat * 0.3 : 0.4) + this.burst * 0.45, 0, 1);
    const pulse = 1 + Math.sin(this.t * 1.15) * 0.012;
    const t = this.t;
    x.clearRect(0, 0, W, H);

    // what the hole is pouring into the room
    x.save();
    x.globalAlpha = lit;
    x.fillStyle = this.gAmbient;
    x.fillRect(0, 0, W, H);
    x.restore();

    // the fractures, breathing out of phase with each other
    const grow = clamp(t / 1.1, 0, 1);
    for (let i = 0; i < 2; i++) {
      const breathe = 0.55 + 0.45 * Math.max(0, Math.sin(t * (i ? 0.62 : 0.43) + i * 2.1));
      this.blit(L.cracks[i], 0, breathe * lit * 0.9 * easeOut(grow));
    }

    this.drawWell(lit, pulse);

    this.blit(L.orbit, t * 0.085, lit, pulse);
    this.blit(L.collar, -t * 0.15, lit);
    this.blit(L.band, t * 0.21, lit, pulse);
    if (this.heat > 0.02) this.blit(L.band, t * 0.21, this.heat * 0.4, pulse, true);
    this.blit(L.sweep, t * 0.95, lit, pulse);
    this.blit(L.segs, -t * 0.36, lit);
    this.blit(L.tri, t * 0.16, lit);
    this.blit(L.tri, -t * 0.16 + Math.PI / 3, lit);
    this.blit(L.inner, t * 0.44, lit, pulse);
    if (L.bars) this.blit(L.bars, 0, lit);

    this.drawSparks(lit);
    this.drawArcs(lit);
    this.drawShocks(rgba(this.hue(), 1), lit);

    // The figure and the control stand in the middle of all this, so the
    // middle is where the light is taken back out.
    x.fillStyle = this.gScrim;
    x.fillRect(0, 0, W, H);

    if (this.burst > 0.01) {
      x.save();
      x.globalAlpha = Math.min(0.55, this.burst * 0.8);
      x.fillStyle = rgba(ACCENT_SOFT, 1);
      x.fillRect(0, 0, W, H);
      x.restore();
    }
  }

  // the well the circle is holding open: dark, turning, with the Hoard at
  // the bottom of it. The arms move, so they stay live, but they carry no
  // shadow: their gradient does the work.
  drawWell(lit, pulse) {
    const { x } = this;
    const R = this.R * pulse;
    x.save();
    x.beginPath();
    x.arc(this.cx, this.cy, R * 0.98, 0, Math.PI * 2);
    x.clip();
    x.fillStyle = this.gDark;
    x.fillRect(this.cx - R, this.cy - R, R * 2, R * 2);
    x.save();
    x.globalAlpha = lit;
    x.fillStyle = this.gCore;
    x.fillRect(this.cx - R, this.cy - R, R * 2, R * 2);
    x.restore();

    x.lineCap = 'round';
    x.strokeStyle = this.gArms;
    x.lineWidth = 1.1;
    x.globalAlpha = lit;
    for (let i = 0; i < VORTEX; i++) {
      const base = (i / VORTEX) * Math.PI * 2 + this.t * 0.42;
      x.beginPath();
      for (let s = 0; s <= 12; s++) {
        const k = s / 12;
        const r = R * (0.96 - k * 0.86);
        const a = base + k * 2.3;
        const px = this.cx + Math.cos(a) * r;
        const py = this.cy + Math.sin(a) * r;
        if (!s) x.moveTo(px, py); else x.lineTo(px, py);
      }
      x.stroke();
    }
    x.restore();
  }

  // the room being drawn in, one streak at a time
  drawSparks(lit) {
    const { x } = this;
    const hue = this.hue();
    x.save();
    x.lineCap = 'round';
    for (const s of this.sparks) {
      const near = clamp(1.3 - s.r, 0, 1);
      const [x0, y0] = this.polar(s.r, s.a);
      const [x1, y1] = this.polar(s.r + s.len, s.a - s.len * 1.6);
      x.globalAlpha = s.al * lit * clamp((s.r - 0.08) * 4, 0, 1) * (0.35 + near * 0.65);
      x.strokeStyle = rgba(s.w > 1.5 ? ACCENT_SOFT : hue, 1);
      x.lineWidth = s.w * (0.5 + near * 0.7);
      x.beginPath();
      x.moveTo(x0, y0);
      x.lineTo(x1, y1);
      x.stroke();
    }
    x.restore();
  }

  // the only shadowed strokes left in a frame, and there are at most a few
  drawArcs(lit) {
    const { x } = this;
    x.save();
    x.lineCap = 'round';
    x.lineJoin = 'round';
    for (const a of this.arcs) {
      const k = 1 - a.t / a.dur;
      const path = (gg) => {
        gg.beginPath();
        a.pts.forEach(([r, ang], i) => {
          const [px, py] = this.polar(r, ang);
          if (!i) gg.moveTo(px, py); else gg.lineTo(px, py);
        });
      };
      glowPath(x, path, rgba(ACCENT_SOFT, 1), a.w * 3, 18, 0.25 * k * lit);
      glowPath(x, path, '#FFFFFF', a.w, 8, 0.9 * k * lit);
    }
    x.restore();
  }

  drawShocks(c, lit) {
    const { x } = this;
    for (const sh of this.shocks) {
      const k = sh.t / sh.dur;
      const r = sh.from + (sh.to - sh.from) * easeOut(k);
      const path = (gg) => { gg.beginPath(); gg.arc(this.cx, this.cy, this.R * r, 0, Math.PI * 2); };
      glowPath(x, path, c, sh.w * 3, 20, 0.12 * (1 - k) * lit);
      glowPath(x, path, c, sh.w, 10, 0.55 * (1 - k) * lit);
    }
  }
}

// opts: { sealed }
// returns a handle the tab uses to react without rebuilding the scene
export function mountGateHall(canvas, opts) {
  const hall = new Hall(canvas, opts);
  return {
    set(next) { Object.assign(hall.o, next); },
    heat(on) {
      hall.heatTarget = on ? 1 : 0;
      if (on && !reduced()) hall.shock(0.45, 1.5, 0.9, 1.1);
    },
    flare() {
      hall.burst = 1;
      hall.heatTarget = 1;
      if (reduced()) return;
      hall.shock(0.2, 1.95, 1.1, 2.4);
      for (let i = 0; i < 6; i++) hall.arcs.push(hall.newArc());
    },
    stop() { hall.stop(); },
  };
}
