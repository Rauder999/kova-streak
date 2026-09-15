// The 100% ceremony (per Rauder, 2026-09-15, replacing the KovaaK's shooting
// gallery): five mana cores materialize over the page. Every core you break
// shakes the screen and cracks the glass a little more; the fifth shatters
// it and the whole page is pulled into a black hole. Out of the dark comes
// the System's verdict: 100%.
//
// Self-contained: DOM, one canvas and WebAudio, nothing here touches app
// state. app.js decides WHEN (once per closed day, tab visible) and hands
// over the numbers for the verdict window. Two samples are real KovaaK's
// sounds from Pasha's folder: rxSound11 (the hit) and kick-deep (the break,
// higher with every core); a core's arrival, the cracks, the collapse and
// the verdict chord are synthesized, so nothing depends on the files
// loading in time.

const ACCENT = '#8B7CFF';
const ACCENT_SOFT = '#CFC9FF';
const CYAN = '#4FC3FF';
const CORES = 5;
const PULL_MS = 1500; // how long the page takes to fall into the hole (per Rauder: 1.5 s)

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------- sound ----------

const KILL_RATES = [1, 1.19, 1.41, 1.68, 2.0];    // +3 semitones per core
const SPAWN_RATES = [1, 1.12, 1.26, 1.41, 1.59];  // +2 semitones per core
const HIT_NOTES = [392.0, 440.0, 493.88, 587.33, 659.25]; // fallback: G4 A4 B4 D5 E5
const FINAL_CHORD = [523.25, 659.25, 783.99, 1046.5];     // C E G C

let actx = null;
function ensureCtx() {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function tone(freq, dur = 0.22, gainV = 0.16, type = 'triangle', delay = 0) {
  try {
    const ctx = ensureCtx();
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gainV, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch { /* sound is optional */ }
}

let sndBuffers = null; // null = not loaded yet, false = failed, object = ready
async function loadSounds() {
  if (sndBuffers !== null) return;
  try {
    const ctx = ensureCtx();
    const load = async (url) => ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const [shot, kill] = await Promise.all(['assets/shot-rx11.ogg', 'assets/kill-kick.ogg'].map(load));
    sndBuffers = { shot, kill };
  } catch {
    sndBuffers = false;
  }
}

function playBuf(name, rate = 1, gain = 0.5) {
  if (!sndBuffers || !sndBuffers[name]) return false;
  try {
    const ctx = ensureCtx();
    const s = ctx.createBufferSource();
    s.buffer = sndBuffers[name];
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    s.connect(g).connect(ctx.destination);
    s.start();
    return true;
  } catch {
    return false;
  }
}

// a gain envelope: straight up over `attack` of the length, then a decay to nothing
function envelope(ctx, g, t, dur, gain, attack) {
  if (attack > 0) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * attack);
  } else {
    g.gain.setValueAtTime(gain, t);
  }
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
}

// filtered noise: a core's whoosh, glass giving way, the wind of the collapse
let noiseBuf = null;
function crackle({ dur = 0.14, gain = 0.2, from = 2200, to = 600, type = 'bandpass', q = 1.4, delay = 0, attack = 0 } = {}) {
  try {
    const ctx = ensureCtx();
    if (!noiseBuf) {
      const len = ctx.sampleRate * 2;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = ctx.createGain();
    envelope(ctx, g, t, dur, gain, attack);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t);
    src.stop(t + dur + 0.05);
  } catch { /* sound is optional */ }
}

