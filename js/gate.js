// The Red Gate: the descent, as an event.
//
// The constitution allows at most two ambient motions per screen but leaves
// event motion free, so the Gate WINDOW in the Vault stays flat and still
// and all of this happens in a full-screen overlay that exists only while a
// hunter is inside. A key costs a day of training, so the thing it buys has
// to feel like it was worth the day.
//
// What makes it read as expensive, after looking at how Solo Leveling draws
// its gates and circles:
//   value range   every light has a white-hot core, a violet body and a wide
//                 dim bloom, instead of one flat mid-violet stroke
//   air           a light shaft with dust drifting in it, and atmospheric
//                 fade so the deep ranks sit behind real distance
//   density       the seal you stand on is a full arcane circle, rune band
//                 and spokes and all; the far ones are simplified, which
//                 also happens to be what keeps the frame cheap
//   weight        the fall has anticipation, travel and an impact that the
//                 whole scene answers: shockwave, dust, shake
//
// You stand on your own seal and its rim is the passages. Which of them are
// open was decided by the Worker at entry and is never sent here, so the
// choice is real and cannot be rerolled.
//
// Self-contained: DOM, one canvas and WebAudio. It knows nothing about the
// API; app.js hands it the callbacks and the state they return.

const ACCENT = '#8B7CFF';
const ACCENT_SOFT = '#CFC9FF';
const GOLD = '#E8B64A';
const BAD = '#E5484D';
const OK = '#4CC38A';
const GROUND = '#07070D';
const SPACING = 520;          // world units between seals
const FLOORS = 6;
const THRESHOLD = -SPACING;   // the mouth of the Gate, where a descent starts
const FALL = { walk: 340, reveal: 760, drop: 620 };
// the air warms as you go down: the Hoard's own light, bleeding up the shaft
const AIR_NEAR = [96, 66, 190];
const AIR_DEEP = [168, 104, 44];
const POOL_NEAR = [139, 124, 255];
const POOL_DEEP = [214, 168, 96];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => 1 - (1 - t) ** 3;
const easeIn = (t) => t * t * t;
const easeOut = (t) => 1 - (1 - t) ** 4;
const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------- sound ----------

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

const RANK_NOTES = [196.0, 233.08, 261.63, 311.13, 349.23, 415.30];

const snd = {
  open() {
    noise({ dur: 1.5, gain: 0.2, from: 90, to: 2600, type: 'bandpass', q: 0.55, attack: 0.72 });
    tone(43, { dur: 2.0, gain: 0.3, type: 'sine', to: 28 });
    tone(64.5, { dur: 2.0, gain: 0.1, type: 'sine', to: 43 });
    noise({ dur: 0.7, gain: 0.16, from: 4200, to: 400, type: 'bandpass', q: 0.8, delay: 0.95 });
    [261.63, 392.0, 523.25].forEach((f, i) => tone(f, { dur: 1.6, gain: 0.05, type: 'sine', delay: 1.0 + i * 0.09 }));
  },
  hover() { tone(1174.66, { dur: 0.06, gain: 0.02, type: 'sine' }); },
  step() {
    noise({ dur: 0.22, gain: 0.07, from: 700, to: 2200, type: 'bandpass', q: 1.2, attack: 0.6 });
    tone(196, { dur: 0.2, gain: 0.05, type: 'sine' });
  },
  drop() {
    noise({ dur: 0.62, gain: 0.13, from: 380, to: 2800, type: 'bandpass', q: 0.7, attack: 0.75 });
    tone(150, { dur: 0.6, gain: 0.1, type: 'sawtooth', to: 62 });
  },
  land(i) {
    tone(RANK_NOTES[i], { dur: 1.1, gain: 0.13 });
    tone(RANK_NOTES[i] * 1.5, { dur: 0.75, gain: 0.05, type: 'sine', delay: 0.02 });
    tone(RANK_NOTES[i] * 2, { dur: 0.5, gain: 0.03, type: 'sine', delay: 0.04 });
    tone(52, { dur: 0.55, gain: 0.26, type: 'sine', to: 30 });
    noise({ dur: 0.4, gain: 0.1, from: 1100, to: 140, type: 'lowpass', q: 0.8 });
  },
  fail() {
    noise({ dur: 0.24, gain: 0.34, from: 5600, to: 700, type: 'bandpass', q: 0.65 });
    noise({ dur: 1.8, gain: 0.2, from: 1400, to: 40, type: 'lowpass', q: 0.7, attack: 0.22 });
    tone(72, { dur: 1.5, gain: 0.3, type: 'sine', to: 22 });
    tone(76.5, { dur: 1.5, gain: 0.15, type: 'sine', to: 25 });
  },
  grab() {
    noise({ dur: 0.2, gain: 0.42, from: 2000, to: 160, type: 'lowpass', q: 1.4 });
    tone(58, { dur: 0.9, gain: 0.32, type: 'sawtooth', to: 28 });
    tone(41, { dur: 1.2, gain: 0.2, type: 'sine', to: 25 });
  },
  struggle(n) {
    noise({ dur: 0.07, gain: 0.12, from: 900 + n * 60, to: 300, type: 'bandpass', q: 1.6 });
    tone(150 + n * 14, { dur: 0.06, gain: 0.05, type: 'square' });
  },
  free() {
    noise({ dur: 0.4, gain: 0.17, from: 260, to: 3600, type: 'bandpass', q: 0.6, attack: 0.5 });
    tone(392, { dur: 0.6, gain: 0.1 });
    tone(587.33, { dur: 0.5, gain: 0.07, delay: 0.06 });
  },
  take(n) {
    for (let i = 0; i < Math.min(9, Math.max(1, n)); i++) tone(523.25 * (1 + i * 0.12), { dur: 0.32, gain: 0.05, type: 'sine', delay: i * 0.05 });
    tone(62, { dur: 0.6, gain: 0.16, type: 'sine', to: 40 });
  },
  clear() {
    [261.63, 329.63, 392.0, 523.25, 659.25, 783.99].forEach((f, i) => tone(f, { dur: 1.6, gain: 0.09, delay: i * 0.075 }));
    tone(41, { dur: 2.2, gain: 0.3, type: 'sine', to: 30 });
    noise({ dur: 1.9, gain: 0.13, from: 240, to: 4600, type: 'bandpass', q: 0.5, attack: 0.62 });
  },
};

