// Личная статистика: бейзлайны по сценарию, дельты сегодняшнего дня,
// диагноз-коды по нишам (clicking / tracking / switching).
//
// Главный принцип (выстрадан в AimSama и закреплен фидбеком Rauder):
// НИ ОДНОЙ абсолютной оценки. Каждая метрика сравнивается только с
// собственным бейзлайном игрока на том же сценарии. Разброс TTK сам по
// себе не значит ничего (геометрия спавнов!), "чоки" считаются как хвост
// против своей же нормы этого сценария.

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const pickNum = (runs, f) => runs.map(f).filter((v) => v != null && !Number.isNaN(v));

const MIN_BASELINE_RUNS = 4;

// Бейзлайн сценария: медианы по истории (без сегодняшнего дня)
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

// Семейство сценария. Имя решает там, где данные слепы: покебол (статичные
// шары, зажатый М1) и динамик (движущиеся цели под клик: pasu без track/smooth
// в имени, 3-click и т.п.) по CSV неотличимы от трекинга и статика, а советы
// им нужны принципиально другие.
function scenarioKind(name, runs) {
  if (/pokeball/i.test(name)) return 'pokeball';
  if (/\b\d[- ]?click\b|dynamic/i.test(name)) return 'dynamic';
  if (/pasu/i.test(name) && !/track|smooth/i.test(name)) return 'dynamic';
  const counts = {};
  for (const r of runs) counts[r.type] = (counts[r.type] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top && top[0] !== 'unknown' ? top[0] : null;
}

// Ниша для группировки вердикта: покеболы живут в трекинге, динамик в
// кликинге (семейства ассистирующих скиллов по 4BK), но их KIND остается
// своим и определяет советы.
function scenarioNiche(name, runs) {
  const kind = scenarioKind(name, runs);
  if (kind === 'pokeball') return 'tracking';
  if (kind === 'dynamic') return 'clicking';
  return kind;
}

// Отчет дня: по каждому сценарию, сыгранному в выбранную дату, дельты
// против бейзлайна (только раны ДО этой даты); агрегация в ниши; коды.
// Работает для любого прошедшего дня, не только сегодняшнего.
export function buildDailyReport(allRuns, today) {
  const byScenario = new Map();
  for (const r of allRuns) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario).push(r);
  }
  const playedNames = new Set(allRuns.filter((r) => r.date === today).map((r) => r.scenario));

  // ржавчина: дней с прошлой сессии до сегодняшней
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
    // рекорд "на тот момент": будущее относительно выбранного дня не подглядываем
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

  // ---------- коды диагнозов по нишам ----------
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

    // ЧЕСТНОСТЬ (фидбек Rauder): CSV не видит руку в трекинге (инвинсибл и
    // реген-боты, разная семантика точности), любые "диагнозы" оттуда были
    // бы гаданием. Трекинг не анализируем: коуч дает общее задание по
    // доктрине 4BK, скоры остаются только в таблице.
    if (n.niche === 'tracking') {
      n.codes = ['NO_MEASURE'];
      n.aspects = null;
      n.pbs = n.scenarios.filter((s) => s.isPB).map((s) => s.name);
      continue;
    }

    if (n.niche === 'clicking') {
      // темповые коды только по чистым статикам: на динамике долгий килл
      // это часто правильная техника (трек перед кликом), а не пересиживание
      const statics = withBase.filter((s) => s.kind === 'clicking');
      // стреляет быстрее обычного и попадает хуже = клики на авось
      if (n.accDelta != null && n.accDelta <= -0.05 && statics.some((s) => s.ttkRatio != null && s.ttkRatio <= 1.05)) n.codes.add('SPAM');
      // медленнее обычного при своей же точности = пересиживание
      if (statics.some((s) => s.ttkRatio != null && s.ttkRatio >= 1.15 && (s.accDelta ?? 0) >= -0.01)) n.codes.add('HESITATE');
    }
    // чоки: хвост длинных киллов заметно выше своей нормы
    if (withBase.some((s) => s.tailToday != null && s.tailToday > Math.max(0.08, ((s.base && s.base.ttkTail) || 0) * 1.5))) n.codes.add('CHOKES');
    // к концу ранов точность стабильно проседает = зажим
    const drops = pickNum(n.scenarios, (s) => s.dropToday);
    if (drops.length >= 2 && median(drops) <= -0.06) n.codes.add('FATIGUE');
    if (n.scoreDelta != null && n.scoreDelta <= -0.03) n.codes.add('SOFT');
    if (n.scoreDelta != null && n.scoreDelta >= 0.03) n.codes.add('STRONG');
    if (!n.codes.size) n.codes.add('OK');
    n.codes = [...n.codes].sort();

    // аспекты ниши против своей нормы: даже в зеленый день у тренера
    // должен быть материал для следующего задания
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

  // сортировка ниш: измеренные по проблемности, трекинг всегда последним
  // (у него нет честных чисел, чтобы претендовать на "худший")
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

// Хэш состояния: коды + дельты, огрубленные до 5%. Пока хэш не меняется,
// новый текст коуча не генерируется, ответ берется из кэша.
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

// Доктринные подсказки трекинга. Ротация детерминирована по номеру дня:
// соседние дни гарантированно получают разные подсказки, и никакая
// забывчивость модели этого не сломает.
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

// Трекинг-строка собирается на клиенте, без модели: данных там нет,
// подсказка доктринная, ротация по дню, якорь на сыгранном сценарии.
// Модель дважды подменяла выданную подсказку, детерминизм надежнее.
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

// Компактный пейлоад для воркера-коуча
export function coachPayload(report) {
  const pct = (v) => (v == null ? null : Math.round(v * 100));
  return {
    stateHash: report.stateHash,
    rustyDays: report.rusty ? report.gapDays : null,
    niches: report.niches.map((n) => n.niche === 'tracking'
      ? {
          // трекинг без диагноза: только что игралось, для общего задания
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