// a sine sliding in pitch: the floor shaking under a core, the subs of the collapse
function thud(from = 90, to = 36, dur = 0.28, gain = 0.32, delay = 0, attack = 0) {
  try {
    const ctx = ensureCtx();
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    envelope(ctx, g, t, dur, gain, attack);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch { /* sound is optional */ }
}

// a core arrives: a whoosh sweeping up that snaps shut as it lands, and a
// glassy ping on top, a little higher with every core (the 808 sample it
// replaced sounded like a drum machine, per Rauder)
function summonSound(i) {
  const rate = SPAWN_RATES[i];
  crackle({ dur: 0.42, gain: 0.09, from: 260, to: 3600, type: 'bandpass', q: 1.1, attack: 0.7 });
  tone(880 * rate, 0.6, 0.07, 'sine', 0.34);
  tone(880 * rate * 1.5, 0.4, 0.025, 'sine', 0.34);
  tone(880 * rate * 2, 0.28, 0.014, 'sine', 0.36);
}

function breakSound(level) {
  if (!playBuf('shot', 1, 0.5)) tone(660, 0.05, 0.07);
  if (!playBuf('kill', KILL_RATES[level - 1], 0.6)) tone(HIT_NOTES[level - 1]);
  crackle({ dur: 0.12 + level * 0.03, gain: 0.1 + level * 0.05, from: 2600, to: 500 });
  if (level >= 3) thud(80 + level * 6, 34, 0.3 + level * 0.05, 0.22 + level * 0.04);
}

// the collapse: low and wide, not loud (per Rauder: about 30% quieter than
// the first cut, and it has to feel like something big happened). One bright
// crack as the glass gives, then a wind falling in pitch while it swells and
// two subs beating against each other, and at the bottom of the hole a
// boom with a long tail.
function collapseSound() {
  const pull = PULL_MS / 1000;
  crackle({ dur: 0.3, gain: 0.26, from: 4200, to: 700, type: 'bandpass', q: 0.8 });
  crackle({ dur: pull, gain: 0.2, from: 1400, to: 45, type: 'lowpass', q: 0.7, attack: 0.55 });
  thud(60, 17, pull, 0.2, 0, 0.5);
  thud(63.5, 19, pull, 0.14, 0, 0.5);
  thud(52, 24, 1.1, 0.3, pull - 0.06);
  crackle({ dur: 0.6, gain: 0.22, from: 240, to: 40, type: 'lowpass', q: 0.7, delay: pull - 0.06 });
}

function verdictSound() {
  FINAL_CHORD.forEach((f, i) => tone(f, 0.8, 0.13, 'triangle', i * 0.07));
  [1318.5, 1567.98, 2093].forEach((f, i) => tone(f, 0.5, 0.05, 'sine', 0.26 + i * 0.06));
}

// ---------- the canvas: motes, shards, cracks, the glass, the hole ----------

class Scene {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.shards = [];
    this.sparks = [];
    this.waves = [];
    this.motes = [];
    this.cracks = [];
    this.dots = [];
    this.glass = null;
    this.hole = null;
    this.flash = 0;
    this.boost = 0;
    this.onFrame = null;
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
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  stop() {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
  }

  // Wipes the canvas and stops drawing. Called once the verdict is up: there
  // is nothing left to animate, and a stalled frame (the tab throttled by
  // the browser) must never leave the white flash washing over the verdict.
  clear() {
    this.stop();
    try { this.ctx.clearRect(0, 0, this.W, this.H); } catch { /* the canvas is going away anyway */ }
  }

  // eight lights orbiting a core
  addMotes(id, x, y) {
    for (let i = 0; i < 8; i++) {
      this.motes.push({ id, x, y, a: rnd(0, Math.PI * 2), r: rnd(48, 64), v: rnd(0.9, 1.7) * (Math.random() < 0.5 ? -1 : 1), s: rnd(1.2, 2.4), c: Math.random() < 0.7 ? ACCENT_SOFT : CYAN });
    }
  }

  // the core is gone: its motes fly off as sparks
  freeMotes(id) {
    for (const m of this.motes) {
      if (m.id !== id) continue;
      const sp = rnd(220, 460);
      this.sparks.push({ x: m.x + Math.cos(m.a) * m.r, y: m.y + Math.sin(m.a) * m.r, vx: Math.cos(m.a) * sp, vy: Math.sin(m.a) * sp, life: rnd(0.5, 0.9), t: 0, c: m.c, w: 2 });
    }
    this.motes = this.motes.filter((m) => m.id !== id);
  }

  burst(x, y, level) {
    const n = 46 + level * 12;
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(160, 620 + level * 60);
      this.shards.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rnd(60, 220), rot: rnd(0, 6.3), vr: rnd(-9, 9), size: rnd(3, 9 + level), life: rnd(0.7, 1.3), t: 0, c: Math.random() < 0.25 ? '#FFFFFF' : Math.random() < 0.6 ? ACCENT_SOFT : CYAN });
    }
    for (let i = 0; i < 26; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(300, 900);
      this.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.25, 0.6), t: 0, c: Math.random() < 0.5 ? '#FFFFFF' : ACCENT_SOFT, w: 1.6 });
    }
    this.waves.push({ x, y, r: 0, max: 360 + level * 130, t: 0, dur: 0.55 + level * 0.06, c: ACCENT, w: 2.2 });
  }

  // cracks: random walks with branches; the higher the level, the longer they
  // run, and the old cracks spread too
  crack(x, y, level) {
    const now = performance.now();
    const branches = 3 + level;
    const grow = (sx, sy, ang, steps, depth) => {
      const pts = [[sx, sy]];
      let a = ang;
      let px = sx;
      let py = sy;
      for (let i = 0; i < steps; i++) {
        a += rnd(-0.55, 0.55);
        const len = rnd(12, 30);
        px += Math.cos(a) * len;
        py += Math.sin(a) * len;
        pts.push([px, py]);
        if (depth < 2 && i > 1 && Math.random() < 0.28) grow(px, py, a + rnd(-1.4, 1.4) * (Math.random() < 0.5 ? 1 : -1), Math.max(3, Math.round(steps * 0.45)), depth + 1);
      }
      this.cracks.push({ pts, born: now + depth * 90, dur: 220 + level * 50 + depth * 80, w: Math.max(0.6, 1.5 - depth * 0.4) });
    };
    for (let b = 0; b < branches; b++) grow(x, y, (b / branches) * Math.PI * 2 + rnd(-0.4, 0.4), 6 + level * 3 + Math.round(rnd(0, 4)), 0);
    const old = this.cracks.filter((c) => c.born < now - 500);
    for (let i = 0; i < Math.min(3, old.length); i++) {
      const c = old[Math.floor(Math.random() * old.length)];
      const p = c.pts[c.pts.length - 1];
      grow(p[0], p[1], rnd(0, Math.PI * 2), 4 + level * 2, 1);
    }
    for (let i = 0; i < 14 + level * 4; i++) this.dots.push({ x: x + rnd(-40, 40) * level * 0.5, y: y + rnd(-40, 40) * level * 0.5, s: rnd(0.6, 1.8), a: rnd(0.3, 0.9) });
  }

  // the fifth core: the cracked glass becomes pieces that fall into the hole
  shatter() {
    const cell = clamp(Math.max(this.W, this.H) / 11, 90, 150);
    const cols = Math.ceil(this.W / cell) + 1;
    const rows = Math.ceil(this.H / cell) + 1;
    const grid = [];
    for (let r = 0; r <= rows; r++) {
      grid.push([]);
      for (let c = 0; c <= cols; c++) grid[r].push([c * cell + rnd(-cell * 0.3, cell * 0.3), r * cell + rnd(-cell * 0.3, cell * 0.3)]);
    }
    const cx = this.W / 2;
    const cy = this.H / 2;
    const pieces = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const q = [grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]];
        const tris = Math.random() < 0.5 ? [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] : [[q[0], q[1], q[3]], [q[1], q[2], q[3]]];
        for (const t of tris) {
          const mx = (t[0][0] + t[1][0] + t[2][0]) / 3;
          const my = (t[0][1] + t[1][1] + t[2][1]) / 3;
          const dx = cx - mx;
          const dy = cy - my;
          const dist = Math.hypot(dx, dy) || 1;
          pieces.push({ pts: t.map((p) => [p[0] - mx, p[1] - my]), x: mx, y: my, dist, ux: dx / dist, uy: dy / dist, rot: 0, vr: rnd(-3, 3), delay: rnd(0, 0.25) + (1 - dist / Math.hypot(cx, cy)) * 0.15, t: 0, spin: rnd(-1, 1) });
        }
      }
    }
    this.glass = { pieces, t: 0 };
    this.cracks = [];
    this.dots = [];
  }

  openHole() {
    const maxR = clamp(Math.min(this.W, this.H) * 0.17, 60, 170);
    const far = Math.hypot(this.W, this.H) * 0.6;
    const streaks = [];
    for (let i = 0; i < 260; i++) {
      streaks.push({ r: rnd(maxR * 1.3, far), a: rnd(0, Math.PI * 2), vr: rnd(60, 220), va: rnd(0.4, 1.1) * (Math.random() < 0.85 ? 1 : -1), len: rnd(10, 40), c: Math.random() < 0.55 ? ACCENT_SOFT : Math.random() < 0.6 ? CYAN : '#FFFFFF', w: rnd(0.8, 2) });
    }
    this.hole = { t: 0, r: 0, maxR, far, streaks, closing: false, spin: 0 };
  }

  closeHole() {
    if (this.hole) this.hole.closing = true;
  }

  frame(t) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    try {
      this.update(dt, t);
      this.draw(t);
      if (this.onFrame) this.onFrame(dt);
    } catch { /* a drawing hiccup never breaks the page */ }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  update(dt, now) {
    for (const m of this.motes) m.a += m.v * dt;
    for (const s of this.shards) {
      s.t += dt;
      s.vy += 900 * dt;
      s.vx *= 0.985;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.vr * dt;
    }
    this.shards = this.shards.filter((s) => s.t < s.life);
    for (const s of this.sparks) {
      s.t += dt;
      s.vy += 500 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    this.sparks = this.sparks.filter((s) => s.t < s.life);
    for (const w of this.waves) w.t += dt;
    this.waves = this.waves.filter((w) => w.t < w.dur);
    this.flash *= Math.exp(-dt * 5.5);
    this.boost *= Math.exp(-dt * 3);
    if (this.glass) {
      this.glass.t += dt;
      for (const p of this.glass.pieces) {
        if (this.glass.t < p.delay) continue;
        p.t += dt;
        const k = Math.min(1, p.t / 1.25);
        const e = k * k * (3 - 2 * k) * k; // ease-in: it hangs, then it falls in
        const travel = p.dist * e;
        p.cx = p.x + p.ux * travel;
        p.cy = p.y + p.uy * travel;
        p.rot += (p.vr + p.spin * 6 * k) * dt;
        p.scale = 1 - 0.95 * e;
      }
    }
    if (this.hole) {
      const h = this.hole;
      h.t += dt;
      h.spin += dt * (0.6 + h.t * 0.5);
      if (!h.closing) h.r = h.maxR * (1 - Math.exp(-h.t * 3.2));
      else {
        h.r = Math.max(0, h.r - h.maxR * dt * 3.2);
        if (h.r <= 0.5) { this.hole = null; return; }
      }
      const pull = 1 + h.t * 0.9;
      for (const s of h.streaks) {
        s.r -= (s.vr + 26000 / (s.r + 60)) * pull * dt;
        s.a += (s.va + 260 / (s.r + 40)) * dt;
        if (s.r < h.r * 0.5) { s.r = rnd(h.far * 0.6, h.far); s.a = rnd(0, Math.PI * 2); }
      }
    }
  }

  draw(now) {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    // cracks: a soft wide glow under a crisp line, drawn as far as they have grown
    if (this.cracks.length) {
      const glowA = 0.16 + this.boost * 0.5;
      const lineA = 0.85 + this.boost * 0.15;
      for (const pass of [0, 1]) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const c of this.cracks) {
          const p = clamp((now - c.born) / c.dur, 0, 1);
          if (p <= 0) continue;
          ctx.beginPath();
          const total = c.pts.length - 1;
          const upto = p * total;
          ctx.moveTo(c.pts[0][0], c.pts[0][1]);
          let i = 1;
          for (; i <= Math.floor(upto); i++) ctx.lineTo(c.pts[i][0], c.pts[i][1]);
          if (i <= total) {
            const f = upto - Math.floor(upto);
            const a = c.pts[i - 1];
            const b = c.pts[i];
            ctx.lineTo(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
          }
          if (pass === 0) {
            ctx.strokeStyle = `rgba(139, 124, 255, ${glowA})`;
            ctx.lineWidth = c.w * 3.2;
          } else {
            ctx.strokeStyle = this.boost > 0.2 ? `rgba(255, 255, 255, ${lineA})` : `rgba(226, 232, 255, ${lineA})`;
            ctx.lineWidth = c.w;
          }
          ctx.stroke();
        }
      }
      for (const d of this.dots) {
        ctx.fillStyle = `rgba(255, 255, 255, ${d.a})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.s, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // the glass, on its way into the hole
    if (this.glass) {
      for (const p of this.glass.pieces) {
        if (this.glass.t < p.delay) {
          ctx.save();
          ctx.translate(p.x, p.y);
        } else {
          if (p.scale <= 0.06) continue;
          ctx.save();
          ctx.translate(p.cx, p.cy);
          ctx.rotate(p.rot);
          ctx.scale(p.scale, p.scale);
        }
        ctx.beginPath();
        ctx.moveTo(p.pts[0][0], p.pts[0][1]);
        ctx.lineTo(p.pts[1][0], p.pts[1][1]);
        ctx.lineTo(p.pts[2][0], p.pts[2][1]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(11, 13, 18, 0.6)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(207, 201, 255, 0.55)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.restore();
      }
    }

    // shockwaves
    for (const w of this.waves) {
      const k = w.t / w.dur;
      const e = 1 - (1 - k) * (1 - k);
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.max * e, 0, Math.PI * 2);
      ctx.strokeStyle = w.c;
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.lineWidth = w.w * (1 - k * 0.6);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // shards and sparks
    for (const s of this.shards) {
      const k = 1 - s.t / s.life;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.fillStyle = s.c;
      ctx.beginPath();
      ctx.moveTo(-s.size * 0.6, -s.size * 0.4);
      ctx.lineTo(s.size * 0.7, -s.size * 0.1);
      ctx.lineTo(0, s.size * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.lineCap = 'round';
    for (const s of this.sparks) {
      const k = 1 - s.t / s.life;
      ctx.strokeStyle = s.c;
      ctx.globalAlpha = k;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // motes around the cores
    for (const m of this.motes) {
      const x = m.x + Math.cos(m.a) * m.r;
      const y = m.y + Math.sin(m.a) * m.r;
      ctx.fillStyle = m.c;
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(now / 180 + m.a * 3);
      ctx.beginPath();
      ctx.arc(x, y, m.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (this.hole) this.drawHole();

    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, this.flash)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  drawHole() {
    const { ctx, W, H } = this;
    const h = this.hole;
    const cx = W / 2;
    const cy = H / 2;
    const r = h.r;
    if (r < 1) return;
    // light falling in: streaks that curve tighter the closer they get
    ctx.lineCap = 'round';
    for (const s of h.streaks) {
      const k = clamp(1 - (s.r - r) / (h.far - r), 0.05, 1);
      const x1 = cx + Math.cos(s.a) * s.r;
      const y1 = cy + Math.sin(s.a) * s.r;
      const a2 = s.a - (0.25 + k * 0.9) * (s.va > 0 ? 1 : -1) * (s.len / Math.max(30, s.r));
      const r2 = s.r + s.len * (0.6 + k);
      ctx.strokeStyle = s.c;
      ctx.globalAlpha = 0.12 + k * 0.8;
      ctx.lineWidth = s.w * (0.6 + k);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(cx + Math.cos(a2) * r2, cy + Math.sin(a2) * r2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // the accretion disk: a tilted ring of light, spinning
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.35);
    ctx.scale(1, 0.34);
    const disk = ctx.createRadialGradient(0, 0, r * 1.05, 0, 0, r * 2.2);
    disk.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    disk.addColorStop(0.18, 'rgba(207, 201, 255, 0.75)');
    disk.addColorStop(0.45, 'rgba(139, 124, 255, 0.35)');
    disk.addColorStop(1, 'rgba(79, 195, 255, 0)');
    ctx.fillStyle = disk;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(h.spin);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([r * 0.5, r * 0.9]);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    // the lensing halo and the hole itself
    const halo = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.9);
    halo.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    halo.addColorStop(0.25, 'rgba(139, 124, 255, 0.35)');
    halo.addColorStop(1, 'rgba(139, 124, 255, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.01, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------- the ceremony ----------

const RAIL = (cls) => `<svg class="rail ${cls}" viewBox="0 0 1000 8" preserveAspectRatio="none" aria-hidden="true"><line class="glow" x1="0" y1="4" x2="1000" y2="4"/><line class="base" x1="0" y1="4" x2="1000" y2="4"/><rect class="cap" x="0" y="2.5" width="46" height="3"/><rect class="cap" x="954" y="2.5" width="46" height="3"/><line class="run" x1="0" y1="4" x2="1000" y2="4"/></svg>`;
const HALO = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-width=".35" stroke-dasharray="1 2.6"/><circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="0.4 7.2" stroke-opacity=".8"/><g fill="currentColor" fill-opacity=".8"><rect x="48.9" y="1" width="2.2" height="2.2" transform="rotate(45 50 2.1)"/><rect x="48.9" y="96.8" width="2.2" height="2.2" transform="rotate(45 50 97.9)"/><rect x="1" y="48.9" width="2.2" height="2.2" transform="rotate(45 2.1 50)"/><rect x="96.8" y="48.9" width="2.2" height="2.2" transform="rotate(45 97.9 50)"/></g></svg>`;

// opts: { runs, streak, weekLabel } for the verdict window; test = a preview
export function startCelebration(opts = {}) {
  if (document.querySelector('.cel')) return;
  loadSounds(); // decoding the three small ogg files finishes before the first core

  const page = document.getElementById('page');
  const overlay = el('div', 'cel');
  const dim = el('div', 'cel-dim');
  const canvas = el('canvas', 'cel-fx');
  const stage = el('div', 'cel-stage');
  const glitch = el('div', 'cel-glitch');
  for (let i = 0; i < 4; i++) glitch.append(el('i'));
  const hint = el('div', 'cel-hint');
  const skip = el('button', 'cel-skip', '[ skip ]');
  skip.type = 'button';
  stage.append(hint);
  overlay.append(dim, canvas, stage, glitch, skip);

  const timers = [];
  let done = false;
  let scene = null;
  let shake = null;
  const later = (fn, ms) => timers.push(setTimeout(() => { if (!done) fn(); }, ms));
  const teardown = () => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    if (scene) scene.stop();
    overlay.remove();
    if (page) {
      page.classList.remove('cel-vortex', 'cel-return');
      page.style.transform = '';
      page.style.transformOrigin = '';
    }
  };
  skip.addEventListener('click', teardown);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('on'));

  const W = () => window.innerWidth;
  const H = () => window.innerHeight;

  // ---- the verdict window ----
  const verdict = () => {
    if (scene) {
      scene.flash = 0.9;
      scene.waves.push({ x: W() / 2, y: H() / 2, r: 0, max: Math.max(W(), H()), t: 0, dur: 0.9, c: '#FFFFFF', w: 3 });
    }
    overlay.classList.remove('void', 'black');
    overlay.classList.add('verdict');
    if (page) {
      page.classList.remove('cel-vortex');
      page.classList.add('cel-return');
      later(() => { page.classList.remove('cel-return'); page.style.transformOrigin = ''; }, 900);
    }
    stage.replaceChildren();
    const wrap = el('div', 'cel-verdict-wrap');
    const v = el('div', 'cel-verdict');
    v.innerHTML = RAIL('t') + RAIL('b');
    const halo = el('div', 'cel-halo');
    halo.innerHTML = HALO;
    v.append(halo);
    const head = el('div', 'nh');
    head.append(el('span', 'ic', '!'), el('span', 'ttl', 'Daily Quest'));
    v.append(head);
    const pct = el('div', 'cel-pct', '100%');
    v.append(pct);
    const lines = el('div', 'cel-lines');
    const runs = opts.runs ? `${opts.runs} runs` : 'every run';
    const streakN = typeof opts.streak === 'function' ? opts.streak() : opts.streak;
    const streak = streakN && streakN > 0 ? `${streakN} ${streakN === 1 ? 'day' : 'days'}` : null;
    // a day closed while the site was shut is named: the person is looking at
    // an empty today and has to know which day the System is closing
    const day = opts.past && opts.date ? new Date(opts.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
    const texts = [
      day
        ? `[ Daily Quest for <b>${day}</b>: <b>cleared</b>${opts.night ? ' in the night' : ' with the tab shut'}. ${runs} of the playlist in the books, counted toward that day. ]`
        : `[ Daily Quest: <b>cleared</b>. ${runs} of ${opts.weekLabel ? opts.weekLabel + "'s playlist" : 'the playlist'} in the books, checked in automatically. ]`,
      streak ? `[ Streak: <b>${streak}</b>. The chain holds. ]` : null,
      `[ Reward: <b>+1 day</b> to this month's record. ]`,
      '[ The System took note. Come back tomorrow. ]',
    ].filter(Boolean);
    texts.forEach((t, i) => {
      const p = el('p', 'n-line' + (t.includes('Reward') ? ' gold' : ''));
      p.innerHTML = t;
      p.style.animationDelay = `${520 + i * 240}ms`;
      lines.append(p);
    });
    v.append(lines);
    const btn = el('button', 'btn cel-continue', 'Continue');
    btn.type = 'button';
    btn.addEventListener('click', teardown);
    v.append(btn);
    wrap.append(v);
    stage.append(wrap);
    verdictSound();

    // the number decodes into place: glyphs settle left to right
    const target = '100%';
    if (reducedMotion()) pct.textContent = target;
    else {
      const glyphs = '0123456789#$&';
      let t0 = null;
      const step = (ts) => {
        if (done || pct.dataset.done) return;
        if (t0 === null) t0 = ts;
        const p = Math.min(1, (ts - t0) / 820);
        const settled = Math.floor(p * (target.length + 0.99));
        let s = target.slice(0, settled);
        for (let i = settled; i < target.length; i++) s += glyphs[Math.floor(Math.random() * glyphs.length)];
        pct.textContent = s;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      // rAF can stall (hidden window, game overlay): the verdict still lands
      later(() => { pct.dataset.done = '1'; pct.textContent = target; }, 950);
    }
    // the flash has burned off by now; drop the canvas so a throttled frame
    // cannot leave it washing over the verdict
    later(() => { if (scene) scene.clear(); }, 1200);
    later(teardown, 16000);
  };

  // respect reduced motion: no cores, no hole, straight to the verdict
  if (reducedMotion()) {
    later(verdict, 500);
    return;
  }

  scene = new Scene(canvas);
  scene.onFrame = (dt) => {
    if (!shake) return;
    shake.t += dt;
    if (shake.t >= shake.dur) {
      shake = null;
      if (page) page.style.transform = '';
      stage.style.transform = '';
      return;
    }
    const k = shake.amp * (1 - shake.t / shake.dur) ** 2;
    const tf = `translate3d(${((Math.random() * 2 - 1) * k).toFixed(1)}px, ${((Math.random() * 2 - 1) * k).toFixed(1)}px, 0)`;
    if (page) page.style.transform = tf;
    stage.style.transform = tf;
  };
  const kick = (level) => { shake = { amp: 4 + level * 3, dur: 0.38 + level * 0.07, t: 0 }; };
  const glitchFlash = (level) => {
    for (const i of glitch.children) {
      i.style.top = `${rnd(0, 92)}%`;
      i.style.height = `${rnd(2, 5 + level)}%`;
      i.style.transform = `translateX(${rnd(-14, 14).toFixed(0)}px)`;
    }
    glitch.classList.add('on');
    later(() => glitch.classList.remove('on'), 110 + level * 25);
  };

  // ---- the cores ----
  const R = clamp(Math.min(W(), H()) * 0.3, 130, 290);
  const cores = [];
  let left = CORES;
  for (let i = 0; i < CORES; i++) {
    const ang = (-90 + i * (360 / CORES)) * Math.PI / 180;
    const x = Math.round(W() / 2 + Math.cos(ang) * R);
    const y = Math.round(H() / 2 + Math.sin(ang) * R);
    const core = el('button', 'cel-core');
    core.type = 'button';
    core.setAttribute('aria-label', 'mana core');
    core.style.left = `${x}px`;
    core.style.top = `${y}px`;
    core.addEventListener('click', () => breakCore(i));
    stage.append(core);
    cores.push({ core, x, y });
  }

  const collapse = () => {
    shake = null;
    if (page) page.style.transform = '';
    stage.style.transform = '';
    scene.flash = 1;
    scene.boost = 1;
    collapseSound();
    later(() => {
      scene.shatter();
      scene.openHole();
      overlay.classList.add('void');
      if (page) {
        page.style.transformOrigin = `${window.scrollX + W() / 2}px ${window.scrollY + H() / 2}px`;
        page.classList.add('cel-vortex');
      }
    }, 140);
    later(() => { overlay.classList.add('black'); scene.closeHole(); }, 200 + PULL_MS);
    later(verdict, 700 + PULL_MS);
  };

  const breakCore = (i) => {
    const { core, x, y } = cores[i];
    if (!core.classList.contains('spawned') || core.classList.contains('hit')) return;
    core.classList.add('hit');
    const level = CORES - left + 1;
    left--;
    scene.freeMotes(i);
    scene.burst(x, y, level);
    scene.crack(x, y, level);
    kick(level);
    glitchFlash(level);
    breakSound(level);
    if (left > 0) hint.textContent = `[ ${left} ${left === 1 ? 'core remains' : 'cores remain'} ]`;
    else {
      hint.classList.add('gone');
      later(collapse, 420);
    }
  };

  // dim for ~0.8 s, then the cores one by one: a beam of light, the core drops in
  cores.forEach(({ core, x, y }, i) => {
    later(() => {
      const beam = el('i', 'cel-beam');
      beam.style.left = `${x}px`;
      stage.append(beam);
      later(() => beam.remove(), 650);
      core.classList.add('spawned');
      scene.addMotes(i, x, y);
      scene.waves.push({ x, y, r: 0, max: 90, t: 0, dur: 0.45, c: ACCENT_SOFT, w: 1.2 });
      summonSound(i);
      if (i === CORES - 1) {
        hint.textContent = '[ Five cores. Break them. ]';
        hint.classList.add('shown');
      }
    }, 800 + i * 230);
  });
}
