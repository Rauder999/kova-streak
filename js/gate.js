// The Red Gate: the descent, as an event.
//
// The constitution allows at most two ambient motions per screen but says
// event motion is free, so the Gate WINDOW in the Vault stays flat and
// still and everything here happens in a full-screen overlay that exists
// only while a hunter is inside.
//
// The scene is a vertical shaft. Six seals hang below you, one per rank,
// drawn in perspective; you fall through them one at a time. The seal you
// are standing on burns, the one below waits. Passing a rank is a drop and
// a chime a tone higher. Failing one is the seal turning red, cracking and
// throwing you back up the shaft.
//
// Self-contained: DOM, one canvas and WebAudio. It knows nothing about the
// API. app.js hands it two async callbacks and the state they return.

const ACCENT = '#8B7CFF';
const ACCENT_SOFT = '#CFC9FF';
const CYAN = '#4FC3FF';
const GOLD = '#E8B64A';
const BAD = '#E5484D';
const SPACING = 300;   // world units between seals
const FLOORS = 6;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------- sound ----------
// All synthesized: the Gate has no samples of its own, and anything loaded
// over the network would arrive after the moment it is meant to land.

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

const RANK_NOTES = [196.0, 233.08, 261.63, 311.13, 349.23, 415.30]; // G3 Bb3 C4 Eb4 F4 Ab4, a minor climb

const snd = {
  open() {
    noise({ dur: 1.1, gain: 0.22, from: 120, to: 2400, type: 'bandpass', q: 0.6, attack: 0.75 });
    tone(46, { dur: 1.4, gain: 0.3, type: 'sine', to: 30 });
    tone(69, { dur: 1.4, gain: 0.12, type: 'sine', to: 46 });
    noise({ dur: 0.5, gain: 0.18, from: 3000, to: 500, type: 'bandpass', q: 0.9, delay: 0.85 });
  },
  charge(i) {
    // the seal below spinning up: a rising hum under a ticking rim
    tone(RANK_NOTES[i] / 2, { dur: 0.75, gain: 0.07, type: 'sawtooth', to: RANK_NOTES[i] * 0.9, attack: 0.3 });
    for (let k = 0; k < 5; k++) noise({ dur: 0.04, gain: 0.05, from: 5000, to: 3000, type: 'bandpass', q: 6, delay: 0.1 + k * 0.11 });
  },
  pass(i) {
    tone(RANK_NOTES[i], { dur: 0.9, gain: 0.13, type: 'triangle' });
    tone(RANK_NOTES[i] * 1.5, { dur: 0.6, gain: 0.05, type: 'sine', delay: 0.02 });
    tone(RANK_NOTES[i] * 2, { dur: 0.45, gain: 0.03, type: 'sine', delay: 0.04 });
    noise({ dur: 0.3, gain: 0.08, from: 900, to: 180, type: 'lowpass', q: 0.8 });
    tone(58, { dur: 0.35, gain: 0.2, type: 'sine', to: 34 });
  },
  fall() {
    noise({ dur: 0.6, gain: 0.12, from: 500, to: 1800, type: 'bandpass', q: 0.7, attack: 0.6 });
  },
  fail() {
    noise({ dur: 0.22, gain: 0.34, from: 5200, to: 800, type: 'bandpass', q: 0.7 });
    noise({ dur: 1.5, gain: 0.2, from: 1200, to: 45, type: 'lowpass', q: 0.7, attack: 0.25 });
    tone(72, { dur: 1.3, gain: 0.3, type: 'sine', to: 24 });
    tone(76, { dur: 1.3, gain: 0.16, type: 'sine', to: 27 });
    noise({ dur: 0.5, gain: 0.16, from: 300, to: 50, type: 'lowpass', q: 0.8, delay: 0.9 });
  },
  take(n) {
    for (let i = 0; i < Math.min(8, Math.max(1, n)); i++) {
      tone(523.25 * (1 + i * 0.12), { dur: 0.3, gain: 0.05, type: 'sine', delay: i * 0.055 });
    }
    tone(65, { dur: 0.5, gain: 0.16, type: 'sine', to: 42 });
  },
  clear() {
    [261.63, 329.63, 392.0, 523.25, 659.25].forEach((f, i) => tone(f, { dur: 1.3, gain: 0.1, type: 'triangle', delay: i * 0.08 }));
    tone(43, { dur: 1.8, gain: 0.3, type: 'sine', to: 32 });
    noise({ dur: 1.6, gain: 0.14, from: 260, to: 4000, type: 'bandpass', q: 0.5, attack: 0.6 });
  },
};

