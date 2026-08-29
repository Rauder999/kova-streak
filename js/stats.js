// Personal stats: per-scenario baselines, deltas for the current day,
// diagnosis codes per niche (clicking / tracking / switching).
//
// Core principle (hard-earned in AimSama and locked in by Rauder's feedback):
// NOT A SINGLE absolute judgment. Every metric is compared only against the
// player's own baseline on the same scenario. TTK spread by itself means
// nothing (spawn geometry!), "chokes" are counted as a tail against the
// same scenario's own norm.

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const pickNum = (runs, f) => runs.map(f).filter((v) => v != null && !Number.isNaN(v));

const MIN_BASELINE_RUNS = 4;

// Scenario baseline: medians over history (excluding today)
export function scenarioBaseline(historyRuns) {
  if (historyRuns.length < MIN_BASELINE_RUNS) return null;
  return {
    runs: historyRuns.length,
    score: median(pickNum(historyRuns, (r) => r.score)),
    accuracy: median(pickNum(historyRuns, (r) => r.accuracy)),
    ttkMed: median(pickNum(historyRuns, (r) => r.ttkMed)),
    ttkTail: median(pickNum(historyRuns, (r) => r.ttkTail)),
    accDrop: median(pickNum(historyRuns, (r) => r.accDrop)),
  };
}

