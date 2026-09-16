// The Red Gate: the descent, as an event.
//
// The constitution allows at most two ambient motions per screen but says
// event motion is free, so the Gate WINDOW in the Vault stays flat and
// still and everything here happens in a full-screen overlay that exists
// only while a hunter is inside.
//
// The scene is a vertical shaft. Six seals hang below you, one per rank,
// drawn in perspective. Each seal's rim is ten passages and you pick the
// one you go down; which of them are open was decided by the Worker at
// entry and is never sent here, so the choice is real and cannot be
// rerolled. Clearing a rank drops you onto its seal, which burns behind
// you. Picking a blocked passage turns the seal red and throws you out.
//
// Self-contained: DOM, one canvas and WebAudio. It knows nothing about the
// API. app.js hands it the callbacks and the state they return.

const ACCENT = '#8B7CFF';
const ACCENT_SOFT = '#CFC9FF';
const GOLD = '#E8B64A';
const BAD = '#E5484D';
const OK = '#4CC38A';
const SPACING = 300;   // world units between seals
const FLOORS = 6;
const START_Y = -SPACING * 0.36; // the mouth of the Gate, just above the E seal

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => 1 - (1 - t) ** 3;
const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------- sound ----------
// All synthesized: anything loaded over the network would arrive after the
// moment it is meant to land.

let actx = null;
const ctx = () => {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
};

