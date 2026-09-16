// The Gate hall: what a hunter stands in front of before turning a key.
//
// The descent in gate.js is the event. This is the doorway to it, and it has
// a job of its own: the key in your hand cost a whole day of training, so the
// screen that takes it has to look like it knows that. It is a standing arch
// with the Hoard's light pooling in its mouth, a seal turning behind it and
// the room's own dust being drawn in. Everything in front of it, the figure
// and the one control, is flat HTML: the art never fights the words.
//
// One canvas, one composite motion. The rest of the tab is dead still, the
// way every other window on the site is.

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
    for (let i = 0; i < 80; i++) this.motes.push(this.newMote(true));
    for (let i = 0; i < 26; i++) this.embers.push(this.newEmber(true));
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
    this.floorY = this.H * 0.88;
    this.AW = clamp(this.W * 0.42, 250, 430);
    this.AH = clamp(this.H * 0.74, 230, 430);
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

  // what the Hoard throws up out of the mouth: only when the Gate will open
  newEmber(spread) {
    return { x: rnd(-0.42, 0.42), y: spread ? rnd(0, 1) : rnd(-0.06, 0), v: rnd(0.10, 0.34), s: rnd(0.8, 2.4), w: rnd(0, 6.3), ws: rnd(0.5, 1.6) };
  }

  frame(t) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    try { this.update(dt); this.draw(t); } catch { /* a drawing hiccup never breaks the tab */ }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  update(dt) {
    this.spin += dt * (0.055 + this.heat * 0.10);
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
        e.y += e.v * dt * (0.55 + this.heat * 0.8 + this.burst);
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

  // the arch, from its footing up to the point, open at the bottom
  arch(k = 1, close = false) {
    const x = this.x;
    const cx = this.W / 2;
    const base = this.floorY;
    const w = this.AW * k;
    const h = this.AH * k;
    x.beginPath();
    x.moveTo(cx - w / 2, base);
    x.lineTo(cx - w / 2, base - h * 0.44);
    x.bezierCurveTo(cx - w / 2, base - h * 0.86, cx - w * 0.17, base - h, cx, base - h);
    x.bezierCurveTo(cx + w * 0.17, base - h, cx + w / 2, base - h * 0.86, cx + w / 2, base - h * 0.44);
    x.lineTo(cx + w / 2, base);
    if (close) x.closePath();
  }

  // violet while it will open for you, ash and rust while it will not
  hue() { return this.sealed ? mix(ASH, BAD, 0.25) : mix(ACCENT, ACCENT_SOFT, this.heat * 0.5); }

  draw(now) {
    const { x, W, H } = this;
    const cx = W / 2;
    const hue = this.hue();
    const live = !this.sealed;
    const pulse = 1 + Math.sin(now / 1400) * 0.035;
    const lit = (live ? 0.55 + this.heat * 0.45 : 0.34) + this.burst * 0.5;
    x.clearRect(0, 0, W, H);

    // the room behind the arch: what is coming up the shaft, seen as light
    const back = x.createRadialGradient(cx, this.mouthY, 0, cx, this.mouthY, Math.max(W, H) * 0.62);
    back.addColorStop(0, rgba(live ? GOLD : BAD, (live ? 0.07 : 0.04) * lit));
    back.addColorStop(0.28, rgba(hue, 0.075 * lit));
    back.addColorStop(0.68, rgba(hue, 0.026 * lit));
    back.addColorStop(1, rgba(hue, 0));
    x.fillStyle = back;
    x.fillRect(0, 0, W, H);

    this.drawSeal(now, hue, lit);
    this.drawMouth(now, hue, lit, pulse);
    this.drawArch(now, hue, lit, pulse);
    this.drawFloor(hue, lit);
    this.drawMotes(hue, lit);

    // The figure and the control stand in the middle of all this, so the
    // middle is where the light is taken back out: everything glows from the
    // rim and the floor, and the words keep a dark ground to sit on.
    const scrim = x.createRadialGradient(cx, H * 0.46, 0, cx, H * 0.46, Math.max(W, H) * 0.42);
    scrim.addColorStop(0, 'rgba(5,5,10,0.74)');
    scrim.addColorStop(0.45, 'rgba(5,5,10,0.44)');
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

  // the standing seal behind the arch: a rune band that never stops turning
  drawSeal(now, hue, lit) {
    const { x } = this;
    const cx = this.W / 2;
    const cy = this.mouthY;
    const R = this.AH * 0.60;
    const ring = (r) => () => { x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); };
    x.save();
    x.translate(cx, cy);
    const c = rgba(hue, 1);
    x.rotate(this.spin);
    this.glowStroke(ring(R), c, 7, 26, 0.07 * lit);
    this.glowStroke(ring(R), c, 1.4, 12, 0.34 * lit);

    // the band of ticks, every fifth one long
    x.save();
    x.strokeStyle = c;
    x.shadowColor = c;
    x.shadowBlur = 8;
    x.globalAlpha = 0.3 * lit;
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
    this.glowStroke(ring(R * 1.16), c, 1.1, 10, 0.22 * lit);
    x.setLineDash([R * 0.04, R * 0.16]);
    this.glowStroke(ring(R * 0.86), c, 1, 8, 0.18 * lit);
    x.setLineDash([]);
    x.restore();
  }

  // inside the arch: dark at the top, the Hoard's light pooling at the floor,
  // and a seam of it splitting the middle
  drawMouth(now, hue, lit, pulse) {
    const { x } = this;
    const cx = this.W / 2;
    const base = this.floorY;
    x.save();
    this.arch(1, true);
    x.clip();

    const inner = x.createLinearGradient(0, base - this.AH, 0, base);
    inner.addColorStop(0, 'rgba(4,4,9,0.98)');
    inner.addColorStop(0.55, 'rgba(6,5,12,0.95)');
    inner.addColorStop(1, this.sealed ? 'rgba(16,7,10,0.95)' : 'rgba(26,17,10,0.95)');
    x.fillStyle = inner;
    this.arch(1, true);
    x.fill();

    // the Hoard, glowing up out of the floor of the mouth
    const pool = x.createRadialGradient(cx, base, 0, cx, base, this.AW * 0.8);
    const pc = this.sealed ? BAD : GOLD;
    pool.addColorStop(0, rgba(pc, (this.sealed ? 0.20 : 0.46) * lit));
    pool.addColorStop(0.45, rgba(pc, (this.sealed ? 0.06 : 0.14) * lit));
    pool.addColorStop(1, rgba(pc, 0));
    x.fillStyle = pool;
    x.fillRect(cx - this.AW, base - this.AH, this.AW * 2, this.AH);

    // the seam: the tear itself, breathing
    const seamW = (this.AW * 0.028) * pulse * (0.5 + this.heat * 1.6);
    const seam = x.createLinearGradient(cx - seamW * 3, 0, cx + seamW * 3, 0);
    seam.addColorStop(0, rgba(hue, 0));
    seam.addColorStop(0.5, rgba(this.sealed ? BAD : ACCENT_SOFT, 0.4 * lit));
    seam.addColorStop(1, rgba(hue, 0));
    x.fillStyle = seam;
    x.fillRect(cx - seamW * 3, base - this.AH * 0.94, seamW * 6, this.AH * 0.94);

    if (!this.sealed) this.drawEmbers(lit);
    x.restore();

    // what is barred is shown barred: two struck bands across the mouth
    if (this.sealed) {
      x.save();
      this.arch(1, true);
      x.clip();
      x.strokeStyle = rgba(BAD, 0.5);
      x.shadowColor = rgba(BAD, 1);
      x.shadowBlur = 18;
      x.lineWidth = 7;
      for (const f of [0.42, 0.62]) {
        const y = base - this.AH * f;
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
    const base = this.floorY;
    for (const e of this.embers) {
      const py = base - this.AH * 0.95 * e.y;
      const px = cx + e.x * this.AW * (0.35 + e.y * 0.5) + Math.sin(e.w) * 9;
      x.globalAlpha = clamp((1 - e.y) * 0.8, 0, 1) * lit;
      x.fillStyle = rgba(e.s > 1.7 ? GOLD_SOFT : GOLD, 1);
      x.beginPath();
      x.arc(px, py, e.s * 0.7, 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = 1;
  }

  // the arch's own stone: a wide bloom, a body, a hot inner edge
  drawArch(now, hue, lit, pulse) {
    const c = rgba(hue, 1);
    const hot = rgba(this.sealed ? mix(ASH, BAD, 0.5) : ACCENT_SOFT, 1);
    const p = () => this.arch(1);
    this.glowStroke(p, c, 22, 46, 0.09 * lit);
    this.glowStroke(p, c, 6, 26, 0.26 * lit);
    this.glowStroke(p, c, 2, 14, 0.85 * lit);
    this.glowStroke(p, hot, 0.9, 7, (0.5 + this.heat * 0.5) * lit);

    // the keystone, on the point of the arch
    const { x } = this;
    const cx = this.W / 2;
    const ky = this.floorY - this.AH;
    const d = 11 * pulse;
    x.save();
    x.translate(cx, ky);
    const dia = () => { x.beginPath(); x.moveTo(0, -d); x.lineTo(d * 0.72, 0); x.lineTo(0, d); x.lineTo(-d * 0.72, 0); x.closePath(); };
    this.glowStroke(dia, c, 6, 20, 0.22 * lit);
    x.fillStyle = hot;
    x.shadowColor = hot;
    x.shadowBlur = 16;
    x.globalAlpha = (0.55 + this.heat * 0.45) * lit;
    dia();
    x.fill();
    x.restore();
  }

  // the ground the arch stands on, and what it throws down in front of it
  drawFloor(hue, lit) {
    const { x, W } = this;
    const cx = W / 2;
    const base = this.floorY;
    const spill = x.createRadialGradient(cx, base, 0, cx, base, this.AW * 1.35);
    const pc = this.sealed ? BAD : GOLD;
    spill.addColorStop(0, rgba(pc, 0.20 * lit));
    spill.addColorStop(0.4, rgba(hue, 0.07 * lit));
    spill.addColorStop(1, rgba(hue, 0));
    x.save();
    x.translate(cx, base);
    x.scale(1, 0.24);
    x.fillStyle = spill;
    x.beginPath();
    x.arc(0, 0, this.AW * 1.35, 0, Math.PI * 2);
    x.fill();
    x.restore();

    const line = x.createLinearGradient(cx - W * 0.45, 0, cx + W * 0.45, 0);
    line.addColorStop(0, rgba(hue, 0));
    line.addColorStop(0.5, rgba(hue, 0.4 * lit));
    line.addColorStop(1, rgba(hue, 0));
    x.save();
    x.strokeStyle = line;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(cx - W * 0.45, base);
    x.lineTo(cx + W * 0.45, base);
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
