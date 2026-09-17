// The Gate hall: what a hunter stands in front of before turning a key.
//
// The descent in gate.js is the event. This is the doorway to it, and it has
// a job of its own: the key in your hand cost a whole day of training, so the
// screen that takes it has to look like it knows that.
//
// A flat outline on a dark rectangle reads as a wireframe, which is what the
// first pass of this screen looked like. What makes it read as built instead:
//
//   depth      the mouth is not a gradient, it is a corridor of nested arches
//              receding to a vanishing point with the Hoard's light at the end
//   structure  an outer frame, an inner reveal, a rune frieze in the band
//              between them, plinths the legs stand on, brackets at the
//              springline, a keystone on the apex
//   ground     a floor the arch actually stands on, with its own reflection,
//              converging lines and the light the mouth spills across it
//   air        god rays out of the mouth, dust drawn into it, side pylons
//              holding the edges of the frame so the composition is not two
//              dark margins around a shape
//
// Everything in front of it, the figure and the one control, is flat HTML:
// the art never fights the words. One canvas, one composite motion; the rest
// of the tab is dead still like every other window on the site.

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
const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const RINGS = 9; // how many arches deep the corridor goes

class Hall {
  constructor(canvas, opts) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.o = opts || {};
    this.spin = 0;
    this.heat = 0;         // 0 at rest, 1 with a hand on the key
    this.heatTarget = 0;
    this.burst = 0;        // the flare when the key turns
    this.motes = [];
    this.embers = [];
    this.running = true;
    this.born = performance.now();
    this.last = this.born;
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this.onResize);
      this.ro.observe(canvas);
    }
    this.resize();
    for (let i = 0; i < 90; i++) this.motes.push(this.newMote(true));
    for (let i = 0; i < 30; i++) this.embers.push(this.newEmber(true));
    if (reduced()) { this.spin = 0.6; this.draw(this.born); return; }
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
    this.floorY = this.H * 0.90;
    this.AW = clamp(this.W * 0.40, 260, 420);
    this.AH = clamp(this.H * 0.70, 240, 430);
    this.band = clamp(this.AW * 0.055, 12, 24);     // the stone between the frames
    this.vpY = this.floorY - this.AH * 0.42;        // where the corridor goes to
    this.mouthY = this.floorY - this.AH * 0.52;
    if (reduced()) this.draw(performance.now());
  }

  stop() {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    if (this.ro) this.ro.disconnect();
  }

  get sealed() { return !!this.o.sealed; }

  newMote(spread) {
    return {
      a: rnd(0, Math.PI * 2),
      r: spread ? rnd(0.12, 1.15) : rnd(0.95, 1.3),
      s: rnd(0.6, 2.3), v: rnd(0.05, 0.19), w: rnd(-0.6, 0.6), al: rnd(0.14, 0.7),
    };
  }

  // what the Hoard throws up out of the corridor: only when the Gate will open
  newEmber(spread) {
    return { x: rnd(-0.4, 0.4), y: spread ? rnd(0, 1) : rnd(-0.06, 0), v: rnd(0.10, 0.34), s: rnd(0.8, 2.4), w: rnd(0, 6.3), ws: rnd(0.5, 1.6) };
  }

  frame(t) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    try { this.update(dt); this.draw(t); } catch { /* a drawing hiccup never breaks the tab */ }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  update(dt) {
    this.spin += dt * (0.05 + this.heat * 0.09);
    this.heat += (this.heatTarget - this.heat) * Math.min(1, dt * 3.2);
    this.burst *= Math.exp(-dt * 2.1);
    const pull = this.sealed ? -0.5 : 0.6 + this.heat * 1.1 + this.burst * 2.2;
    for (const m of this.motes) {
      m.r -= m.v * dt * pull;
      m.a += m.w * dt * (0.16 + this.heat * 0.2);
      if (m.r < 0.05 || m.r > 1.45) Object.assign(m, this.newMote(false));
    }
    if (!this.sealed) {
      for (const e of this.embers) {
        e.y += e.v * dt * (0.5 + this.heat * 0.8 + this.burst);
        e.w += e.ws * dt;
        if (e.y > 1) Object.assign(e, this.newEmber(false));
      }
    }
  }

  glowStroke(path, color, width, blur, alpha) {
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

  // A round-headed arch: straight legs up to the springline, a half circle on
  // top. Simple enough that the frieze, the frame and the whole receding
  // corridor can all be built off the same three numbers.
  arch(scale = 1, grow = 0, close = false) {
    const x = this.x;
    const cx = this.W / 2;
    const base = this.floorY;
    const r = (this.AW * scale) / 2 + grow;
    const h = this.AH * scale + grow;
    const spring = base - (h - r);
    x.beginPath();
    x.moveTo(cx - r, base);
    x.lineTo(cx - r, spring);
    // PI to 0 with the angle increasing sweeps over the TOP: the head of the
    // arch. Anticlockwise here draws the bottom half and buries the gate.
    x.arc(cx, spring, r, Math.PI, 0);
    x.lineTo(cx + r, base);
    if (close) x.closePath();
    return { r, spring, apex: spring - r };
  }

  // the corridor: the same arch scaled about the vanishing point
  ringPath(t, grow = 0) {
    const x = this.x;
    const cx = this.W / 2;
    const s = 1 - t * 0.88;
    return () => {
      x.save();
      x.translate(cx, this.vpY);
      x.scale(s, s);
      x.translate(-cx, -this.vpY);
      this.arch(1, grow / (s || 1));
      x.restore();
    };
  }

  // violet while it will open for you, ash and rust while it will not
  hue() { return this.sealed ? mix(ASH, BAD, 0.25) : mix(ACCENT, ACCENT_SOFT, this.heat * 0.5); }

  draw(now) {
    const { x, W, H } = this;
    const cx = W / 2;
    const hue = this.hue();
    const live = !this.sealed;
    const lit = (live ? 0.55 + this.heat * 0.45 : 0.34) + this.burst * 0.5;
    x.clearRect(0, 0, W, H);

    // the room behind the arch: what is coming up the corridor, seen as light
    const back = x.createRadialGradient(cx, this.vpY, 0, cx, this.vpY, Math.max(W, H) * 0.62);
    back.addColorStop(0, rgba(live ? GOLD : BAD, (live ? 0.08 : 0.04) * lit));
    back.addColorStop(0.28, rgba(hue, 0.07 * lit));
    back.addColorStop(0.68, rgba(hue, 0.024 * lit));
    back.addColorStop(1, rgba(hue, 0));
    x.fillStyle = back;
    x.fillRect(0, 0, W, H);

    this.drawPylons(hue, lit);
    this.drawSeal(now, hue, lit);
    this.drawCorridor(now, hue, lit);
    this.drawRays(now, hue, lit);
    this.drawFrame(now, hue, lit);
    this.drawFloor(hue, lit);
    this.drawMotes(hue, lit);

    // The figure and the control stand in the middle of all this, so the
    // middle is where the light is taken back out: everything glows from the
    // rim and the floor, and the words keep a dark ground to sit on.
    const scrim = x.createRadialGradient(cx, H * 0.44, 0, cx, H * 0.44, Math.max(W, H) * 0.34);
    scrim.addColorStop(0, 'rgba(5,5,10,0.66)');
    scrim.addColorStop(0.5, 'rgba(5,5,10,0.36)');
    scrim.addColorStop(1, 'rgba(5,5,10,0)');
    x.fillStyle = scrim;
    x.fillRect(0, 0, W, H);

    if (this.burst > 0.01) {
      x.save();
      x.globalAlpha = Math.min(0.7, this.burst);
      x.fillStyle = rgba(ACCENT_SOFT, 1);
      x.fillRect(0, 0, W, H);
      x.restore();
    }
  }

  // Two light pylons holding the edges of the frame, so the composition is a
  // hall and not a shape floating in two dark margins.
  drawPylons(hue, lit) {
    const { x, W } = this;
    const cx = W / 2;
    const top = this.floorY - this.AH * 1.06;
    for (const side of [-1, 1]) {
      const px = cx + side * Math.min(W * 0.36, this.AW * 1.55);
      if (px < 30 || px > W - 30) continue;
      const g = x.createLinearGradient(0, top, 0, this.floorY);
      g.addColorStop(0, rgba(hue, 0));
      g.addColorStop(0.4, rgba(hue, 0.5 * lit));
      g.addColorStop(1, rgba(hue, 0.8 * lit));
      x.save();
      x.strokeStyle = g;
      x.shadowColor = rgba(hue, 1);
      x.shadowBlur = 10;
      x.lineWidth = 1.2;
      for (const d of [-9, 9]) {
        x.beginPath();
        x.moveTo(px + d, top);
        x.lineTo(px + d, this.floorY);
        x.stroke();
      }
      // rungs, tighter toward the floor so the thing has a direction
      x.globalAlpha = 0.7;
      x.shadowBlur = 0;
      for (let i = 0; i < 18; i++) {
        const k = i / 17;
        const y = top + (this.floorY - top) * (k * k);
        x.beginPath();
        x.moveTo(px - 9, y);
        x.lineTo(px + 9, y);
        x.stroke();
      }
      // a cap, so it reads as a thing and not a stray line
      x.globalAlpha = 0.85;
      x.beginPath();
      x.moveTo(px - 15, top + (this.floorY - top) * 0.04);
      x.lineTo(px, top);
      x.lineTo(px + 15, top + (this.floorY - top) * 0.04);
      x.stroke();
      x.restore();
    }
  }

  // the standing seal behind the arch: a rune band that never stops turning
  drawSeal(now, hue, lit) {
    const { x } = this;
    const cx = this.W / 2;
    const cy = this.floorY - this.AH * 0.60;
    const R = this.AH * 0.62;
    const ring = (r) => () => { x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); };
    const c = rgba(hue, 1);
    x.save();
    x.translate(cx, cy);
    x.rotate(this.spin);
    this.glowStroke(ring(R), c, 7, 26, 0.06 * lit);
    this.glowStroke(ring(R), c, 1.4, 12, 0.3 * lit);

    x.save();
    x.strokeStyle = c;
    x.shadowColor = c;
    x.shadowBlur = 8;
    x.globalAlpha = 0.26 * lit;
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      const long = k % 6 === 0;
      const len = long ? 22 : 9;
      x.lineWidth = long ? 1.6 : 0.8;
      x.beginPath();
      x.moveTo(Math.cos(a) * (R - len), Math.sin(a) * (R - len));
      x.lineTo(Math.cos(a) * R, Math.sin(a) * R);
      x.stroke();
    }
    x.restore();

    x.rotate(-this.spin * 3.1);
    x.setLineDash([R * 0.13, R * 0.09]);
    this.glowStroke(ring(R * 1.15), c, 1.1, 10, 0.2 * lit);
    x.setLineDash([R * 0.04, R * 0.16]);
    this.glowStroke(ring(R * 0.88), c, 1, 8, 0.16 * lit);
    x.setLineDash([]);
    x.restore();
  }

  // Inside the mouth: nested arches receding to a vanishing point, each one
  // smaller, dimmer and warmer than the last, with the Hoard burning at the
  // far end. This is the whole difference between a doorway and a hole.
  drawCorridor(now, hue, lit) {
    const { x } = this;
    const cx = this.W / 2;
    x.save();
    this.arch(1, 0, true);
    x.clip();

    // the dark the corridor is cut out of
    const inner = x.createLinearGradient(0, this.floorY - this.AH, 0, this.floorY);
    inner.addColorStop(0, 'rgba(3,3,7,0.99)');
    inner.addColorStop(0.6, 'rgba(5,4,10,0.97)');
    inner.addColorStop(1, this.sealed ? 'rgba(14,6,9,0.96)' : 'rgba(20,13,9,0.96)');
    x.fillStyle = inner;
    this.arch(1, 0, true);
    x.fill();

    // the far end, burning
    const pc = this.sealed ? BAD : GOLD;
    const far = x.createRadialGradient(cx, this.vpY, 0, cx, this.vpY, this.AW * 0.5);
    far.addColorStop(0, rgba(this.sealed ? BAD : GOLD_SOFT, (this.sealed ? 0.16 : 0.52) * lit));
    far.addColorStop(0.35, rgba(pc, (this.sealed ? 0.07 : 0.2) * lit));
    far.addColorStop(1, rgba(pc, 0));
    x.fillStyle = far;
    x.fillRect(cx - this.AW, this.vpY - this.AH, this.AW * 2, this.AH * 2);

    // the rings themselves, and a crawl down them so the corridor breathes
    const crawl = (now / 9000) % (1 / RINGS);
    for (let i = RINGS - 1; i >= 0; i--) {
      const t = i / RINGS + crawl;
      if (t >= 0.985) continue;
      const fade = 1 - t;
      const warm = mix(hue, pc, clamp(t * 1.25, 0, 1));
      x.save();
      x.globalAlpha = (0.10 + fade * 0.34) * lit;
      x.strokeStyle = rgba(warm, 1);
      x.lineWidth = 1 + fade * 1.6;
      this.ringPath(t)();
      x.stroke();
      x.restore();
    }

    if (!this.sealed) this.drawEmbers(lit);
    x.restore();

    // what is barred is shown barred: two struck bands across the mouth
    if (this.sealed) {
      x.save();
      this.arch(1, 0, true);
      x.clip();
      x.strokeStyle = rgba(BAD, 0.5);
      x.shadowColor = rgba(BAD, 1);
      x.shadowBlur = 18;
      x.lineWidth = 7;
      for (const f of [0.42, 0.62]) {
        const y = this.floorY - this.AH * f;
        x.beginPath();
        x.moveTo(cx - this.AW * 0.62, y + 16);
        x.lineTo(cx + this.AW * 0.62, y - 16);
        x.stroke();
      }
      x.restore();
    }
  }

  drawEmbers(lit) {
    const { x } = this;
    const cx = this.W / 2;
    for (const e of this.embers) {
      // they rise out of the far end, so they start small and near the middle
      const py = this.floorY - (this.floorY - this.vpY + this.AH * 0.3) * e.y;
      const spread = 0.25 + e.y * 0.55;
      const px = cx + e.x * this.AW * spread + Math.sin(e.w) * 8;
      x.globalAlpha = clamp((1 - e.y) * 0.85, 0, 1) * lit;
      x.fillStyle = rgba(e.s > 1.7 ? GOLD_SOFT : GOLD, 1);
      x.beginPath();
      x.arc(px, py, e.s * (0.4 + e.y * 0.5), 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = 1;
  }

  // light spilling out of the mouth and lying across the floor
  drawRays(now, hue, lit) {
    if (this.sealed) return;
    const { x } = this;
    const cx = this.W / 2;
    const src = this.vpY;
    x.save();
    x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const sway = Math.sin(now / 2600 + i * 1.7) * 0.06;
      const a = (i / 4 - 0.5) * 1.5 + sway;
      const spread = 0.085;
      const len = this.AH * 1.5;
      const g = x.createLinearGradient(cx, src, cx + Math.sin(a) * len, src + Math.cos(a) * len);
      g.addColorStop(0, rgba(GOLD_SOFT, 0.1 * lit));
      g.addColorStop(1, rgba(GOLD, 0));
      x.fillStyle = g;
      x.beginPath();
      x.moveTo(cx, src);
      x.lineTo(cx + Math.sin(a - spread) * len, src + Math.cos(a - spread) * len);
      x.lineTo(cx + Math.sin(a + spread) * len, src + Math.cos(a + spread) * len);
      x.closePath();
      x.fill();
    }
    x.restore();
  }

  // The stone itself: an outer frame, an inner reveal, a rune frieze in the
  // band between them, plinths the legs stand on and a keystone on the apex.
  drawFrame(now, hue, lit) {
    const { x } = this;
    const cx = this.W / 2;
    const c = rgba(hue, 1);
    const hot = rgba(this.sealed ? mix(ASH, BAD, 0.5) : ACCENT_SOFT, 1);
    const b = this.band;
    const pulse = 1 + Math.sin(now / 1400) * 0.03;

    // the band between the two frames, faintly filled so it reads as stone
    x.save();
    x.beginPath();
    this.arch(1, b, true);
    this.arch(1, 0, true);
    x.fillStyle = rgba(hue, 0.07 * lit);
    x.fill('evenodd');
    x.restore();

    const outer = () => this.arch(1, b);
    const inner = () => this.arch(1, 0);
    this.glowStroke(outer, c, 20, 44, 0.07 * lit);
    this.glowStroke(outer, c, 4, 20, 0.22 * lit);
    this.glowStroke(outer, c, 1.2, 9, 0.55 * lit);
    this.glowStroke(inner, c, 6, 26, 0.2 * lit);
    this.glowStroke(inner, c, 2, 13, 0.85 * lit);
    this.glowStroke(inner, hot, 0.9, 7, (0.5 + this.heat * 0.5) * lit);

    // the frieze: ticks across the band, radial around the head, level on the legs
    const r = this.AW / 2;
    const spring = this.floorY - (this.AH - r);
    x.save();
    x.strokeStyle = c;
    x.shadowColor = c;
    x.shadowBlur = 7;
    x.globalAlpha = 0.4 * lit;
    for (let k = 0; k <= 26; k++) {
      const a = Math.PI + (k / 26) * Math.PI;
      const long = k % 4 === 0;
      x.lineWidth = long ? 1.5 : 0.8;
      const i0 = long ? r + b * 0.15 : r + b * 0.35;
      x.beginPath();
      x.moveTo(cx + Math.cos(a) * i0, spring - Math.sin(a) * i0);
      x.lineTo(cx + Math.cos(a) * (r + b * 0.85), spring - Math.sin(a) * (r + b * 0.85));
      x.stroke();
    }
    const legTop = spring;
    const legs = Math.max(2, Math.round((this.floorY - legTop) / 26));
    for (let k = 0; k <= legs; k++) {
      const y = legTop + ((this.floorY - legTop) * k) / legs;
      const long = k % 4 === 0;
      x.lineWidth = long ? 1.5 : 0.8;
      for (const side of [-1, 1]) {
        x.beginPath();
        x.moveTo(cx + side * (r + (long ? b * 0.15 : b * 0.35)), y);
        x.lineTo(cx + side * (r + b * 0.85), y);
        x.stroke();
      }
    }
    x.restore();

    // brackets where the curve takes off from the legs
    x.save();
    x.strokeStyle = hot;
    x.shadowColor = c;
    x.shadowBlur = 12;
    x.lineWidth = 1.6;
    x.globalAlpha = 0.6 * lit;
    for (const side of [-1, 1]) {
      const px = cx + side * (r + b);
      x.beginPath();
      x.moveTo(px - side * b * 1.6, spring);
      x.lineTo(px + side * b * 0.9, spring);
      x.moveTo(px + side * b * 0.9, spring);
      x.lineTo(px, spring + b * 1.5);
      x.stroke();
    }
    x.restore();

    // plinths: the legs land on something
    x.save();
    x.globalAlpha = 0.75 * lit;
    x.strokeStyle = c;
    x.shadowColor = c;
    x.shadowBlur = 14;
    x.lineWidth = 1.4;
    for (const side of [-1, 1]) {
      const px = cx + side * (r + b / 2);
      const w = b * 2.1;
      const h = b * 1.25;
      x.beginPath();
      x.rect(px - w / 2, this.floorY - h, w, h);
      x.stroke();
      x.beginPath();
      x.moveTo(px - w * 0.72, this.floorY);
      x.lineTo(px + w * 0.72, this.floorY);
      x.stroke();
    }
    x.restore();

    // the keystone on the apex
    const ky = spring - r - b / 2;
    const d = b * 0.85 * pulse;
    x.save();
    x.translate(cx, ky);
    const dia = () => { x.beginPath(); x.moveTo(0, -d); x.lineTo(d * 0.72, 0); x.lineTo(0, d); x.lineTo(-d * 0.72, 0); x.closePath(); };
    this.glowStroke(dia, c, 6, 22, 0.22 * lit);
    x.fillStyle = hot;
    x.shadowColor = hot;
    x.shadowBlur = 18;
    x.globalAlpha = (0.55 + this.heat * 0.45) * lit;
    dia();
    x.fill();
    x.restore();
  }

  // The ground the arch stands on: its reflection, the light it throws, and
  // lines running back to the same vanishing point the corridor uses.
  drawFloor(hue, lit) {
    const { x, W } = this;
    const cx = W / 2;
    const base = this.floorY;
    const deep = this.H - base;

    // the reflection, cut off below the floor and fading as it goes
    if (deep > 8) {
      x.save();
      x.beginPath();
      x.rect(0, base, W, deep);
      x.clip();
      x.translate(0, base * 2);
      x.scale(1, -1);
      x.globalAlpha = 0.16 * lit;
      x.strokeStyle = rgba(hue, 1);
      x.lineWidth = 1.6;
      this.arch(1, this.band);
      x.stroke();
      this.arch(1, 0);
      x.stroke();
      x.restore();
      // and a wash over it so it dies out instead of stopping
      const fade = x.createLinearGradient(0, base, 0, this.H);
      fade.addColorStop(0, 'rgba(5,5,10,0)');
      fade.addColorStop(1, 'rgba(5,5,10,0.95)');
      x.fillStyle = fade;
      x.fillRect(0, base, W, deep);
    }

    // lines running back into the hall
    x.save();
    x.globalAlpha = 0.22 * lit;
    x.strokeStyle = rgba(hue, 1);
    x.lineWidth = 1;
    for (let i = -4; i <= 4; i++) {
      if (!i) continue;
      x.beginPath();
      x.moveTo(cx + i * W * 0.14, this.H);
      x.lineTo(cx + i * this.AW * 0.06, base);
      x.stroke();
    }
    x.restore();

    // the pool the mouth throws in front of itself
    const pc = this.sealed ? BAD : GOLD;
    const spill = x.createRadialGradient(cx, base, 0, cx, base, this.AW * 1.3);
    spill.addColorStop(0, rgba(pc, 0.22 * lit));
    spill.addColorStop(0.4, rgba(hue, 0.08 * lit));
    spill.addColorStop(1, rgba(hue, 0));
    x.save();
    x.translate(cx, base);
    x.scale(1, 0.26);
    x.fillStyle = spill;
    x.beginPath();
    x.arc(0, 0, this.AW * 1.3, 0, Math.PI * 2);
    x.fill();
    x.restore();

    // the floor line itself
    const line = x.createLinearGradient(cx - W * 0.48, 0, cx + W * 0.48, 0);
    line.addColorStop(0, rgba(hue, 0));
    line.addColorStop(0.5, rgba(hue, 0.5 * lit));
    line.addColorStop(1, rgba(hue, 0));
    x.save();
    x.strokeStyle = line;
    x.lineWidth = 1.2;
    x.beginPath();
    x.moveTo(cx - W * 0.48, base);
    x.lineTo(cx + W * 0.48, base);
    x.stroke();
    x.restore();
  }

  // the room's dust, drawn into the mouth. Sealed, it drifts away instead.
  drawMotes(hue, lit) {
    const { x, W, H } = this;
    const cx = W / 2;
    for (const m of this.motes) {
      const px = cx + Math.cos(m.a) * m.r * W * 0.56;
      const py = this.mouthY + Math.sin(m.a) * m.r * H * 0.52;
      const near = clamp(1 - m.r, 0, 1);
      x.globalAlpha = m.al * lit * clamp(m.r * 3.2, 0, 1) * (0.45 + near * 0.55);
      x.fillStyle = rgba(m.s > 1.7 ? (this.sealed ? ASH : ACCENT_SOFT) : hue, 1);
      x.beginPath();
      x.arc(px, py, m.s * (0.55 + near * 0.5), 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = 1;
  }
}

// opts: { sealed }
// returns a handle the tab uses to react without rebuilding the scene
export function mountGateHall(canvas, opts) {
  const hall = new Hall(canvas, opts);
  return {
    set(next) { Object.assign(hall.o, next); },
    heat(on) { hall.heatTarget = on ? 1 : 0; },
    flare() { hall.burst = 1; hall.heatTarget = 1; },
    stop() { hall.stop(); },
  };
}