// ---------- the shaft ----------

class Shaft {
  constructor(canvas, ranks, doors) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.ranks = ranks;
    this.doors = doors;
    this.standing = -1;       // the seal under your feet; -1 is the threshold
    this.cam = THRESHOLD;
    this.camTarget = THRESHOLD;
    this.markerY = THRESHOLD;
    this.markerR = 0;         // 0 at the seal's heart, 1 out at its rim
    this.markerA = -Math.PI / 2;
    this.spin = 0;
    this.hover = -1;
    this.chosen = -1;
    this.row = null;          // the rim revealed, once a rank has answered
    this.revealT = 0;
    this.broken = -1;
    this.breakT = 0;
    this.flash = 0;
    this.flashColor = '#FFFFFF';
    this.shake = 0;
    this.grip = 0;
    this.walk = null;
    this.fall = null;
    this.falling = 0;         // 0..1, eased, drives how hard the shaft streaks
    this.depth = 0;           // 0..1 down the ranks; the air warms with it
    this.scroll = 0;          // the walls running past, upward
    this.streaks = [];
    this.dust = [];
    this.shards = [];
    this.coins = [];
    this.waves = [];
    this.running = true;
    this.born = performance.now();
    this.last = this.born;
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    // A resize event is not the only way this canvas changes size: the pane
    // can be dragged, devtools can open, the DPR can change with the monitor.
    // Missing one left a stale box behind and drew the whole shaft off centre.
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this.onResize);
      this.ro.observe(this.c);
    }
    this.resize();
    for (let i = 0; i < 90; i++) this.dust.push(this.newMote(true));
    for (let i = 0; i < 26; i++) this.streaks.push(this.newStreak(true));
    requestAnimationFrame((t) => this.frame(t));
  }

  // Read off the clock, not accumulated per frame: a window behind another
  // window stops calling rAF, and the rift would stay shut with its passages
  // collapsed on one another and unclickable until it came back.
  get opening() { return clamp((performance.now() - this.born) / 1250, 0, 1); }

  // the walls of the shaft, seen out of the corner of the eye: streaks that
  // run upward past you, and run hard while you are falling
  newStreak(spread) {
    const side = Math.random() < 0.5 ? -1 : 1;
    return {
      side, x: rnd(0.06, 0.48), y: spread ? rnd(0, 1) : rnd(1.02, 1.3),
      len: rnd(0.04, 0.22), v: rnd(0.05, 0.16), a: rnd(0.05, 0.22), w: rnd(0.6, 2.4),
    };
  }

  newMote(spread) {
    return {
      x: rnd(-0.5, 0.5), y: spread ? rnd(0, 1) : 1.05,
      v: rnd(0.02, 0.08), s: rnd(0.6, 2.2), a: rnd(0.08, 0.5), w: rnd(0, 6.3), ws: rnd(0.3, 1.1),
    };
  }

  // The canvas is laid out by CSS (inset: 0 on the overlay), so its own box is
  // the truth. Writing style.width/height from window.innerWidth pinned it to
  // whatever the window was at the last resize event: one missed event and the
  // canvas stayed narrower than the viewport, anchored left, which drew the
  // shaft off centre with a bright seam where the stale box ended.
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.c.getBoundingClientRect();
    this.W = Math.max(1, Math.round(r.width || window.innerWidth));
    this.H = Math.max(1, Math.round(r.height || window.innerHeight));
    this.c.width = Math.round(this.W * dpr);
    this.c.height = Math.round(this.H * dpr);
    this.x.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  stop() {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    if (this.ro) this.ro.disconnect();
  }

  worldOf(i) { return i < 0 ? THRESHOLD : i * SPACING; }

  project(worldY) {
    const k = this.H / 800;
    const d = worldY - this.cam + 360;
    if (d < 130) return { y: -this.H, s: 0, d, off: true };
    return { y: this.H * 0.70 - (96000 * k) / d, s: (470 * k) / d, d, off: false };
  }

  sealGeom(i) {
    const p = this.project(this.worldOf(i));
    const o = ease(this.opening);
    return { ...p, rx: 250 * p.s * o, ry: 250 * p.s * o * 0.30 };
  }

  // Where each passage of your own seal sits on screen. Your seal holds
  // still: a target that spins away is not a target.
  doorPositions() {
    const i = this.standing;
    const g = this.sealGeom(i);
    if (g.off || !g.rx) return [];
    const out = [];
    for (let k = 0; k < this.doors; k++) {
      const a = (k / this.doors) * Math.PI * 2 - Math.PI / 2;
      out.push({ i: k, x: this.W / 2 + Math.cos(a) * g.rx, y: g.y + Math.sin(a) * g.ry, r: clamp(26 * g.s, 12, 30), a });
    }
    return out;
  }

  pick(px, py) {
    if (this.fall || this.row) return -1;
    let best = -1;
    let bd = 1e9;
    for (const p of this.doorPositions()) {
      const d = Math.hypot(px - p.x, py - p.y);
      if (d < Math.max(26, p.r * 1.8) && d < bd) { bd = d; best = p.i; }
    }
    return best;
  }

  // Walking out to the chosen passage. This runs while the Worker answers,
  // so the rank's rim can be revealed with the hunter already standing over
  // the mouth he picked, before anything drops.
  startWalk(doorAngle) {
    this.markerA = doorAngle;
    this.walk = { start: performance.now() };
  }

  // The drop itself, read off the clock and never accumulated per frame: a
  // window that stops being painted stops calling rAF, and a fall driven by
  // frames would hang half way with the descent waiting on it.
  startDrop(fromIdx, toIdx, onLand) {
    this.walk = null;
    // the rim you chose from is behind you now, and so is the choice: leaving
    // either of them set painted your old passage onto the new rank's rim
    this.row = null;
    this.chosen = -1;
    this.fall = { from: this.worldOf(fromIdx), to: this.worldOf(toIdx), start: performance.now(), onLand, landed: false };
    setTimeout(() => this.finishFall(), FALL.drop + 40); // backstop, if no frame ever runs
  }

  finishFall() {
    const f = this.fall;
    if (!f || f.landed) return;
    f.landed = true;
    this.markerY = f.to;
    this.markerR = 0;
    this.cam = this.camTarget = f.to;
    this.fall = null;
    if (f.onLand) f.onLand();
  }

  cancelMove() {
    this.walk = null;
    this.fall = null;
    this.markerR = 0;
  }

  burst(worldY, color, n = 40, speed = 380, spread = 60) {
    const { y } = this.project(worldY);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(speed * 0.3, speed);
      this.shards.push({
        x: this.W / 2 + Math.cos(a) * rnd(0, spread), y: y + Math.sin(a) * rnd(0, spread * 0.3),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.45 - rnd(40, 220),
        rot: rnd(0, 6.3), vr: rnd(-9, 9), size: rnd(3, 11), life: rnd(0.6, 1.5), t: 0, c: color,
      });
    }
  }

  wave(worldY, color, max = 520, dur = 0.85) {
    this.waves.push({ worldY, color, t: 0, dur, max });
  }

  pour(worldY, n) {
    const { y } = this.project(worldY);
    for (let i = 0; i < Math.min(180, 16 + n * 6); i++) {
      this.coins.push({
        x: this.W / 2 + rnd(-110, 110), y: y + rnd(-24, 24),
        vx: rnd(-100, 100), vy: rnd(-560, -240), rot: rnd(0, 6.3), vr: rnd(-7, 7),
        life: rnd(1.1, 2.1), t: 0, delay: rnd(0, 0.55),
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

  update(dt, now) {
    this.spin += dt * 0.22;
    if (this.broken >= 0) this.breakT += dt;
    if (this.row) this.revealT += dt;
    this.flash *= Math.exp(-dt * 4.4);
    this.shake *= Math.exp(-dt * 3.2);

    // walking out to the mouth, then standing over it
    if (this.walk) {
      const ms = performance.now() - this.walk.start;
      this.markerR = ms < FALL.walk ? easeOut(ms / FALL.walk) : 1 + Math.sin(ms / 1000 * 9) * 0.025;
    }
    // the drop, read off the clock
    let dropping = false;
    if (this.fall) {
      const f = this.fall;
      const ms = performance.now() - f.start;
      if (ms < FALL.drop) {
        dropping = true;
        const k = clamp(ms / FALL.drop, 0, 1);
        const e = easeIn(k);
        this.markerY = f.from + (f.to - f.from) * e;
        this.markerR = 1 - e;
        this.camTarget = f.from + (f.to - f.from) * clamp(k * 1.15, 0, 1);
      } else {
        this.finishFall();
      }
    }
    this.falling += ((dropping ? 1 : 0) - this.falling) * Math.min(1, dt * 6);
    const chase = dropping ? 9 : 4;
    this.cam += (this.camTarget - this.cam) * Math.min(1, dt * chase);

    const rush = 1 + this.falling * 7;
    this.scroll += dt * (0.1 + this.falling * 1.4);
    for (const m of this.dust) {
      m.y -= m.v * dt * rush;
      m.w += m.ws * dt;
      if (m.y < -0.06) Object.assign(m, this.newMote(false));
    }
    for (const st of this.streaks) {
      st.y -= st.v * dt * rush;
      if (st.y + st.len < -0.05) Object.assign(st, this.newStreak(false));
    }
    for (const w of this.waves) w.t += dt;
    this.waves = this.waves.filter((w) => w.t < w.dur);
    for (const s of this.shards) { s.t += dt; s.vy += 640 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt; }
    this.shards = this.shards.filter((s) => s.t < s.life);
    for (const c of this.coins) {
      if (c.delay > 0) { c.delay -= dt; continue; }
      c.t += dt; c.vy += 300 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
    }
    this.coins = this.coins.filter((c) => c.t < c.life);
  }

  // How much of the ground sits between the camera and a thing. Heavy on
  // purpose: six seals under a perspective divide always clump into a knot
  // at the vanishing point, so the shaft shows the seal you are on, the one
  // below it, a ghost of the next, and then darkness. How deep you actually
  // are is the HUD's job, and the dark is worth more than the knot.
  fogAt(d) { return clamp((d - 430) / 1150, 0, 1); }

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

  draw(now) {
    const { x, W, H } = this;
    const o = ease(this.opening);
    x.clearRect(0, 0, W, H);
    x.save();
    if (this.shake > 0.2) x.translate(rnd(-this.shake, this.shake), rnd(-this.shake, this.shake));

    this.drawShaftLight(now, o);
    this.drawWalls(o);

    // seals far to near, so the near ones sit on top
    const order = [];
    for (let i = -1; i < FLOORS; i++) order.push(i);
    order.sort((a, b) => this.project(this.worldOf(b)).d - this.project(this.worldOf(a)).d);
    for (const i of order) this.drawSeal(i, now, o);

    for (const w of this.waves) this.drawWave(w);
    this.drawMarker(now, o);
    this.drawDust(o);
    this.drawDebris();

    x.restore();

    if (this.grip > 0.01) {
      const g = x.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.1, W / 2, H * 0.45, Math.max(W, H) * 0.6);
      g.addColorStop(0, 'rgba(90,10,18,0)');
      g.addColorStop(1, `rgba(128,12,22,${0.88 * this.grip})`);
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

  air() { return mix(AIR_NEAR, AIR_DEEP, this.depth); }
  poolRgb() { return mix(POOL_NEAR, POOL_DEEP, this.depth); }

  // What is below, glowing up at you. Anchored to the vanishing point, not
  // to the seal under your feet: anchoring it to the seal made the whole
  // thing slide upward as the camera dropped, which read as the floor
  // rising rather than as you falling. Soft-edged for the same reason a
  // hard trapezoid read as a floor.
  drawShaftLight(now, o) {
    const { x, W, H } = this;
    const air = this.air();
    const vp = H * 0.70;
    const g = x.createRadialGradient(W / 2, vp + H * 0.16, 0, W / 2, vp + H * 0.16, Math.max(W, H) * 0.72);
    g.addColorStop(0, rgba(air, 0.30 * o));
    g.addColorStop(0.32, rgba(air, 0.13 * o));
    g.addColorStop(0.7, rgba(air, 0.035 * o));
    g.addColorStop(1, rgba(air, 0));
    x.save();
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    x.restore();
  }

  // the wall streaks, out at the edges where they belong
  drawWalls(o) {
    const { x, W, H } = this;
    const air = this.air();
    x.save();
    x.lineCap = 'round';
    for (const st of this.streaks) {
      const px = W / 2 + st.side * (0.5 + st.x) * W * 0.62;
      const y0 = st.y * H;
      const y1 = (st.y + st.len) * H;
      x.globalAlpha = st.a * o * (0.5 + this.falling * 0.9);
      x.strokeStyle = rgba(air, 1);
      x.lineWidth = st.w * (1 + this.falling * 1.6);
      x.beginPath();
      x.moveTo(px, y1);
      x.lineTo(px, y0);
      x.stroke();
    }
    // the rings of the wall passing upward, faint, to sell the direction
    x.globalAlpha = (0.05 + this.falling * 0.14) * o;
    x.strokeStyle = rgba(air, 1);
    x.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const f = ((this.scroll + i / 7) % 1);
      const y = H * (1.05 - f * 1.2);
      const spread = 0.2 + (y / H) * 0.85;
      x.beginPath();
      x.moveTo(W / 2 - W * spread, y);
      x.quadraticCurveTo(W / 2, y - H * 0.05 * spread, W / 2 + W * spread, y);
      x.stroke();
    }
    x.restore();
    x.globalAlpha = 1;
  }

  drawDust(o) {
    const { x, W, H } = this;
    for (const m of this.dust) {
      const y = m.y * H;
      const spread = 0.10 + (y / H) * 0.5;
      const px = W / 2 + (m.x * 2) * spread * W + Math.sin(m.w) * 14;
      x.globalAlpha = m.a * o * (0.35 + (y / H) * 0.65);
      x.fillStyle = m.s > 1.6 ? '#FFFFFF' : rgba(this.poolRgb(), 1);
      x.beginPath();
      x.arc(px, y, m.s * 0.7, 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = 1;
  }

  drawWave(w) {
    const { x, W } = this;
    const p = this.project(w.worldY);
    if (p.off) return;
    const k = w.t / w.dur;
    const r = w.max * p.s * easeOut(k);
    x.save();
    x.translate(W / 2, p.y);
    x.scale(1, 0.30);
    x.globalAlpha = (1 - k) * 0.9;
    x.strokeStyle = w.color;
    x.shadowColor = w.color;
    x.shadowBlur = 24;
    x.lineWidth = 2.5 * (1 - k * 0.6);
    x.beginPath();
    x.arc(0, 0, r, 0, Math.PI * 2);
    x.stroke();
    x.restore();
    x.globalAlpha = 1;
  }

  // One rank's seal. The one under your feet gets the whole arcane circle;
  // the ones below get less of it the further they are, which is both how
  // distance reads and how the frame stays cheap.
  drawSeal(i, now, o) {
    const { x, W } = this;
    const g = this.sealGeom(i);
    if (g.off || g.y < -340 || g.y > this.H + 420 || g.rx < 2) return;
    const { y, s, rx, ry, d } = g;
    const here = i === this.standing;
    const passed = i >= 0 && i < this.standing;
    // -1 is the threshold, and `broken` starts at -1 for "nothing is broken":
    // without the guard the threshold was drawn as a failed rank, which is why
    // the shaft opened red instead of violet every single time
    const isBroken = i >= 0 && i === this.broken;
    const fog = this.fogAt(d);
    const alpha = (1 - fog) * o;
    if (alpha < 0.02) return;
    const brk = isBroken ? clamp(this.breakT / 0.6, 0, 1) : 0;
    const live = here || passed || isBroken;
    const color = isBroken ? BAD : live ? ACCENT : '#6E7A93';
    const bright = isBroken ? '#FF9E9E' : live ? ACCENT_SOFT : '#9AA6BC';
    const spin = here ? 0 : this.spin * (passed ? 0.5 : 0.28) + i * 0.9;

    x.save();
    x.translate(W / 2, y);
    x.globalAlpha = alpha * (1 - brk * 0.7);

    // the pool of light the seal lies in
    if (live) {
      const pool = x.createRadialGradient(0, 0, 0, 0, 0, rx * 1.5);
      const rgb = isBroken ? [229, 72, 77] : this.poolRgb();
      pool.addColorStop(0, rgba(rgb, (here ? 0.3 : 0.12) * (1 - brk)));
      pool.addColorStop(0.55, rgba(rgb, (here ? 0.10 : 0.04) * (1 - brk)));
      pool.addColorStop(1, rgba(rgb, 0));
      x.save();
      x.scale(1, 0.32);
      x.fillStyle = pool;
      x.beginPath();
      x.arc(0, 0, rx * 1.5, 0, Math.PI * 2);
      x.fill();
      x.restore();
    }

    x.save();
    x.scale(1, 0.30);
    x.rotate(spin);
    const R = rx * (1 + brk * 0.3);
    const ring = (r) => () => { x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); };

    // outer rim: bloom, body, hot core
    this.glowStroke(ring(R), color, 9 * s, 30 * s, 0.16 * alpha);
    this.glowStroke(ring(R), color, 2.4 * s, 14 * s, 0.85 * alpha);
    if (live) this.glowStroke(ring(R), bright, 0.9 * s, 6 * s, 0.9 * alpha);

    // the rune band: short ticks, every fifth one long
    if (s > 0.28) {
      const ticks = 60;
      x.save();
      x.strokeStyle = color;
      x.shadowColor = color;
      x.shadowBlur = 8 * s;
      x.globalAlpha = alpha * (live ? 0.75 : 0.35) * (1 - brk);
      for (let k = 0; k < ticks; k++) {
        const a = (k / ticks) * Math.PI * 2;
        const long = k % 5 === 0;
        const len = (long ? 26 : 12) * s;
        x.lineWidth = (long ? 1.8 : 0.9) * s;
        x.beginPath();
        x.moveTo(Math.cos(a) * (R - len), Math.sin(a) * (R - len));
        x.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        x.stroke();
      }
      x.restore();
    }

    // inner rings, counter-turning
    x.save();
    x.rotate(-spin * 2.3);
    this.glowStroke(ring(R * 0.70), color, 1.4 * s, 10 * s, 0.5 * alpha);
    if (s > 0.35) {
      x.setLineDash([R * 0.16, R * 0.1]);
      this.glowStroke(ring(R * 0.55), color, 1.2 * s, 8 * s, 0.45 * alpha);
      x.setLineDash([]);
    }
    x.restore();

    // spokes out to every passage, so the rim reads as a mechanism
    if (here && s > 0.3) {
      x.save();
      x.strokeStyle = color;
      x.shadowColor = color;
      x.shadowBlur = 10 * s;
      x.globalAlpha = alpha * 0.4;
      x.lineWidth = 1 * s;
      for (let k = 0; k < this.doors; k++) {
        const a = (k / this.doors) * Math.PI * 2 - Math.PI / 2;
        x.beginPath();
        x.moveTo(Math.cos(a) * R * 0.70, Math.sin(a) * R * 0.70);
        x.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        x.stroke();
      }
      x.restore();
    }

    // the heart: the site's diamond, breathing
    const puls = here ? 1 + Math.sin(now / 520) * 0.04 : 1;
    const dm = R * 0.26 * puls;
    const diamond = () => { x.beginPath(); x.moveTo(0, -dm); x.lineTo(dm, 0); x.lineTo(0, dm); x.lineTo(-dm, 0); x.closePath(); };
    this.glowStroke(diamond, color, 6 * s, 22 * s, 0.2 * alpha);
    this.glowStroke(diamond, bright, 1.3 * s, 10 * s, (live ? 0.85 : 0.4) * alpha);
    x.restore();
    x.restore();

    if (here || this.row) this.drawDoors(i, now, o, alpha);

    // the rank's letter, upright beside its seal
    x.save();
    x.globalAlpha = (live ? 0.95 : 0.5) * (1 - brk) * alpha;
    x.fillStyle = isBroken ? BAD : live ? ACCENT_SOFT : '#8592A8';
    x.shadowColor = isBroken ? BAD : ACCENT;
    x.shadowBlur = here ? 18 : 8;
    x.font = `700 ${Math.round(clamp(34 * s, 11, 40))}px Rajdhani, sans-serif`;
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    x.fillText(i < 0 ? '' : this.ranks[i], W / 2 + rx + 18 * clamp(s, 0.4, 1), y);
    x.restore();
  }

  drawDoors(i, now, o, alpha) {
    if (i !== this.standing) return;
    const { x } = this;
    const revealed = this.row !== null;
    const reveal = revealed ? clamp(this.revealT / 0.5, 0, 1) : 0;
    for (const p of this.doorPositions()) {
      const open = revealed ? !!this.row[p.i] : null;
      const isChosen = p.i === this.chosen;
      const hot = !revealed && p.i === this.hover;
      const color = revealed ? (open ? OK : BAD) : hot ? '#FFFFFF' : ACCENT_SOFT;
      const a = (revealed ? 0.3 + reveal * 0.7 : hot ? 1 : 0.7) * alpha;
      const r = p.r * (hot ? 1.22 : 1) * (isChosen ? 1.3 : 1);
      x.save();
      x.translate(p.x, p.y);
      x.globalAlpha = a;

      // the mouth: a dark arch with light spilling out of its threshold
      const arch = () => {
        x.beginPath();
        x.moveTo(-r * 0.46, r * 0.36);
        x.lineTo(-r * 0.46, -r * 0.12);
        x.quadraticCurveTo(0, -r * 0.74, r * 0.46, -r * 0.12);
        x.lineTo(r * 0.46, r * 0.36);
        x.closePath();
      };
      const fill = x.createLinearGradient(0, -r * 0.7, 0, r * 0.36);
      if (revealed && open) { fill.addColorStop(0, 'rgba(76,195,138,0.45)'); fill.addColorStop(1, 'rgba(76,195,138,0.06)'); }
      else if (revealed) { fill.addColorStop(0, 'rgba(229,72,77,0.42)'); fill.addColorStop(1, 'rgba(229,72,77,0.05)'); }
      else if (hot) { fill.addColorStop(0, 'rgba(226,222,255,0.62)'); fill.addColorStop(1, 'rgba(139,124,255,0.1)'); }
      else { fill.addColorStop(0, 'rgba(139,124,255,0.3)'); fill.addColorStop(1, 'rgba(139,124,255,0.03)'); }
      arch();
      x.fillStyle = fill;
      x.fill();
      this.glowStroke(arch, color, hot ? 2.2 : 1.3, hot ? 22 : 10, a);

      // the sill: a bright line the light pours over
      x.save();
      x.strokeStyle = color;
      x.shadowColor = color;
      x.shadowBlur = hot ? 20 : 9;
      x.lineWidth = hot ? 2.4 : 1.4;
      x.beginPath();
      x.moveTo(-r * 0.5, r * 0.36);
      x.lineTo(r * 0.5, r * 0.36);
      x.stroke();
      x.restore();

      if (revealed && !open) {
        x.save();
        x.strokeStyle = BAD;
        x.shadowColor = BAD;
        x.shadowBlur = 14;
        x.lineWidth = 2.2;
        x.beginPath();
        x.moveTo(-r * 0.3, -r * 0.2); x.lineTo(r * 0.3, r * 0.26);
        x.moveTo(r * 0.3, -r * 0.2); x.lineTo(-r * 0.3, r * 0.26);
        x.stroke();
        x.restore();
      }
      if (isChosen) {
        x.save();
        x.strokeStyle = '#FFFFFF';
        x.shadowColor = '#FFFFFF';
        x.shadowBlur = 16;
        x.lineWidth = 1.5;
        x.beginPath();
        x.arc(0, 0, r * 1.2, 0, Math.PI * 2);
        x.stroke();
        x.restore();
      }
      x.restore();
    }
  }

  drawMarker(now, o) {
    const { x, W } = this;
    const p = this.project(this.markerY);
    if (p.off) return;
    const g = this.sealGeom(this.standing);
    const a = this.markerA;
    // out along the rim when walking to a passage, back to the heart on landing
    const px = W / 2 + Math.cos(a) * (g.rx || 0) * this.markerR;
    const py = p.y + Math.sin(a) * (g.ry || 0) * this.markerR;
    const r = clamp(17 * p.s, 7, 26);

    // the trail, while falling
    if (this.fall) {
      const t = x.createLinearGradient(px, py - r * 7, px, py);
      t.addColorStop(0, 'rgba(207,201,255,0)');
      t.addColorStop(1, 'rgba(226,222,255,0.6)');
      x.save();
      x.globalAlpha = o;
      x.fillStyle = t;
      x.beginPath();
      x.moveTo(px - r * 0.5, py);
      x.lineTo(px + r * 0.5, py);
      x.lineTo(px + r * 0.12, py - r * 7);
      x.lineTo(px - r * 0.12, py - r * 7);
      x.closePath();
      x.fill();
      x.restore();
    }

    x.save();
    x.translate(px, py);
    x.globalAlpha = o;
    const halo = x.createRadialGradient(0, 0, 0, 0, 0, r * 5);
    halo.addColorStop(0, 'rgba(226,222,255,0.55)');
    halo.addColorStop(0.35, 'rgba(139,124,255,0.22)');
    halo.addColorStop(1, 'rgba(139,124,255,0)');
    x.fillStyle = halo;
    x.beginPath();
    x.arc(0, 0, r * 5, 0, Math.PI * 2);
    x.fill();
    x.rotate(now / 1100);
    x.shadowColor = ACCENT_SOFT;
    x.shadowBlur = 26;
    x.fillStyle = '#FFFFFF';
    x.beginPath();
    x.moveTo(0, -r); x.lineTo(r * 0.7, 0); x.lineTo(0, r); x.lineTo(-r * 0.7, 0); x.closePath();
    x.fill();
    x.restore();
  }

  drawDebris() {
    const { x } = this;
    for (const s of this.shards) {
      const k = 1 - s.t / s.life;
      x.save();
      x.translate(s.x, s.y);
      x.rotate(s.rot);
      x.globalAlpha = Math.min(1, k * 1.7);
      x.fillStyle = s.c;
      x.shadowColor = s.c;
      x.shadowBlur = 10;
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
      x.shadowColor = GOLD;
      x.shadowBlur = 12;
      x.lineWidth = 1.5;
      x.beginPath();
      x.moveTo(0, -6); x.lineTo(4.5, 0); x.lineTo(0, 6); x.lineTo(-4.5, 0); x.closePath();
      x.stroke();
      x.restore();
    }
    x.globalAlpha = 1;
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

  // the depth gauge: the shaft goes dark below the next rank, so how far
  // down you are is read here instead
  const ladder = el('div', 'rg-ladder');
  const rungs = ranks.map((r, i) => {
    const row = el('div', 'rg-rung');
    row.append(el('span', 'r', r), el('span', 'c', String(gate.claim[i])), el('i'));
    ladder.append(row);
    return row;
  });
  const paintLadder = () => rungs.forEach((row, i) => {
    row.classList.toggle('done', i < floor);
    row.classList.toggle('now', i === floor - 1);
    row.classList.toggle('next', i === floor);
    row.querySelector('.c').textContent = i === ranks.length - 1 ? String(hoardNow) : String(Math.min(gate.claim[i], hoardNow));
  });

  const mid = el('div', 'rg-mid');
  const rankLine = el('div', 'rg-rank', 'THE THRESHOLD');
  const holdWrap = el('div', 'rg-hold');
  holdWrap.append(el('span', 'l', 'HOLDING'));
  const holdVal = el('span', 'v', '0');
  holdWrap.append(holdVal);
  mid.append(rankLine, holdWrap);

  const say = el('div', 'rg-say');
  const bar = el('div', 'rg-bar');
  const slam = el('div', 'rg-slam', 'THE RED GATE');
  hud.append(top, ladder, mid, say, bar);
  overlay.append(canvas, el('div', 'rg-side l'), el('div', 'rg-side r'), veil, hud, slam);
  document.body.append(overlay);

  const timers = [];
  let ended = false;
  let busy = true;
  let grabbedOnce = false; // the grasp is a jumpscare, so it happens once at most
  let floor = gate.run ? gate.run.floor : 0;
  let holding = gate.run ? gate.run.holding : 0;
  let hoardNow = gate.hoard;
  const later = (fn, ms) => { const t = setTimeout(() => { if (!ended) fn(); }, ms); timers.push(t); return t; };
  const shaft = reduced() ? null : new Shaft(canvas, ranks, DOORS);
  overlay.__scene = shaft;

  const finish = (result) => {
    if (ended) return;
    ended = true;
    timers.forEach(clearTimeout);
    if (shaft) shaft.stop();
    document.removeEventListener('keydown', onKey);
    overlay.classList.add('out');
    setTimeout(() => { overlay.remove(); if (opts.onEnd) opts.onEnd(result); }, 460);
  };

  const setSay = (text, kind) => { say.textContent = text; say.className = 'rg-say' + (kind ? ' ' + kind : ''); };
  const setHolding = (n) => {
    holding = n;
    holdVal.textContent = String(n);
    holdVal.classList.remove('tick');
    void holdVal.offsetWidth;
    holdVal.classList.add('tick');
  };
  const setHoard = (n) => { hoardNow = n; hoard.querySelector('.v').textContent = String(n); paintLadder(); };

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
    if (shaft) {
      shaft.standing = floor - 1;
      shaft.row = null;
      shaft.chosen = -1;
      shaft.hover = -1;
      shaft.depth = clamp(floor / FLOORS, 0, 1);
      overlay.style.setProperty('--rg-depth', String(shaft.depth));
    }
    paintLadder();
    if (floor >= FLOORS) {
      rankLine.textContent = 'S RANK';
      setSay('Nothing is below you but the Hoard.', 'gold');
      return;
    }
    const chance = Math.round(gate.survive[floor] * 100);
    const open = Math.round(gate.survive[floor] * DOORS);
    const claim = Math.min(gate.claim[floor], hoardNow);
    rankLine.textContent = floor === 0 ? 'THE THRESHOLD' : `${ranks[floor - 1]} RANK`;
    setSay(`${DOORS} passages lead down to the ${ranks[floor]} rank. ${open} of them are open. ${floor + 1 === FLOORS ? 'Beyond is the Hoard.' : `Beyond is ${claim}.`}`);
  };

  // ---- the opening ----
  const resumed = floor > 0;
  if (shaft) {
    shaft.standing = floor - 1;
    shaft.cam = shaft.camTarget = shaft.worldOf(floor - 1);
    shaft.markerY = shaft.worldOf(floor - 1);
    shaft.flash = 0.55;
    shaft.flashColor = '#3A1440';
    shaft.wave(shaft.worldOf(floor - 1), ACCENT_SOFT, 900, 1.5);
    snd.open();
  }
  if (resumed) setHolding(holding);
  setSay(resumed ? `You are still inside, ${ranks[floor - 1]} rank, holding ${holding}.` : 'The seal gives. The shaft opens under you.');
  overlay.classList.add('on');
  later(() => slam.classList.add('go'), 220);
  later(() => slam.remove(), 2400);
  later(() => { busy = false; renderBar(); promptDoors(); }, reduced() ? 60 : 1500);

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
    const angle = (door / DOORS) * Math.PI * 2 - Math.PI / 2;
    if (shaft) { shaft.chosen = door; shaft.hover = -1; }
    setSay('You step into it.');
    snd.step();

    // you walk out to the mouth you picked while the Worker answers
    if (shaft) shaft.startWalk(angle);
    let res;
    try {
      res = await opts.descend(door, target);
    } catch (e) {
      busy = false;
      if (shaft) { shaft.chosen = -1; shaft.cancelMove(); }
      setSay(e && e.message ? e.message : 'The System refused.', 'err');
      renderBar();
      return;
    }
    if (ended) return;
    if (res && res.hoard !== undefined) setHoard(res.hoard);

    // the rim answers while you are still standing over it: open in green,
    // blocked in red, yours ringed. This is the beat, and it belongs here
    // rather than after the drop, where it was being painted onto the next
    // rank's seal and reading as nonsense.
    if (shaft) { shaft.row = res.row; shaft.revealT = 0; }
    rankLine.textContent = `${ranks[target]} RANK`;
    setSay(res.dead ? 'Blocked.' : 'Open.', res.dead ? 'err' : null);
    await new Promise((r) => later(r, reduced() ? 0 : FALL.reveal));
    if (ended) return;

    if (res.dead) {
      if (shaft) {
        shaft.cancelMove();
        shaft.broken = target;
        shaft.breakT = 0;
        shaft.flash = 0.85;
        shaft.flashColor = BAD;
        shaft.shake = 22;
        shaft.wave(shaft.worldOf(target - 1), BAD, 1200, 1.2);
        shaft.burst(shaft.worldOf(target - 1), BAD, 80, 620, 110);
        shaft.camTarget = shaft.worldOf(target - 1) - SPACING * 0.45;
      }
      snd.fail();
      setSay(`The ${ranks[target]} rank keeps what you were holding.`, 'err');
      holdWrap.classList.add('lost');
      setHolding(0);
      later(() => verdict(false, res), reduced() ? 400 : 1900);
      return;
    }

    // through it
    snd.drop();
    floor = res.run ? res.run.floor : floor + 1;
    if (shaft) {
      shaft.depth = clamp(floor / FLOORS, 0, 1);
      overlay.style.setProperty('--rg-depth', String(shaft.depth));
      await new Promise((r) => {
        if (reduced()) return r();
        shaft.startDrop(floor - 1 - 1, floor - 1, r);
      });
      if (ended) return;
      shaft.standing = floor - 1;
      shaft.flash = 0.22;
      shaft.flashColor = ACCENT_SOFT;
      shaft.shake = 11;
      shaft.wave(shaft.worldOf(floor - 1), ACCENT_SOFT, 800, 0.9);
      shaft.burst(shaft.worldOf(floor - 1), ACCENT_SOFT, 38, 320, 90);
    }
    snd.land(floor - 1);
    setHolding(res.run ? res.run.holding : holding);
    rankLine.textContent = `${ranks[floor - 1]} RANK CLEARED`;
    setSay(`Holding ${holding}.`);

    // The grasp only works while it is still a shock. Once per descent at
    // most, and only past the D rank, so it lands about one descent in five
    // instead of most landings, where it turned from a fright into a chore.
    const grabbed = !reduced() && !grabbedOnce && floor >= 3 && floor < FLOORS && Math.random() < 0.22;
    if (grabbed) grabbedOnce = true;
    later(() => {
      if (grabbed) startGrasp();
      else { busy = false; promptDoors(); renderBar(); }
    }, reduced() ? 40 : 1050);
  }

  // ---- the grasp ----
  function startGrasp() {
    // five clicks, not fourteen: the point is the half second of panic, and a
    // long bar turns that into typing
    const NEED = 5;
    const MS = 2800;
    let hits = 0;
    const panel = el('div', 'rg-grasp');
    const track = el('div', 'g-track');
    const fill = el('i');
    track.append(fill);
    panel.append(el('div', 'g-ttl', 'SOMETHING HAS YOU'), el('div', 'g-sub', 'CLICK TO BREAK LOOSE'), track);
    overlay.append(panel);
    hud.classList.add('dim');
    snd.grab();
    if (shaft) { shaft.shake = 18; shaft.flash = 0.35; shaft.flashColor = BAD; }

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
      if (shaft) { shaft.shake = 7 + hits * 0.4; }
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
        if (shaft) { shaft.flash = 0.3; shaft.flashColor = ACCENT_SOFT; shaft.shake = 10; }
        setSay('Loose. It did not get to keep you.');
        busy = false;
        promptDoors();
        renderBar();
      } else {
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
      shaft.pour(shaft.worldOf(floor - 1), res.taken);
      shaft.wave(shaft.worldOf(floor - 1), GOLD, res.cleared ? 1400 : 820, 1.2);
      shaft.flash = res.cleared ? 0.6 : 0.22;
      shaft.flashColor = GOLD;
      shaft.shake = res.cleared ? 16 : 6;
      shaft.camTarget = THRESHOLD - SPACING * 1.4;
    }
    if (res.cleared) snd.clear(); else snd.take(res.taken);
    setHolding(res.taken);
    later(() => verdict(true, res), reduced() ? 300 : 1700);
  }

  // ---- the verdict ----
  function verdict(won, res) {
    if (ended) return;
    hud.classList.add('gone');
    const card = el('div', 'rg-card' + (won ? ' win' : ' loss'));
    card.append(el('span', 'k', won ? '[ THE GATE RELEASES YOU ]' : '[ THE GATE CLOSES ]'));

    // The number is the only thing on this card anybody reads, and it is what
    // a whole day of training bought, so it gets a struck plate of its own:
    // milled rules either side, a metal face, one pass of light across it,
    // and digits that climb to the figure instead of simply appearing.
    const took = won ? res.taken : 0;
    const prize = el('div', 'rg-prize');
    const num = el('div', 'rg-n');
    const digits = el('span', 'd', '0');
    num.append(el('span', 'sign', won && took > 0 ? '+' : ''), digits);
    prize.append(el('i', 'rule l'), num, el('i', 'rule r'));
    card.append(prize);
    card.append(el('span', 'u', took === 1 ? 'LINK' : 'LINKS'));
    countTo(digits, took);

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
    // This closes the shaft and puts you back in front of the Gate; it does
    // not spend anything, so it must not read like a second descent.
    const done = el('button', 'rg-btn out');
    done.type = 'button';
    done.append(el('span', 't', 'CONTINUE'));
    if (res.keys !== undefined) {
      done.append(el('span', 's', res.keys
        ? `${res.keys} ${res.keys === 1 ? 'KEY' : 'KEYS'} STILL IN HAND`
        : 'NO KEYS IN HAND'));
    }
    done.addEventListener('click', () => finish(res));
    card.append(done);
    overlay.append(card);
    later(() => finish(res), 22000);
  }

  // The digits roll up to the figure. A number that appears reads like a
  // receipt; a number that climbs reads like a payout being counted out.
  function countTo(node, n) {
    if (reduced() || n <= 0) { node.textContent = String(n); return; }
    const dur = clamp(380 + n * 24, 480, 1200);
    const t0 = performance.now();
    const step = () => {
      if (ended || !node.isConnected) return;
      const k = clamp((performance.now() - t0) / dur, 0, 1);
      node.textContent = String(Math.round(n * easeOut(k)));
      if (k < 1) requestAnimationFrame(step);
    };
    node.textContent = '0';
    requestAnimationFrame(step);
  }

  const onKey = (e) => { if (e.key === 'Escape') finish(null); };
  document.addEventListener('keydown', onKey);
}
