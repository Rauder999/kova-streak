// The Gate hall: what a hunter stands in front of before turning a key.
//
// The descent in gate.js is the event. This is the doorway to it, and it has
// a job of its own: the key in your hand cost a whole day of training, so the
// screen that takes it has to look like it knows that.
//
// It is the System's own summoning circle, seen face on, per Rauder's brief
// and the way Solo Leveling draws one: rings inside rings turning against
// each other, a rune band, a hexagram, and a dark well in the middle where
// the Hoard burns. Around it reality is FRACTURED: cracks run out of the rim
// into the dark, bleeding light, because something is holding open a hole
// that should not be there.
//
// What keeps it from reading cheap, which the flat outline it replaced did:
//   value range   every light is three strokes, a wide dim bloom, a body and
//                 a white hot core, never one flat mid violet line
//   density       ticks, glyph blocks, nodes and spokes, so the eye has
//                 something to find at every radius
//   motion        six rotations at six speeds in both directions, a vortex,
//                 sparks spiralling in, arcs jumping the gap, a slow pulse
//   real black    the middle is genuinely dark, which is what makes the glow
//                 read as light rather than as paint
//
// Everything in front of it, the figure and the one control, is flat HTML:
// the art never fights the words. One canvas, and the rest of the tab is
// dead still like every other window on the site.

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
const SPARKS = 110;
const VORTEX = 16;

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
    this.running = true;
    this.last = performance.now();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this.onResize);
      this.ro.observe(canvas);
    }
    this.resize();
    for (let i = 0; i < CRACKS; i++) this.cracks.push(this.newCrack(i));
    for (let i = 0; i < SPARKS; i++) this.sparks.push(this.newSpark(true));
    if (reduced()) { this.t = 3; this.draw(); return; }
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.c.getBoundingClientRect();
    this.W = Math.max(1, Math.round(r.width));
    this.H = Math.max(1, Math.round(r.height));
    this.c.width = Math.round(this.W * dpr);
    this.c.height = Math.round(this.H * dpr);
    this.x.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cx = this.W / 2;
    this.cy = this.H * 0.5;
    // large enough that the figure and the control sit inside the well, small
    // enough that the outermost orbit still lands inside the frame
    this.R = clamp(Math.min(this.W * 0.34, this.H * 0.44), 150, 330);
    if (reduced()) this.draw();
  }

  stop() {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    if (this.ro) this.ro.disconnect();
  }

  get sealed() { return !!this.o.sealed; }

  // One fracture running out of the rim: a jagged polyline in units of R,
  // with a chance of a fork. Reality does not break in straight lines.
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
    return { pts, fork, w: rnd(0.8, 2.6), phase: rnd(0, 6.3), sp: rnd(0.35, 1.1), lag: rnd(0, 1.4) };
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

  frame(t) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    try { this.update(dt); this.draw(); } catch { /* a drawing hiccup never breaks the tab */ }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  update(dt) {
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

  // ---- drawing helpers ----

  polar(r, a) { return [this.cx + Math.cos(a) * this.R * r, this.cy + Math.sin(a) * this.R * r]; }

  glow(path, color, width, blur, alpha) {
    const x = this.x;
    x.save();
    x.strokeStyle = color;
    x.shadowColor = color;
    x.shadowBlur = blur;
    x.lineWidth = width;
    x.globalAlpha = alpha;
    path();
    x.stroke();
    x.restore();
  }

  // the three stroke recipe: a wide dim bloom, a body, a white hot core
  lightRing(r, color, body, alpha, dash) {
    const x = this.x;
    const path = () => {
      x.beginPath();
      if (dash) x.setLineDash(dash);
      x.arc(this.cx, this.cy, this.R * r, 0, Math.PI * 2);
    };
    x.save();
    this.glow(path, color, body * 7, 30, 0.14 * alpha);
    this.glow(path, color, body, 15, 0.95 * alpha);
    this.glow(path, '#FFFFFF', body * 0.42, 7, 0.7 * alpha);
    x.setLineDash([]);
    x.restore();
  }

  hue() { return this.sealed ? mix(ASH, BAD, 0.3) : mix(ACCENT, ACCENT_SOFT, this.heat * 0.45); }

  draw() {
    const { x, W, H } = this;
    const hue = this.hue();
    const c = rgba(hue, 1);
    const live = !this.sealed;
    const lit = (live ? 0.82 + this.heat * 0.3 : 0.4) + this.burst * 0.45;
    const pulse = 1 + Math.sin(this.t * 1.15) * 0.012;
    x.clearRect(0, 0, W, H);

    // what the hole is pouring into the room
    const amb = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, Math.max(W, H) * 0.62);
    amb.addColorStop(0, rgba(live ? GOLD : BAD, 0.055 * lit));
    amb.addColorStop(0.22, rgba(hue, 0.09 * lit));
    amb.addColorStop(0.62, rgba(hue, 0.025 * lit));
    amb.addColorStop(1, rgba(hue, 0));
    x.fillStyle = amb;
    x.fillRect(0, 0, W, H);

    this.drawCracks(c, lit);
    this.drawWell(hue, lit, pulse);
    this.drawRings(c, hue, lit, pulse);
    this.drawSparks(hue, lit);
    this.drawArcs(lit);
    this.drawShocks(c, lit);

    // The figure and the control stand in the middle of all this, so the
    // middle is where the light is taken back out.
    const scrim = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, this.R * 0.95);
    scrim.addColorStop(0, 'rgba(4,4,9,0.9)');
    scrim.addColorStop(0.55, 'rgba(4,4,9,0.6)');
    scrim.addColorStop(1, 'rgba(4,4,9,0)');
    x.fillStyle = scrim;
    x.fillRect(0, 0, W, H);

    if (this.burst > 0.01) {
      x.save();
      x.globalAlpha = Math.min(0.55, this.burst * 0.8);
      x.fillStyle = rgba(ACCENT_SOFT, 1);
      x.fillRect(0, 0, W, H);
      x.restore();
    }
  }

  // reality, fractured around the rim
  drawCracks(c, lit) {
    const { x } = this;
    x.save();
    x.lineCap = 'round';
    x.lineJoin = 'round';
    for (const k of this.cracks) {
      const breathe = 0.45 + 0.55 * Math.max(0, Math.sin(this.t * k.sp + k.phase));
      const grow = clamp((this.t - k.lag) / 1.1, 0, 1);
      if (grow <= 0) continue;
      const n = Math.max(2, Math.ceil(k.pts.length * easeOut(grow)));
      const line = (pts, from) => () => {
        x.beginPath();
        const [sx, sy] = this.polar(from[0], from[1]);
        x.moveTo(sx, sy);
        for (let i = 0; i < pts.length; i++) {
          const [px, py] = this.polar(pts[i][0], pts[i][1]);
          x.lineTo(px, py);
        }
      };
      const seg = k.pts.slice(0, n);
      const start = [1.0, k.pts[0][1]];
      const a = breathe * lit * 0.85;
      this.glow(line(seg, start), c, k.w * 3.2, 18, 0.1 * a);
      this.glow(line(seg, start), c, k.w, 9, 0.5 * a);
      this.glow(line(seg.slice(0, Math.ceil(n * 0.55)), start), '#FFFFFF', k.w * 0.4, 5, 0.42 * a);
      if (k.fork && n > k.fork.at + 1) {
        this.glow(line(k.fork.pts, k.pts[k.fork.at]), c, k.w * 0.7, 8, 0.35 * a);
      }
    }
    x.restore();
  }

  // the well the circle is holding open: dark, turning, with the Hoard at
  // the bottom of it
  drawWell(hue, lit, pulse) {
    const { x } = this;
    const R = this.R * pulse;
    x.save();
    x.beginPath();
    x.arc(this.cx, this.cy, R * 0.98, 0, Math.PI * 2);
    x.clip();

    const dark = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, R);
    dark.addColorStop(0, 'rgba(2,2,5,0.98)');
    dark.addColorStop(0.6, 'rgba(4,4,10,0.92)');
    dark.addColorStop(1, 'rgba(6,5,14,0.4)');
    x.fillStyle = dark;
    x.fillRect(this.cx - R, this.cy - R, R * 2, R * 2);

    // the Hoard, burning at the bottom of the well
    const pc = this.sealed ? BAD : GOLD;
    const core = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, R * 0.62);
    core.addColorStop(0, rgba(this.sealed ? BAD : GOLD_SOFT, (this.sealed ? 0.12 : 0.3) * lit));
    core.addColorStop(0.45, rgba(pc, (this.sealed ? 0.05 : 0.1) * lit));
    core.addColorStop(1, rgba(pc, 0));
    x.fillStyle = core;
    x.fillRect(this.cx - R, this.cy - R, R * 2, R * 2);

    // the swirl: arms winding down into it
    x.lineCap = 'round';
    for (let i = 0; i < VORTEX; i++) {
      const base = (i / VORTEX) * Math.PI * 2 + this.t * 0.42;
      x.beginPath();
      for (let s = 0; s <= 14; s++) {
        const k = s / 14;
        const r = R * (0.96 - k * 0.86);
        const a = base + k * 2.3;
        const px = this.cx + Math.cos(a) * r;
        const py = this.cy + Math.sin(a) * r;
        if (!s) x.moveTo(px, py); else x.lineTo(px, py);
      }
      const g = x.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, R);
      g.addColorStop(0, rgba(this.sealed ? BAD : GOLD_SOFT, 0.5 * lit));
      g.addColorStop(0.55, rgba(hue, 0.22 * lit));
      g.addColorStop(1, rgba(hue, 0));
      x.strokeStyle = g;
      x.lineWidth = 1.1;
      x.stroke();
    }
    x.restore();
  }

  // Six rotations at six speeds in both directions. This is the machine.
  drawRings(c, hue, lit, pulse) {
    const { x } = this;
    const R = this.R;
    const hot = this.sealed ? rgba(mix(ASH, BAD, 0.6), 1) : rgba(ACCENT_SOFT, 1);
    const t = this.t;

    // outer orbit: dashed, with diamond nodes riding it
    x.save();
    x.translate(this.cx, this.cy);
    x.rotate(t * 0.085);
    x.translate(-this.cx, -this.cy);
    this.lightRing(1.12 * pulse, c, 1, 0.4 * lit, [R * 0.055, R * 0.05]);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const [px, py] = this.polar(1.12 * pulse, a);
      x.save();
      x.translate(px, py);
      x.rotate(a);
      const d = i % 3 === 0 ? 6 : 3.4;
      x.beginPath();
      x.moveTo(0, -d); x.lineTo(d * 0.8, 0); x.lineTo(0, d); x.lineTo(-d * 0.8, 0); x.closePath();
      x.fillStyle = hot;
      x.shadowColor = c;
      x.shadowBlur = 12;
      x.globalAlpha = 0.75 * lit;
      x.fill();
      x.restore();
    }
    x.restore();

    // a fine tick collar, turning the other way
    x.save();
    x.translate(this.cx, this.cy);
    x.rotate(-t * 0.15);
    x.strokeStyle = c;
    x.shadowColor = c;
    x.shadowBlur = 6;
    x.globalAlpha = 0.35 * lit;
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const long = i % 10 === 0;
      const r0 = R * (long ? 1.015 : 1.045);
      const r1 = R * 1.07;
      x.lineWidth = long ? 1.4 : 0.7;
      x.beginPath();
      x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      x.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      x.stroke();
    }
    x.restore();

    // THE RIM, and the rune band inside it
    this.lightRing(1.0 * pulse, c, 2.2, 1 * lit);
    this.lightRing(0.9 * pulse, c, 1, 0.5 * lit);
    x.save();
    x.translate(this.cx, this.cy);
    x.rotate(t * 0.21);
    x.strokeStyle = c;
    x.shadowColor = c;
    x.shadowBlur = 9;
    x.globalAlpha = 0.55 * lit;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const long = i % 4 === 0;
      const r0 = R * (long ? 0.905 : 0.945);
      x.lineWidth = long ? 1.6 : 0.8;
      x.beginPath();
      x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      x.lineTo(Math.cos(a) * R * 0.995, Math.sin(a) * R * 0.995);
      x.stroke();
    }
    // glyph blocks: the band is written on, not just notched
    x.globalAlpha = 0.8 * lit;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      x.save();
      x.rotate(a);
      x.translate(R * 0.945, 0);
      x.rotate(Math.PI / 2);
      x.lineWidth = 1.2;
      x.beginPath();
      x.rect(-7, -R * 0.045, 14, R * 0.045);
      x.moveTo(-7, -R * 0.02); x.lineTo(7, -R * 0.02);
      x.moveTo(0, -R * 0.045); x.lineTo(0, 0);
      x.stroke();
      x.restore();
    }
    x.restore();

    // a head of light running the rim, dragging a tail: the one thing on the
    // circle that is unmistakably moving at a glance
    this.drawSweep(c, lit);

    // four arc segments, faster and against the band
    x.save();
    x.translate(this.cx, this.cy);
    x.rotate(-t * 0.36);
    for (let i = 0; i < 4; i++) {
      const a0 = (i / 4) * Math.PI * 2;
      const path = () => { x.beginPath(); x.arc(0, 0, R * 0.78, a0, a0 + 1.15); };
      this.glow(path, c, 9, 22, 0.1 * lit);
      this.glow(path, c, 2.4, 12, 0.7 * lit);
      this.glow(path, '#FFFFFF', 0.9, 5, 0.45 * lit);
      // a spoke out of each segment's head
      x.save();
      x.rotate(a0);
      x.strokeStyle = c;
      x.shadowColor = c;
      x.shadowBlur = 10;
      x.globalAlpha = 0.5 * lit;
      x.lineWidth = 1.2;
      x.beginPath();
      x.moveTo(R * 0.78, 0);
      x.lineTo(R * 0.99, 0);
      x.stroke();
      x.restore();
    }
    x.restore();

    // the hexagram: two triangles turning against each other
    for (const [dir, r, w] of [[1, 0.64, 1.7], [-1, 0.64, 1.7]]) {
      x.save();
      x.translate(this.cx, this.cy);
      x.rotate(dir * t * 0.16 + (dir < 0 ? Math.PI / 3 : 0));
      const tri = () => {
        x.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
          const px = Math.cos(a) * R * r;
          const py = Math.sin(a) * R * r;
          if (!i) x.moveTo(px, py); else x.lineTo(px, py);
        }
        x.closePath();
      };
      this.glow(tri, c, w * 5, 20, 0.08 * lit);
      this.glow(tri, c, w, 10, 0.5 * lit);
      x.restore();
    }

    // the inner collar
    x.save();
    x.translate(this.cx, this.cy);
    x.rotate(t * 0.44);
    this.lightRing(0.52 * pulse, c, 1.2, 0.6 * lit);
    x.strokeStyle = c;
    x.shadowColor = c;
    x.shadowBlur = 7;
    x.globalAlpha = 0.45 * lit;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      x.lineWidth = i % 3 === 0 ? 1.3 : 0.7;
      x.beginPath();
      x.moveTo(Math.cos(a) * R * 0.47, Math.sin(a) * R * 0.47);
      x.lineTo(Math.cos(a) * R * 0.515, Math.sin(a) * R * 0.515);
      x.stroke();
    }
    x.restore();

    // what is barred is shown barred
    if (this.sealed) {
      x.save();
      x.strokeStyle = rgba(BAD, 0.55);
      x.shadowColor = rgba(BAD, 1);
      x.shadowBlur = 20;
      x.lineWidth = 8;
      x.lineCap = 'round';
      for (const a of [-0.34, 0.34]) {
        x.beginPath();
        x.moveTo(this.cx - Math.cos(a) * R * 1.1, this.cy - Math.sin(a) * R * 1.1);
        x.lineTo(this.cx + Math.cos(a) * R * 1.1, this.cy + Math.sin(a) * R * 1.1);
        x.stroke();
      }
      x.restore();
    }
  }

  drawSweep(c, lit) {
    const { x } = this;
    const head = this.t * 0.95;
    const tail = 1.35;
    const steps = 12;
    x.save();
    x.lineCap = 'round';
    for (let i = 0; i < steps; i++) {
      const k = i / steps;
      const a0 = head - tail * k;
      const a1 = head - tail * ((i + 1) / steps);
      const path = () => { x.beginPath(); x.arc(this.cx, this.cy, this.R, a1, a0); };
      const f = (1 - k) ** 2;
      this.glow(path, c, 5 * f + 1, 20, 0.34 * f * lit);
      if (i < 3) this.glow(path, '#FFFFFF', 2.4 - i * 0.7, 11, 0.85 * lit);
    }
    x.restore();
  }

  // the room being drawn in, one streak at a time
  drawSparks(hue, lit) {
    const { x } = this;
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
    x.globalAlpha = 1;
  }

  drawArcs(lit) {
    const { x } = this;
    x.save();
    x.lineCap = 'round';
    x.lineJoin = 'round';
    for (const a of this.arcs) {
      const k = 1 - a.t / a.dur;
      const path = () => {
        x.beginPath();
        a.pts.forEach(([r, ang], i) => {
          const [px, py] = this.polar(r, ang);
          if (!i) x.moveTo(px, py); else x.lineTo(px, py);
        });
      };
      this.glow(path, rgba(ACCENT_SOFT, 1), a.w * 3, 18, 0.25 * k * lit);
      this.glow(path, '#FFFFFF', a.w, 8, 0.9 * k * lit);
    }
    x.restore();
  }

  drawShocks(c, lit) {
    const { x } = this;
    for (const sh of this.shocks) {
      const k = sh.t / sh.dur;
      const r = sh.from + (sh.to - sh.from) * easeOut(k);
      const path = () => { x.beginPath(); x.arc(this.cx, this.cy, this.R * r, 0, Math.PI * 2); };
      this.glow(path, c, sh.w * 3, 20, 0.12 * (1 - k) * lit);
      this.glow(path, c, sh.w, 10, 0.55 * (1 - k) * lit);
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