// ---------- the shaft ----------

class Shaft {
  constructor(canvas, ranks) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.ranks = ranks;
    this.cam = 0;          // world y the camera sits at
    this.camTarget = 0;
    this.marker = 0;       // world y of the hunter
    this.markerTarget = 0;
    this.spin = 0;
    this.lit = -1;         // deepest seal lit
    this.charging = -1;    // seal spinning up
    this.chargeT = 0;
    this.broken = -1;      // seal that gave way
    this.breakT = 0;
    this.flash = 0;
    this.flashColor = '#FFFFFF';
    this.shake = 0;
    this.embers = [];
    this.shards = [];
    this.coins = [];
    this.opening = 0;      // 0..1, the rift tearing open
    this.running = true;
    this.last = performance.now();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
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

  clearCanvas() {
    this.stop();
    try { this.x.clearRect(0, 0, this.W, this.H); } catch { /* going away anyway */ }
  }

  // Screen position for a point in the shaft. A real perspective divide, not
  // a linear offset: the whole shaft has to be visible at once, with the
  // ranks below you compressing toward the vanishing point, so you can see
  // how far down the S rank is before you decide to go for it. Descending
  // raises the camera's depth, which slides the shaft down and grows it.
  project(worldY) {
    const k = this.H / 800;
    const d = worldY - this.cam + 340;
    if (d < 120) return { y: -this.H, s: 0, d, off: true }; // passed, above the camera
    // the vanishing point sits below the middle, so deeper ranks recede
    // DOWNWARD and a rank you clear rushes up past you. It is not lower
    // than this: the shaft has to clear the line of text under it.
    return { y: this.H * 0.72 - (92480 * k) / d, s: (460 * k) / d, d, off: false };
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
    this.spin += dt * 0.5;
    if (this.charging >= 0) this.chargeT += dt;
    if (this.broken >= 0) this.breakT += dt;
    this.flash *= Math.exp(-dt * 5);
    this.shake *= Math.exp(-dt * 3.4);
    this.opening = Math.min(1, this.opening + dt * 1.15);

    if (this.embers.length < 70 && Math.random() < dt * 90) {
      this.embers.push({ x: rnd(0, this.W), y: this.H + 10, v: rnd(26, 90), s: rnd(0.7, 2.1), a: rnd(0.15, 0.6), w: rnd(0, 6.3) });
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

    // the shaft: a column of haze between the walls, opening as the rift tears
    const o = ease(this.opening);
    const halfW = W * 0.5 * o;
    x.globalAlpha = 0.5 * o;
    const g = x.createLinearGradient(W / 2 - halfW, 0, W / 2 + halfW, 0);
    g.addColorStop(0, 'rgba(11,13,18,0)');
    g.addColorStop(0.5, 'rgba(24,18,34,0.5)');
    g.addColorStop(1, 'rgba(11,13,18,0)');
    x.fillStyle = g;
    x.fillRect(W / 2 - halfW, 0, halfW * 2, H);
    x.globalAlpha = 1;

    // depth lines: horizontals that converge as they fall away
    x.strokeStyle = 'rgba(139,124,255,0.09)';
    x.lineWidth = 1;
    for (let i = -2; i < FLOORS + 3; i++) {
      for (let k = 1; k <= 3; k++) {
        const wy = i * SPACING + (k * SPACING) / 4;
        const { y, s } = this.project(wy);
        if (y < -40 || y > H + 40) continue;
        const w = 300 * s * o;
        x.beginPath();
        x.moveTo(W / 2 - w, y);
        x.lineTo(W / 2 + w, y);
        x.stroke();
      }
    }

    // the seals, far to near, so the near ones sit on top
    const order = [];
    for (let i = 0; i < FLOORS; i++) order.push(i);
    order.sort((a, b) => this.project(b * SPACING).d - this.project(a * SPACING).d);
    for (const i of order) this.drawSeal(i, now, o);

    // the hunter
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

    if (this.flash > 0.01) {
      x.fillStyle = this.flashColor;
      x.globalAlpha = Math.min(1, this.flash);
      x.fillRect(0, 0, W, H);
      x.globalAlpha = 1;
    }
  }

  // one rank's seal: a rune ring lying flat in the shaft
  drawSeal(i, now, o) {
    const { x, W } = this;
    const { y, s, off } = this.project(i * SPACING);
    if (off || y < -300 || y > this.H + 400) return;
    const rx = 240 * s * o;
    const ry = rx * 0.3;
    const passed = i <= this.lit;
    const isBroken = i === this.broken;
    const charging = i === this.charging;
    const base = isBroken ? BAD : passed ? ACCENT : 'rgba(150,160,180,0.55)';
    const spin = this.spin * (passed ? 0.5 : 0.22) + i * 0.8 + (charging ? this.chargeT * this.chargeT * 7 : 0);
    const brk = isBroken ? clamp(this.breakT / 0.5, 0, 1) : 0;

    x.save();
    x.translate(W / 2, y);

    // the glow pool under a live seal
    if (passed || charging || isBroken) {
      const gl = x.createRadialGradient(0, 0, 0, 0, 0, rx * 1.25);
      const c = isBroken ? '229,72,77' : '139,124,255';
      gl.addColorStop(0, `rgba(${c},${(charging ? 0.22 + Math.sin(now / 90) * 0.1 : 0.16) * (1 - brk)})`);
      gl.addColorStop(1, `rgba(${c},0)`);
      x.save();
      x.scale(1, 0.32);
      x.fillStyle = gl;
      x.beginPath();
      x.arc(0, 0, rx * 1.25, 0, Math.PI * 2);
      x.fill();
      x.restore();
    }

    x.globalAlpha = (isBroken ? 1 - brk * 0.75 : 1) * o;
    x.scale(1, 0.3);
    x.rotate(spin);

    // outer rim
    x.strokeStyle = base;
    x.lineWidth = (passed ? 2 : 1.2) / 0.3 * 0.3;
    x.beginPath();
    x.arc(0, 0, rx * (1 + brk * 0.25), 0, Math.PI * 2);
    x.stroke();

    // rune ticks
    const ticks = 28;
    x.lineWidth = 1;
    for (let k = 0; k < ticks; k++) {
      const a = (k / ticks) * Math.PI * 2;
      const len = k % 7 === 0 ? 16 : 8;
      const r0 = rx * (1 + brk * 0.25) - len * s;
      const r1 = rx * (1 + brk * 0.25);
      x.globalAlpha = ((passed || charging ? 0.85 : 0.4) * (1 - brk)) * o;
      x.strokeStyle = base;
      x.beginPath();
      x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      x.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      x.stroke();
    }

    // inner ring and the diamond at its heart
    x.globalAlpha = ((passed || charging ? 0.7 : 0.3) * (1 - brk)) * o;
    x.beginPath();
    x.arc(0, 0, rx * 0.62, 0, Math.PI * 2);
    x.stroke();
    x.rotate(-spin * 2.2);
    x.beginPath();
    const d = rx * 0.3;
    x.moveTo(0, -d); x.lineTo(d, 0); x.lineTo(0, d); x.lineTo(-d, 0); x.closePath();
    x.stroke();
    x.restore();

    // the rank letter, upright, riding just off the seal's rim
    x.save();
    x.globalAlpha = (passed ? 0.95 : charging ? 0.85 : 0.45) * (1 - brk) * o;
    x.fillStyle = isBroken ? BAD : passed ? ACCENT_SOFT : 'rgba(151,163,180,0.95)';
    x.font = `700 ${Math.round(clamp(30 * s, 11, 34))}px Rajdhani, sans-serif`;
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    x.fillText(this.ranks[i], W / 2 + rx + 12 * clamp(s, 0.4, 1), y);
    x.restore();
  }

  drawMarker(now) {
    const { x, W } = this;
    const { y, s } = this.project(this.marker);
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

// opts: { gate, descend(), extract(), onEnd(state) }
export function openDescent(opts) {
  if (document.querySelector('.rg')) return;
  const gate = opts.gate;
  const ranks = gate.ranks;

  const overlay = el('div', 'rg');
  const canvas = el('canvas', 'rg-fx');
  const veil = el('div', 'rg-veil');
  const hud = el('div', 'rg-hud');

  const top = el('div', 'rg-top');
  const title = el('div', 'rg-title', '[ THE RED GATE ]');
  const hoard = el('div', 'rg-hoard');
  hoard.append(el('span', 'l', 'HOARD'), el('span', 'v', String(gate.hoard)));
  top.append(title, hoard);

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
  let floor = 0;
  let holding = 0;
  let hoardNow = gate.hoard;
  const later = (fn, ms) => { const t = setTimeout(() => { if (!ended) fn(); }, ms); timers.push(t); return t; };
  const shaft = reduced() ? null : new Shaft(canvas, ranks);

  const finish = (result) => {
    if (ended) return;
    ended = true;
    timers.forEach(clearTimeout);
    if (shaft) shaft.stop();
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
  const setHoard = (n) => {
    hoardNow = n;
    hoard.querySelector('.v').textContent = String(n);
  };

  // ---- buttons ----
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
    const next = floor < FLOORS ? ranks[floor] : null;
    if (next) {
      const chance = Math.round(gate.survive[floor] * 100);
      const claim = Math.min(gate.claim[floor], hoardNow);
      const deeper = button('go', `DESCEND TO ${next}`, () => doDescend());
      deeper.append(el('span', 's', `${chance}% THROUGH · ${floor + 1 === FLOORS ? 'THE WHOLE HOARD' : claim + (claim === 1 ? ' LINK' : ' LINKS')}`));
      bar.append(deeper);
    }
    if (floor > 0) {
      const out = button('out', floor >= FLOORS ? `TAKE THE HOARD · ${holding}` : `WALK OUT WITH ${holding}`, () => doExtract());
      bar.append(out);
    }
    if (floor === 0) {
      const leave = button('ghost', 'NOT TONIGHT', () => finish(null));
      bar.append(leave);
    }
  };

  // ---- the opening ----
  setSay('The seal gives. Six ranks lie below.');
  if (shaft) {
    shaft.flash = 0.45;
    shaft.flashColor = '#2A1030';
    snd.open();
  }
  overlay.classList.add('on');
  later(renderBar, reduced() ? 60 : 1150);

  // ---- descending ----
  async function doDescend() {
    if (busy || ended) return;
    busy = true;
    renderBar();
    const target = floor; // index of the seal we are about to test
    rankLine.textContent = `${ranks[target]} RANK`;
    setSay('The seal is turning.');
    if (shaft) { shaft.charging = target; shaft.chargeT = 0; snd.charge(target); }

    let res;
    const rolled = new Promise((r) => later(() => r(), reduced() ? 0 : 820));
    try {
      [res] = await Promise.all([opts.descend(), rolled]);
    } catch (e) {
      busy = false;
      if (shaft) shaft.charging = -1;
      setSay(e && e.message ? e.message : 'The System refused.', 'err');
      renderBar();
      return;
    }
    if (ended) return;
    if (res && res.hoard !== undefined) setHoard(res.hoard);
    if (shaft) shaft.charging = -1;

    if (res.dead) {
      if (shaft) {
        shaft.broken = target;
        shaft.breakT = 0;
        shaft.flash = 0.8;
        shaft.flashColor = BAD;
        shaft.shake = 16;
        shaft.burst(target * SPACING, BAD, 70, 560);
        shaft.markerTarget = (target - 2.2) * SPACING;
        shaft.camTarget = (target - 1.6) * SPACING;
        snd.fail();
      }
      rankLine.textContent = `${ranks[target]} RANK`;
      setSay(`The ${ranks[target]} rank gave way. The Hoard keeps what you were holding.`, 'err');
      holdWrap.classList.add('lost');
      setHolding(0);
      later(() => verdict(false, res), reduced() ? 400 : 1700);
      return;
    }

    floor = res.run ? res.run.floor : floor + 1;
    if (shaft) {
      shaft.lit = floor - 1;
      shaft.markerTarget = (floor - 1) * SPACING + SPACING * 0.02;
      shaft.camTarget = (floor - 1) * SPACING;
      shaft.flash = 0.16;
      shaft.flashColor = ACCENT_SOFT;
      shaft.shake = 5;
      shaft.burst((floor - 1) * SPACING, ACCENT_SOFT, 26, 260);
      snd.fall();
      snd.pass(floor - 1);
    }
    setHolding(res.run ? res.run.holding : holding);
    rankLine.textContent = `${ranks[floor - 1]} RANK CLEARED`;
    if (floor >= FLOORS) setSay('The S rank. Nothing is below you but the Hoard.', 'gold');
    else setSay(`Holding ${holding}. The ${ranks[floor]} rank waits: ${Math.round(gate.survive[floor] * 100)}% through.`);
    busy = false;
    later(renderBar, reduced() ? 40 : 520);
  }

  // ---- walking out ----
  async function doExtract() {
    if (busy || ended) return;
    busy = true;
    renderBar();
    setSay('Climbing out.');
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
      shaft.flash = res.cleared ? 0.55 : 0.2;
      shaft.flashColor = GOLD;
      shaft.shake = res.cleared ? 12 : 4;
      shaft.camTarget = -SPACING * 1.2;
      shaft.markerTarget = -SPACING * 1.6;
      if (res.cleared) snd.clear(); else snd.take(res.taken);
    }
    setHolding(res.taken);
    later(() => verdict(true, res), reduced() ? 300 : 1500);
  }

  // ---- the verdict card ----
  function verdict(won, res) {
    if (ended) return;
    hud.classList.add('gone');
    const card = el('div', 'rg-card' + (won ? ' win' : ' loss'));
    card.append(el('span', 'k', won ? '[ THE GATE RELEASES YOU ]' : '[ THE GATE CLOSES ]'));
    const big = el('div', 'n', won ? `+${res.taken}` : '0');
    card.append(big);
    card.append(el('span', 'u', won ? (res.taken === 1 ? 'LINK' : 'LINKS') : 'LINKS'));
    const lines = el('div', 'ls');
    if (won && res.cleared) {
      lines.append(el('p', null, `You cleared all six ranks. ${res.taken} ${res.taken === 1 ? 'link' : 'links'} of Hoard left with you, and it is empty now.`));
      lines.append(el('p', null, 'It starts filling again tonight, one link for the day and one for every day the group lets go.'));
    } else if (won) {
      lines.append(el('p', null, `Out of the ${res.rank} rank with ${res.taken} ${res.taken === 1 ? 'link' : 'links'}.`));
      lines.append(el('p', null, `The Hoard holds ${res.hoard}. It was there for the taking, and some of it still is.`));
    } else {
      lines.append(el('p', null, `The ${res.rank} rank did not let you through. Nothing leaves with you.`));
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

  // escape always leaves; the run itself lives on the server either way
  const onKey = (e) => { if (e.key === 'Escape') finish(null); };
  document.addEventListener('keydown', onKey);
  timers.push(setTimeout(() => document.removeEventListener('keydown', onKey), 0) && 0);
  const cleanupKey = () => document.removeEventListener('keydown', onKey);
  overlay.addEventListener('transitionend', () => { if (ended) cleanupKey(); });
}