function tone(freq, { dur = 0.3, gain = 0.12, type = 'triangle', delay = 0, to = null, attack = 0.01 } = {}) {
  try {
    const c = ctx();
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(attack, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch { /* sound is optional */ }
}

let noiseBuf = null;
function noise({ dur = 0.3, gain = 0.15, from = 2000, to = 300, type = 'bandpass', q = 1, delay = 0, attack = 0 } = {}) {
  try {
    const c = ctx();
    if (!noiseBuf) {
      const len = c.sampleRate * 2;
      noiseBuf = c.createBuffer(1, len, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = c.createGain();
    if (attack > 0) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * attack);
    } else g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t);
    src.stop(t + dur + 0.05);
  } catch { /* sound is optional */ }
}

const RANK_NOTES = [196.0, 233.08, 261.63, 311.13, 349.23, 415.30]; // a minor climb

const snd = {
  open() {
    noise({ dur: 1.1, gain: 0.2, from: 120, to: 2400, type: 'bandpass', q: 0.6, attack: 0.75 });
    tone(46, { dur: 1.4, gain: 0.28, type: 'sine', to: 30 });
    tone(69, { dur: 1.4, gain: 0.1, type: 'sine', to: 46 });
  },
  hover() { tone(880, { dur: 0.05, gain: 0.025, type: 'sine' }); },
  commit() {
    noise({ dur: 0.5, gain: 0.1, from: 400, to: 2600, type: 'bandpass', q: 1.1, attack: 0.7 });
    tone(110, { dur: 0.45, gain: 0.12, type: 'sine', to: 70 });
  },
  pass(i) {
    tone(RANK_NOTES[i], { dur: 0.9, gain: 0.13 });
    tone(RANK_NOTES[i] * 1.5, { dur: 0.6, gain: 0.05, type: 'sine', delay: 0.02 });
    tone(RANK_NOTES[i] * 2, { dur: 0.45, gain: 0.03, type: 'sine', delay: 0.04 });
    noise({ dur: 0.3, gain: 0.07, from: 900, to: 180, type: 'lowpass', q: 0.8 });
    tone(58, { dur: 0.35, gain: 0.18, type: 'sine', to: 34 });
  },
  fail() {
    noise({ dur: 0.22, gain: 0.32, from: 5200, to: 800, type: 'bandpass', q: 0.7 });
    noise({ dur: 1.5, gain: 0.18, from: 1200, to: 45, type: 'lowpass', q: 0.7, attack: 0.25 });
    tone(72, { dur: 1.3, gain: 0.28, type: 'sine', to: 24 });
    tone(76, { dur: 1.3, gain: 0.14, type: 'sine', to: 27 });
  },
  grab() {
    noise({ dur: 0.18, gain: 0.4, from: 1800, to: 180, type: 'lowpass', q: 1.4 });
    tone(58, { dur: 0.8, gain: 0.32, type: 'sawtooth', to: 30 });
    tone(41, { dur: 1.1, gain: 0.2, type: 'sine', to: 26 });
  },
  struggle(n) {
    noise({ dur: 0.07, gain: 0.12, from: 900 + n * 60, to: 300, type: 'bandpass', q: 1.6 });
    tone(150 + n * 14, { dur: 0.06, gain: 0.05, type: 'square' });
  },
  free() {
    noise({ dur: 0.35, gain: 0.16, from: 300, to: 3200, type: 'bandpass', q: 0.6, attack: 0.5 });
    tone(392, { dur: 0.5, gain: 0.1 });
    tone(587.33, { dur: 0.45, gain: 0.07, delay: 0.06 });
  },
  take(n) {
    for (let i = 0; i < Math.min(8, Math.max(1, n)); i++) tone(523.25 * (1 + i * 0.12), { dur: 0.3, gain: 0.05, type: 'sine', delay: i * 0.055 });
    tone(65, { dur: 0.5, gain: 0.15, type: 'sine', to: 42 });
  },
  clear() {
    [261.63, 329.63, 392.0, 523.25, 659.25].forEach((f, i) => tone(f, { dur: 1.3, gain: 0.1, delay: i * 0.08 }));
    tone(43, { dur: 1.8, gain: 0.28, type: 'sine', to: 32 });
    noise({ dur: 1.6, gain: 0.12, from: 260, to: 4000, type: 'bandpass', q: 0.5, attack: 0.6 });
  },
};

// ---------- the shaft ----------

class Shaft {
  constructor(canvas, ranks, doors) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.ranks = ranks;
    this.doors = doors;
    // the camera sits level with the rank you are standing on, so the near
    // seal keeps a constant size; only the hunter starts above the mouth
    this.cam = 0;
    this.camTarget = 0;
    this.marker = START_Y;
    this.markerTarget = START_Y;
    this.spin = 0;
    this.lit = -1;          // deepest seal cleared
    this.doorFloor = 0;     // the seal whose passages can be picked
    this.hover = -1;
    this.chosen = -1;
    this.row = null;        // revealed passages, after a rank resolves
    this.revealT = 0;
    this.broken = -1;
    this.breakT = 0;
    this.flash = 0;
    this.flashColor = '#FFFFFF';
    this.shake = 0;
    this.grip = 0;          // 0..1, something holding you
    this.embers = [];
    this.shards = [];
    this.coins = [];
    this.running = true;
    this.born = performance.now();
    this.last = this.born;
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  // Read off the clock, not accumulated per frame. A browser that stops
  // painting (the tab in the background, the window behind another) stops
  // calling rAF, and the rift would stay shut with the passages collapsed
  // on top of each other, unclickable, until it came back.
  get opening() {
    return clamp((performance.now() - this.born) / 870, 0, 1);
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.c.width = Math.round(this.W * dpr);
    this.c.height = Math.round(this.H * dpr);
    this.c.style.width = this.W + 'px';
    this.c.style.height = this.H + 'px';
    this.x.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  stop() {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
  }

  // A real perspective divide, so the whole shaft is visible at once and the
  // deeper ranks compress toward a vanishing point below the middle: you can
  // see how far down the S rank is before deciding to go for it.
  project(worldY) {
    const k = this.H / 800;
    const d = worldY - this.cam + 340;
    if (d < 120) return { y: -this.H, s: 0, d, off: true }; // passed, above the camera
    return { y: this.H * 0.72 - (92480 * k) / d, s: (460 * k) / d, d, off: false };
  }

  sealGeom(i) {
    const p = this.project(i * SPACING);
    return { ...p, rx: 240 * p.s * ease(this.opening), ry: 240 * p.s * ease(this.opening) * 0.30 };
  }

  // Where each passage of the door seal sits on screen. The door seal does
  // not spin, or the thing you are trying to click would run away.
  doorPositions() {
    const i = this.doorFloor;
    if (i < 0 || i >= FLOORS) return [];
    const g = this.sealGeom(i);
    if (g.off) return [];
    const out = [];
    for (let k = 0; k < this.doors; k++) {
      const a = (k / this.doors) * Math.PI * 2 - Math.PI / 2;
      out.push({ i: k, x: this.W / 2 + Math.cos(a) * g.rx, y: g.y + Math.sin(a) * g.ry, r: clamp(20 * g.s, 9, 22), a });
    }
    return out;
  }

  pick(px, py) {
    let best = -1;
    let bd = 1e9;
    for (const p of this.doorPositions()) {
      const d = Math.hypot(px - p.x, py - p.y);
      if (d < Math.max(24, p.r * 1.9) && d < bd) { bd = d; best = p.i; }
    }
    return best;
  }

  burst(worldY, color, n = 40, speed = 380) {
    const { y } = this.project(worldY);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(speed * 0.3, speed);
      this.shards.push({
        x: this.W / 2 + Math.cos(a) * rnd(0, 60), y: y + Math.sin(a) * rnd(0, 18),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.45 - rnd(40, 200),
        rot: rnd(0, 6.3), vr: rnd(-8, 8), size: rnd(3, 10), life: rnd(0.6, 1.4), t: 0, c: color,
      });
    }
  }

  pour(worldY, n) {
    const { y } = this.project(worldY);
    for (let i = 0; i < Math.min(160, 14 + n * 6); i++) {
      this.coins.push({
        x: this.W / 2 + rnd(-90, 90), y: y + rnd(-20, 20),
        vx: rnd(-90, 90), vy: rnd(-520, -220), rot: rnd(0, 6.3), vr: rnd(-7, 7),
        life: rnd(1.1, 2), t: 0, delay: rnd(0, 0.5),
      });
    }
  }

  frame(t) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    try { this.update(dt); this.draw(t); } catch { /* a drawing hiccup never breaks the page */ }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  update(dt) {
    this.cam += (this.camTarget - this.cam) * Math.min(1, dt * 4.2);
    this.marker += (this.markerTarget - this.marker) * Math.min(1, dt * 5.5);
    this.spin += dt * 0.35;
    if (this.broken >= 0) this.breakT += dt;
    if (this.row) this.revealT += dt;
    this.flash *= Math.exp(-dt * 5);
    this.shake *= Math.exp(-dt * 3.4);

    if (this.embers.length < 60 && Math.random() < dt * 80) {
      this.embers.push({ x: rnd(0, this.W), y: this.H + 10, v: rnd(26, 90), s: rnd(0.7, 2.1), a: rnd(0.12, 0.5), w: rnd(0, 6.3) });
    }
    for (const e of this.embers) { e.y -= e.v * dt; e.w += dt * 1.6; }
    this.embers = this.embers.filter((e) => e.y > -20);

    for (const s of this.shards) { s.t += dt; s.vy += 620 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt; }
    this.shards = this.shards.filter((s) => s.t < s.life);
    for (const c of this.coins) {
      if (c.delay > 0) { c.delay -= dt; continue; }
      c.t += dt; c.vy += 300 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
    }
    this.coins = this.coins.filter((c) => c.t < c.life);
  }

  draw(now) {
    const { x, W, H } = this;
    x.clearRect(0, 0, W, H);
    x.save();
    if (this.shake > 0.2) x.translate(rnd(-this.shake, this.shake), rnd(-this.shake, this.shake));

    const o = ease(this.opening);

    // the seals, far to near, so the near ones sit on top
    const order = [];
    for (let i = 0; i < FLOORS; i++) order.push(i);
    order.sort((a, b) => this.project(b * SPACING).d - this.project(a * SPACING).d);
    for (const i of order) this.drawSeal(i, now, o);

    this.drawMarker(now);

    for (const e of this.embers) {
      x.globalAlpha = e.a * o;
      x.fillStyle = e.s > 1.6 ? ACCENT_SOFT : ACCENT;
      x.beginPath();
      x.arc(e.x + Math.sin(e.w) * 9, e.y, e.s, 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = 1;

    for (const s of this.shards) {
      const k = 1 - s.t / s.life;
      x.save();
      x.translate(s.x, s.y);
      x.rotate(s.rot);
      x.globalAlpha = Math.min(1, k * 1.7);
      x.fillStyle = s.c;
      x.beginPath();
      x.moveTo(-s.size * 0.6, -s.size * 0.35);
      x.lineTo(s.size * 0.7, -s.size * 0.1);
      x.lineTo(0, s.size * 0.55);
      x.closePath();
      x.fill();
      x.restore();
    }

    for (const c of this.coins) {
      if (c.delay > 0) continue;
      const k = 1 - c.t / c.life;
      x.save();
      x.translate(c.x, c.y);
      x.rotate(c.rot);
      x.globalAlpha = Math.min(1, k * 1.6);
      x.strokeStyle = GOLD;
      x.lineWidth = 1.4;
      x.beginPath();
      x.moveTo(0, -5); x.lineTo(4, 0); x.lineTo(0, 5); x.lineTo(-4, 0); x.closePath();
      x.stroke();
      x.restore();
    }
    x.globalAlpha = 1;
    x.restore();

    // something holding you: the shaft closes in from the edges
    if (this.grip > 0.01) {
      const g = x.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.12, W / 2, H * 0.45, Math.max(W, H) * 0.62);
      g.addColorStop(0, 'rgba(90,10,18,0)');
      g.addColorStop(1, `rgba(120,12,22,${0.85 * this.grip})`);
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
    }

    if (this.flash > 0.01) {
      x.fillStyle = this.flashColor;
      x.globalAlpha = Math.min(1, this.flash);
      x.fillRect(0, 0, W, H);
      x.globalAlpha = 1;
    }
  }

  drawSeal(i, now, o) {
    const { x, W } = this;
    const g = this.sealGeom(i);
    if (g.off || g.y < -300 || g.y > this.H + 400) return;
    const { y, s, rx, ry } = g;
    const passed = i <= this.lit;
    const isBroken = i === this.broken;
    const isDoor = i === this.doorFloor && this.row === null;
    const showRow = i === this.doorFloor && this.row !== null;
    const base = isBroken ? BAD : passed ? ACCENT : 'rgba(150,160,180,0.55)';
    const brk = isBroken ? clamp(this.breakT / 0.5, 0, 1) : 0;
    // the seal you are choosing on holds still; the rest turn slowly
    const spin = (isDoor || showRow) ? 0 : this.spin * (passed ? 0.5 : 0.22) + i * 0.8;

    x.save();
    x.translate(W / 2, y);

    if (passed || isDoor || isBroken) {
      const gl = x.createRadialGradient(0, 0, 0, 0, 0, rx * 1.3);
      const c = isBroken ? '229,72,77' : '139,124,255';
      gl.addColorStop(0, `rgba(${c},${(isDoor ? 0.2 : 0.14) * (1 - brk)})`);
      gl.addColorStop(1, `rgba(${c},0)`);
      x.save();
      x.scale(1, 0.32);
      x.fillStyle = gl;
      x.beginPath();
      x.arc(0, 0, rx * 1.3, 0, Math.PI * 2);
      x.fill();
      x.restore();
    }

    x.globalAlpha = (isBroken ? 1 - brk * 0.75 : 1) * o;
    x.save();
    x.scale(1, 0.30);
    x.rotate(spin);
    x.strokeStyle = base;
    x.lineWidth = passed ? 2 : 1.2;
    x.beginPath();
    x.arc(0, 0, rx * (1 + brk * 0.25), 0, Math.PI * 2);
    x.stroke();
    x.globalAlpha = ((passed || isDoor ? 0.7 : 0.3) * (1 - brk)) * o;
    x.beginPath();
    x.arc(0, 0, rx * 0.62, 0, Math.PI * 2);
    x.stroke();
    x.rotate(-spin * 2.2);
    x.beginPath();
    const d = rx * 0.3;
    x.moveTo(0, -d); x.lineTo(d, 0); x.lineTo(0, d); x.lineTo(-d, 0); x.closePath();
    x.stroke();
    x.restore();
    x.restore();

    // the passages: ten gaps in the rim, the thing you actually choose
    if (isDoor || showRow) this.drawDoors(i, now, o, showRow);

    x.save();
    x.globalAlpha = (passed ? 0.95 : isDoor ? 0.9 : 0.45) * (1 - brk) * o;
    x.fillStyle = isBroken ? BAD : passed ? ACCENT_SOFT : 'rgba(151,163,180,0.95)';
    x.font = `700 ${Math.round(clamp(30 * s, 11, 34))}px Rajdhani, sans-serif`;
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    x.fillText(this.ranks[i], W / 2 + rx + 14 * clamp(s, 0.4, 1), y);
    x.restore();
  }

  drawDoors(i, now, o, revealed) {
    const { x } = this;
    const reveal = revealed ? clamp(this.revealT / 0.45, 0, 1) : 0;
    for (const p of this.doorPositions()) {
      const open = revealed ? !!this.row[p.i] : null;
      const isChosen = revealed && p.i === this.chosen;
      const hot = !revealed && p.i === this.hover;
      let color = ACCENT_SOFT;
      if (revealed) color = open ? OK : BAD;
      const a = revealed ? 0.25 + reveal * 0.75 : hot ? 1 : 0.62;
      x.save();
      x.translate(p.x, p.y);
      x.globalAlpha = a * o;
      // a gap in the rim, drawn as a small arch standing on the ring
      const r = p.r * (hot ? 1.3 : 1) * (isChosen ? 1.35 : 1);
      x.strokeStyle = color;
      x.fillStyle = revealed && open ? 'rgba(76,195,138,0.22)' : revealed ? 'rgba(229,72,77,0.22)' : hot ? 'rgba(207,201,255,0.28)' : 'rgba(139,124,255,0.12)';
      x.lineWidth = isChosen ? 2.4 : hot ? 2 : 1.2;
      x.beginPath();
      x.moveTo(-r * 0.42, r * 0.34);
      x.lineTo(-r * 0.42, -r * 0.1);
      x.quadraticCurveTo(0, -r * 0.62, r * 0.42, -r * 0.1);
      x.lineTo(r * 0.42, r * 0.34);
      x.closePath();
      x.fill();
      x.stroke();
      if (revealed && !open) {
        x.strokeStyle = BAD;
        x.lineWidth = 2;
        x.beginPath();
        x.moveTo(-r * 0.3, -r * 0.2); x.lineTo(r * 0.3, r * 0.26);
        x.moveTo(r * 0.3, -r * 0.2); x.lineTo(-r * 0.3, r * 0.26);
        x.stroke();
      }
      if (isChosen) {
        x.globalAlpha = a * o;
        x.strokeStyle = '#FFFFFF';
        x.lineWidth = 1.4;
        x.beginPath();
        x.arc(0, 0, r * 1.15, 0, Math.PI * 2);
        x.stroke();
      }
      x.restore();
    }
  }

  drawMarker(now) {
    const { x, W } = this;
    const { y, s, off } = this.project(this.marker);
    if (off) return;
    const r = 15 * clamp(s, 0.5, 1.3);
    x.save();
    x.translate(W / 2, y);
    const gl = x.createRadialGradient(0, 0, 0, 0, 0, r * 4);
    gl.addColorStop(0, 'rgba(207,201,255,0.5)');
    gl.addColorStop(1, 'rgba(139,124,255,0)');
    x.fillStyle = gl;
    x.beginPath();
    x.arc(0, 0, r * 4, 0, Math.PI * 2);
    x.fill();
    x.rotate(now / 900);
    x.fillStyle = '#FFFFFF';
    x.strokeStyle = ACCENT_SOFT;
    x.lineWidth = 1.5;
    x.beginPath();
    x.moveTo(0, -r); x.lineTo(r * 0.72, 0); x.lineTo(0, r); x.lineTo(-r * 0.72, 0); x.closePath();
    x.fill();
    x.stroke();
    x.restore();
  }
}

// ---------- the overlay ----------

// opts: { gate, descend(door, floor), extract(), onEnd(state) }
export function openDescent(opts) {
  if (document.querySelector('.rg')) return;
  const gate = opts.gate;
  const ranks = gate.ranks;
  const DOORS = gate.doors || 10;

  const overlay = el('div', 'rg');
  const canvas = el('canvas', 'rg-fx');
  const veil = el('div', 'rg-veil');
  const hud = el('div', 'rg-hud');

  const top = el('div', 'rg-top');
  const hoard = el('div', 'rg-hoard');
  hoard.append(el('span', 'l', 'HOARD'), el('span', 'v', String(gate.hoard)));
  top.append(el('div', 'rg-title', '[ THE RED GATE ]'), hoard);

  const mid = el('div', 'rg-mid');
  const rankLine = el('div', 'rg-rank', 'THE GATE OPENS');
  const holdWrap = el('div', 'rg-hold');
  holdWrap.append(el('span', 'l', 'HOLDING'));
  const holdVal = el('span', 'v', '0');
  holdWrap.append(holdVal);
  mid.append(rankLine, holdWrap);

  const say = el('div', 'rg-say');
  const bar = el('div', 'rg-bar');
  hud.append(top, mid, say, bar);
  overlay.append(canvas, veil, hud);
  document.body.append(overlay);

  const timers = [];
  let ended = false;
  let busy = false;
  // a descent left open in another tab, or before a reload, is resumed where
  // the Worker says it is, not from the top
  let floor = gate.run ? gate.run.floor : 0;
  let holding = gate.run ? gate.run.holding : 0;
  let hoardNow = gate.hoard;
  const later = (fn, ms) => { const t = setTimeout(() => { if (!ended) fn(); }, ms); timers.push(t); return t; };
  const shaft = reduced() ? null : new Shaft(canvas, ranks, DOORS);
  // the scene hangs off its own node, so the passages can be located from
  // outside for a test without a global
  overlay.__scene = shaft;

  const finish = (result) => {
    if (ended) return;
    ended = true;
    timers.forEach(clearTimeout);
    if (shaft) shaft.stop();
    document.removeEventListener('keydown', onKey);
    overlay.classList.add('out');
    setTimeout(() => {
      overlay.remove();
      if (opts.onEnd) opts.onEnd(result);
    }, 420);
  };

  const setSay = (text, kind) => {
    say.textContent = text;
    say.className = 'rg-say' + (kind ? ' ' + kind : '');
  };
  const setHolding = (n) => {
    holding = n;
    holdVal.textContent = String(n);
    holdVal.classList.remove('tick');
    void holdVal.offsetWidth;
    holdVal.classList.add('tick');
  };
  const setHoard = (n) => { hoardNow = n; hoard.querySelector('.v').textContent = String(n); };

  const button = (cls, label, fn) => {
    const b = el('button', 'rg-btn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.append(el('span', 't', label));
    b.addEventListener('click', fn);
    return b;
  };

  const renderBar = () => {
    bar.replaceChildren();
    if (busy) return;
    if (floor > 0) bar.append(button('out', floor >= FLOORS ? `TAKE THE HOARD · ${holding}` : `WALK OUT WITH ${holding}`, () => doExtract()));
    else bar.append(button('ghost', 'NOT TONIGHT', () => finish(null)));
  };

  const promptDoors = () => {
    if (floor >= FLOORS) {
      setSay('The S rank is cleared. Nothing is below you but the Hoard.', 'gold');
      return;
    }
    const chance = Math.round(gate.survive[floor] * 100);
    const open = Math.round(gate.survive[floor] * DOORS);
    const claim = Math.min(gate.claim[floor], hoardNow);
    rankLine.textContent = floor === 0 ? 'THE GATE OPENS' : `${ranks[floor - 1]} RANK CLEARED`;
    setSay(`${ranks[floor]} rank: ${DOORS} passages, ${open} of them open. Pick one. ${floor + 1 === FLOORS ? 'It leads to the Hoard.' : `It pays ${claim}.`}`);
    if (shaft) { shaft.doorFloor = floor; shaft.row = null; shaft.chosen = -1; shaft.hover = -1; }
  };

  // ---- the opening ----
  const resumed = floor > 0;
  setSay(resumed
    ? `You are still inside, ${ranks[floor - 1]} rank, holding ${holding}.`
    : 'The seal gives. Six ranks lie below.');
  if (resumed) setHolding(holding);
  if (shaft) {
    if (resumed) {
      shaft.lit = floor - 1;
      shaft.cam = shaft.camTarget = (floor - 1) * SPACING;
      shaft.marker = shaft.markerTarget = (floor - 1) * SPACING;
    }
    shaft.flash = 0.4;
    shaft.flashColor = '#2A1030';
    snd.open();
  }
  overlay.classList.add('on');
  later(() => { renderBar(); promptDoors(); }, reduced() ? 60 : 1150);

  // ---- picking a passage ----
  canvas.addEventListener('mousemove', (e) => {
    if (!shaft || busy || shaft.row) return;
    const was = shaft.hover;
    shaft.hover = shaft.pick(e.clientX, e.clientY);
    canvas.style.cursor = shaft.hover >= 0 ? 'pointer' : 'default';
    if (shaft.hover >= 0 && shaft.hover !== was) snd.hover();
  });
  canvas.addEventListener('click', (e) => {
    if (!shaft || busy || shaft.row) return;
    const d = shaft.pick(e.clientX, e.clientY);
    if (d >= 0) doDescend(d);
  });

  async function doDescend(door) {
    if (busy || ended || floor >= FLOORS) return;
    busy = true;
    renderBar();
    const target = floor;
    if (shaft) { shaft.chosen = door; shaft.hover = -1; }
    setSay('You step into it.');
    snd.commit();

    let res;
    const beat = new Promise((r) => later(() => r(), reduced() ? 0 : 700));
    try {
      [res] = await Promise.all([opts.descend(door, target), beat]);
    } catch (e) {
      busy = false;
      if (shaft) { shaft.chosen = -1; }
      setSay(e && e.message ? e.message : 'The System refused.', 'err');
      renderBar();
      return;
    }
    if (ended) return;
    if (res && res.hoard !== undefined) setHoard(res.hoard);

    // the rank is resolved: show every passage it had
    if (shaft && res.row) { shaft.row = res.row; shaft.revealT = 0; }
    rankLine.textContent = `${ranks[target]} RANK`;
    await new Promise((r) => later(r, reduced() ? 0 : 620));
    if (ended) return;

    if (res.dead) {
      if (shaft) {
        shaft.broken = target;
        shaft.breakT = 0;
        shaft.flash = 0.75;
        shaft.flashColor = BAD;
        shaft.shake = 16;
        shaft.burst(target * SPACING, BAD, 70, 560);
        shaft.markerTarget = (target - 2.4) * SPACING;
        shaft.camTarget = (target - 1.8) * SPACING;
      }
      snd.fail();
      setSay(`Blocked. The ${ranks[target]} rank keeps what you were holding.`, 'err');
      holdWrap.classList.add('lost');
      setHolding(0);
      later(() => verdict(false, res), reduced() ? 400 : 1750);
      return;
    }

    floor = res.run ? res.run.floor : floor + 1;
    if (shaft) {
      shaft.lit = floor - 1;
      shaft.markerTarget = (floor - 1) * SPACING;
      shaft.camTarget = (floor - 1) * SPACING;
      shaft.flash = 0.14;
      shaft.flashColor = ACCENT_SOFT;
      shaft.shake = 5;
      shaft.burst((floor - 1) * SPACING, ACCENT_SOFT, 26, 260);
    }
    snd.pass(floor - 1);
    setHolding(res.run ? res.run.holding : holding);

    // one in five arrivals, something down there takes hold of you
    const grabbed = !reduced() && floor < FLOORS && Math.random() < 0.2;
    later(() => {
      if (grabbed) startGrasp();
      else { busy = false; promptDoors(); renderBar(); }
    }, reduced() ? 40 : 700);
  }

  // ---- the grasp: spam to break loose ----
  function startGrasp() {
    const NEED = 14;
    const MS = 4200;
    let hits = 0;
    const panel = el('div', 'rg-grasp');
    const ttl = el('div', 'g-ttl', 'SOMETHING HAS YOU');
    const sub = el('div', 'g-sub', 'CLICK TO BREAK LOOSE');
    const track = el('div', 'g-track');
    const fill = el('i');
    track.append(fill);
    panel.append(ttl, sub, track);
    overlay.append(panel);
    hud.classList.add('dim');
    snd.grab();
    if (shaft) { shaft.shake = 14; shaft.flash = 0.3; shaft.flashColor = BAD; }

    let done = false;
    const t0 = performance.now();
    const tick = () => {
      if (done || ended) return;
      const left = 1 - (performance.now() - t0) / MS;
      if (shaft) shaft.grip = clamp(1 - hits / NEED, 0, 1) * clamp(left * 1.6, 0, 1);
      if (left <= 0) return end(false);
      requestAnimationFrame(tick);
    };
    const onHit = () => {
      if (done) return;
      hits++;
      fill.style.width = Math.min(100, (hits / NEED) * 100) + '%';
      snd.struggle(hits);
      if (shaft) { shaft.shake = 6 + hits * 0.4; shaft.markerTarget += 3; }
      if (hits >= NEED) end(true);
    };
    const end = (freed) => {
      if (done) return;
      done = true;
      overlay.removeEventListener('pointerdown', onHit);
      panel.remove();
      hud.classList.remove('dim');
      if (shaft) shaft.grip = 0;
      if (freed) {
        snd.free();
        if (shaft) { shaft.flash = 0.25; shaft.flashColor = ACCENT_SOFT; shaft.shake = 8; }
        setSay('Loose. It did not get to keep you.');
        busy = false;
        promptDoors();
        renderBar();
      } else {
        // never costs links: it drags you out with what you were holding
        setSay('It drags you up the shaft. You are out, and you keep what you had.', 'err');
        doExtract(true);
      }
    };
    overlay.addEventListener('pointerdown', onHit);
    requestAnimationFrame(tick);
    later(() => end(hits >= NEED), MS + 60);
  }

  // ---- walking out ----
  async function doExtract(forced = false) {
    if ((busy && !forced) || ended) return;
    busy = true;
    renderBar();
    if (!forced) setSay('Climbing out.');
    let res;
    try {
      res = await opts.extract();
    } catch (e) {
      busy = false;
      setSay(e && e.message ? e.message : 'The System refused.', 'err');
      renderBar();
      return;
    }
    if (ended) return;
    if (res.hoard !== undefined) setHoard(res.hoard);
    if (shaft) {
      shaft.pour((floor - 1) * SPACING, res.taken);
      shaft.flash = res.cleared ? 0.5 : 0.18;
      shaft.flashColor = GOLD;
      shaft.shake = res.cleared ? 12 : 4;
      shaft.markerTarget = shaft.cam + START_Y * 2.4;
    }
    if (res.cleared) snd.clear(); else snd.take(res.taken);
    setHolding(res.taken);
    later(() => verdict(true, res), reduced() ? 300 : 1500);
  }

  // ---- the verdict card ----
  function verdict(won, res) {
    if (ended) return;
    hud.classList.add('gone');
    const card = el('div', 'rg-card' + (won ? ' win' : ' loss'));
    card.append(el('span', 'k', won ? '[ THE GATE RELEASES YOU ]' : '[ THE GATE CLOSES ]'));
    card.append(el('div', 'n', won ? `+${res.taken}` : '0'));
    card.append(el('span', 'u', won && res.taken === 1 ? 'LINK' : 'LINKS'));
    const lines = el('div', 'ls');
    if (won && res.cleared) {
      lines.append(el('p', null, `All six ranks. ${res.taken} ${res.taken === 1 ? 'link' : 'links'} of Hoard left with you, and it is empty now.`));
      lines.append(el('p', null, 'It starts filling again tonight, one link for the day and one for every day the group lets go.'));
    } else if (won) {
      lines.append(el('p', null, `Out of the ${res.rank} rank with ${res.taken} ${res.taken === 1 ? 'link' : 'links'}.`));
      lines.append(el('p', null, `The Hoard holds ${res.hoard}. It was there for the taking, and some of it still is.`));
    } else {
      lines.append(el('p', null, `The passage you picked at the ${res.rank} rank was blocked. Nothing leaves with you.`));
      lines.append(el('p', null, `The Hoard holds ${res.hoard}, and keys are cut for closed days. Close tomorrow and come back.`));
    }
    card.append(lines);
    const done = el('button', 'rg-btn out');
    done.type = 'button';
    done.append(el('span', 't', res.keys ? `AGAIN · ${res.keys} ${res.keys === 1 ? 'KEY' : 'KEYS'} LEFT` : 'CLOSE'));
    done.addEventListener('click', () => finish(res));
    card.append(done);
    overlay.append(card);
    later(() => finish(res), 22000);
  }

  const onKey = (e) => { if (e.key === 'Escape') finish(null); };
  document.addEventListener('keydown', onKey);
}