// Scenario family. The name decides where the data is blind: pokeball (static
// orbs, held-down M1) and dynamic (moving targets to click: pasu without
// track/smooth in the name, 3-click and the like) look identical in the CSV
// to tracking and statics, yet they need fundamentally different advice.
function scenarioKind(name, runs) {
  if (/pokeball/i.test(name)) return 'pokeball';
  if (/\b\d[- ]?click\b|dynamic/i.test(name)) return 'dynamic';
  if (/pasu/i.test(name) && !/track|smooth/i.test(name)) return 'dynamic';
  const counts = {};
  for (const r of runs) counts[r.type] = (counts[r.type] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top && top[0] !== 'unknown' ? top[0] : null;
}

// Niche for verdict grouping: pokeballs live under tracking, dynamic under
// clicking (families of assisting skills per 4BK), but their KIND remains
// their own and determines the advice.
function scenarioNiche(name, runs) {
  const kind = scenarioKind(name, runs);
  if (kind === 'pokeball') return 'tracking';
  if (kind === 'dynamic') return 'clicking';
  return kind;
}

// Daily report: for each scenario played on the chosen date, deltas against
// the baseline (only runs BEFORE that date); aggregation into niches; codes.
// Works for any past day, not just today.
export function buildDailyReport(allRuns, today) {
  const byScenario = new Map();
  for (const r of allRuns) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario).push(r);
  }
  const playedNames = new Set(allRuns.filter((r) => r.date === today).map((r) => r.scenario));

  // rust: days from the previous session to today's
  const dates = [...new Set(allRuns.map((r) => r.date))].sort();
  const prevDate = dates.filter((d) => d < today).pop() || null;
  const gapDays = prevDate ? Math.round((new Date(today) - new Date(prevDate)) / 86400000) : null;

  const scenarios = [];
  for (const name of playedNames) {
    const runs = (byScenario.get(name) || []).sort((a, b) => a.dateTime.localeCompare(b.dateTime));
    const todayRuns = runs.filter((r) => r.date === today);
    const history = runs.filter((r) => r.date < today);
    if (!todayRuns.length) continue;
    const base = scenarioBaseline(history);
    const niche = scenarioNiche(name, runs);
    const kind = scenarioKind(name, runs);
    const bestToday = Math.max(...pickNum(todayRuns, (r) => r.score));
    const accToday = median(pickNum(todayRuns, (r) => r.accuracy));
    const ttkToday = median(pickNum(todayRuns, (r) => r.ttkMed));
    const tailToday = median(pickNum(todayRuns, (r) => r.ttkTail));
    const dropToday = median(pickNum(todayRuns, (r) => r.accDrop));
    // best "as of that moment": no peeking at the future relative to the chosen day
    const allTimeBest = Math.max(...pickNum(runs.filter((r) => r.date <= today), (r) => r.score));
    scenarios.push({
      name,
      niche,
      kind,
      runsToday: todayRuns.length,
      bestToday: Number.isFinite(bestToday) ? bestToday : null,
      accToday,
      base,
      isPB: Number.isFinite(bestToday) && bestToday >= allTimeBest && history.length > 0,
      scoreDelta: base && base.score ? (bestToday - base.score) / base.score : null,
      accDelta: base && base.accuracy != null && accToday != null ? accToday - base.accuracy : null,
      ttkRatio: base && base.ttkMed && ttkToday ? ttkToday / base.ttkMed : null,
      tailDelta: base && tailToday != null ? tailToday - (base.ttkTail || 0) : null,
      tailToday,
      dropToday,
    });
  }

  // ---------- diagnosis codes per niche ----------
  const niches = {};
  for (const s of scenarios) {
    if (!s.niche || s.niche === 'unknown') continue;
    if (!niches[s.niche]) niches[s.niche] = { niche: s.niche, scenarios: [], codes: new Set() };
    niches[s.niche].scenarios.push(s);
  }

  for (const n of Object.values(niches)) {
    const withBase = n.scenarios.filter((s) => s.base);
    const scoreDeltas = pickNum(withBase, (s) => s.scoreDelta);
    const accDeltas = pickNum(withBase, (s) => s.accDelta);
    n.scoreDelta = median(scoreDeltas);
    n.accDelta = median(accDeltas);
    n.worst = [...withBase].sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0))[0] || null;
    n.best = [...withBase].sort((a, b) => (b.scoreDelta ?? 0) - (a.scoreDelta ?? 0))[0] || null;

    // HONESTY (per Rauder's feedback): the CSV cannot see the hand in
    // tracking (invincible and regen bots, different accuracy semantics),
    // any "diagnoses" from it would be guesswork. No tracking analysis:
    // the coach gives a general 4BK-doctrine task, scores stay in the table only.
    if (n.niche === 'tracking') {
      n.codes = ['NO_MEASURE'];
      n.aspects = null;
      n.pbs = n.scenarios.filter((s) => s.isPB).map((s) => s.name);
      continue;
    }

    if (n.niche === 'clicking') {
      // pacing codes only on pure statics: on dynamic a long kill is often
      // proper technique (tracking before the click), not overconfirming
      const statics = withBase.filter((s) => s.kind === 'clicking');
      // firing faster than usual and hitting worse = hail-mary clicking
      if (n.accDelta != null && n.accDelta <= -0.05 && statics.some((s) => s.ttkRatio != null && s.ttkRatio <= 1.05)) n.codes.add('SPAM');
      // slower than usual while holding one's accuracy = overconfirming
      if (statics.some((s) => s.ttkRatio != null && s.ttkRatio >= 1.15 && (s.accDelta ?? 0) >= -0.01)) n.codes.add('HESITATE');
    }
    // chokes: the tail of long kills is noticeably above its own norm
    if (withBase.some((s) => s.tailToday != null && s.tailToday > Math.max(0.08, ((s.base && s.base.ttkTail) || 0) * 1.5))) n.codes.add('CHOKES');
    // accuracy steadily fades by the end of runs = tensing up
    const drops = pickNum(n.scenarios, (s) => s.dropToday);
    if (drops.length >= 2 && median(drops) <= -0.06) n.codes.add('FATIGUE');
    if (n.scoreDelta != null && n.scoreDelta <= -0.03) n.codes.add('SOFT');
    if (n.scoreDelta != null && n.scoreDelta >= 0.03) n.codes.add('STRONG');
    if (!n.codes.size) n.codes.add('OK');
    n.codes = [...n.codes].sort();

    // niche aspects vs their own norm: even on a green day the coach must
    // have material for the next assignment
    n.aspects = {
      accDeltaPp: n.accDelta != null ? Math.round(n.accDelta * 100) : null,
      paceRatio: (() => { const v = pickNum(withBase, (s) => s.ttkRatio); return v.length ? Math.round(median(v) * 100) / 100 : null; })(),
      chokeExcessPp: (() => {
        const v = withBase.map((s) => (s.tailToday != null ? s.tailToday - ((s.base && s.base.ttkTail) || 0) : null)).filter((x) => x != null);
        return v.length ? Math.round(Math.max(...v) * 100) : null;
      })(),
      fadePp: (() => { const v = pickNum(n.scenarios, (s) => s.dropToday); return v.length ? Math.round(median(v) * 100) : null; })(),
    };
    n.pbs = n.scenarios.filter((s) => s.isPB).map((s) => s.name);
  }

  // niche ordering: measured ones by how problematic they are, tracking always
  // last (it has no honest numbers to claim the "worst" spot)
  const measured = Object.values(niches).filter((n) => n.niche !== 'tracking')
    .sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0));
  const trackingNiche = Object.values(niches).find((n) => n.niche === 'tracking');
  const order = trackingNiche ? [...measured, trackingNiche] : measured;

  const report = {
    today,
    gapDays,
    rusty: gapDays != null && gapDays >= 3,
    scenarios: scenarios.sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0)),
    niches: order,
    pbs: scenarios.filter((s) => s.isPB).map((s) => s.name),
  };
  report.stateHash = hashReport(report);
  return report;
}

// State hash: codes + deltas coarsened to 5%. While the hash stays the same,
// no new coach text is generated, the answer comes from the cache.
function hashReport(report) {
  const bucket = (v) => (v == null ? 'x' : Math.round(v * 20));
  const src = report.niches.map((n) => n.niche === 'tracking'
    ? `tracking:${n.scenarios.map((s) => s.name).sort().join(',')}`
    : `${n.niche}:${n.codes.join('+')}:${bucket(n.scoreDelta)}:${bucket(n.accDelta)}:${n.worst ? n.worst.name : ''}:${n.aspects ? [n.aspects.paceRatio, n.aspects.chokeExcessPp, n.aspects.fadePp].join(',') : ''}`
  ).join('|') + (report.rusty ? `|rust${report.gapDays}` : '');
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + src.length;
}

// Doctrine cues for tracking. Rotation is deterministic by day number:
// adjacent days are guaranteed to get different cues, and no model
// forgetfulness can break that.
export const TRACKING_CUES = [
  'stay smooth through the strafe and react only at the instant of a direction change',
  'track where the target is going, not where it was a moment ago',
  'glue the crosshair to one body part and keep it there, no drifting inside the bot',
  'steer the wide movements with the arm, not the wrist',
  'aim at the center of the target the whole run, never the edges',
  'spend the first seconds reading the pattern before committing to it',
  'match the target speed instead of correcting after it moves away',
  'after the twitchiest scenario, play one easy smooth scenario to calm the aim down',
];

export function trackingCueForDay(date) {
  return TRACKING_CUES[Number(date.slice(-2)) % TRACKING_CUES.length];
}

// The tracking line is assembled on the client, without the model: no data
// there, the cue is doctrinal, rotation by day, anchored to a played scenario.
// The model swapped out the given cue twice, determinism is more reliable.
export function buildTrackingLine(report) {
  const t = report.niches.find((n) => n.niche === 'tracking');
  if (!t || !t.scenarios.length) return null;
  const nonPoke = t.scenarios.filter((s) => s.kind !== 'pokeball');
  const pool = nonPoke.length ? nonPoke : t.scenarios;
  const day = Number(report.today.slice(-2));
  const scen = pool[day % pool.length];
  const short = scen.name
    .replace(/4BK\s*-\s*/i, '')
    .replace(/\s*\(?Accuracy Edit\)?/i, '')
    .replace(/\bVoltaic\b\s*/i, '')
    .trim();
  const cue = trackingCueForDay(report.today);
  return `[TRACKING] On ${short}, ${cue}.`;
}

// Compact payload for the coach worker
export function coachPayload(report) {
  const pct = (v) => (v == null ? null : Math.round(v * 100));
  return {
    stateHash: report.stateHash,
    rustyDays: report.rusty ? report.gapDays : null,
    niches: report.niches.map((n) => n.niche === 'tracking'
      ? {
          // tracking without a diagnosis: just what was played, for the general assignment
          niche: 'tracking',
          codes: n.codes,
          runsToday: n.scenarios.reduce((a, s) => a + s.runsToday, 0),
          playedScenarios: n.scenarios.slice(0, 5).map((s) => ({ name: s.name, kind: s.kind })),
        }
      : {
          niche: n.niche,
          codes: n.codes,
          scoreDeltaPct: pct(n.scoreDelta),
          accDeltaPp: pct(n.accDelta),
          worstScenario: n.worst ? { name: n.worst.name, kind: n.worst.kind, accPct: pct(n.worst.accToday) } : null,
          worstScenarioDeltaPct: n.worst ? pct(n.worst.scoreDelta) : null,
          bestScenario: n.best ? { name: n.best.name, kind: n.best.kind } : null,
          aspects: n.aspects || null,
          pbs: (n.scenarios || []).filter((s) => s.isPB).map((s) => ({ name: s.name, kind: s.kind })),
          runsToday: n.scenarios.reduce((a, s) => a + s.runsToday, 0),
        }),
  };
}
